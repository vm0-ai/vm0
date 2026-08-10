import type { ConnectorSlug } from "@vm0/api-contracts/contracts/connector-identity";
import type { ConnectorChangedPayload } from "@vm0/api-contracts/contracts/realtime";

import { logger } from "../../lib/log";
import type { ClerkOrganizationsApi } from "../external/clerk";
import { listAllOrganizationMemberships } from "../external/clerk-organization-lists";
import { publishUserSignal } from "../external/realtime";
import { settleIncludingAbort } from "../utils";

const L = logger("ConnectorClientInvalidation");

interface UserAudience {
  readonly kind: "user";
  readonly userId: string;
}

interface OrganizationAudience {
  readonly kind: "organization";
  readonly orgId: string;
  readonly organizations: Pick<
    ClerkOrganizationsApi,
    "getOrganizationMembershipList"
  >;
}

type ConnectorClientInvalidation =
  | {
      readonly kind: "builtin";
      readonly audience: UserAudience;
      readonly connectorSlug: ConnectorSlug;
    }
  | {
      readonly kind: "custom";
      readonly audience: UserAudience | OrganizationAudience;
    };

export interface CapturedConnectorClientInvalidationAbort {
  readonly reason: unknown;
}

function invalidationLogFields(
  invalidation: ConnectorClientInvalidation,
): Readonly<Record<string, unknown>> {
  return {
    kind: invalidation.kind,
    audience: invalidation.audience.kind,
    ...(invalidation.audience.kind === "organization"
      ? { orgId: invalidation.audience.orgId }
      : { userId: invalidation.audience.userId }),
    ...(invalidation.kind === "builtin"
      ? { connectorSlug: invalidation.connectorSlug }
      : {}),
  };
}

async function resolveInvalidationUserIds(
  invalidation: ConnectorClientInvalidation,
): Promise<readonly string[]> {
  if (invalidation.audience.kind === "user") {
    return [invalidation.audience.userId];
  }

  const memberships = await settleIncludingAbort(
    listAllOrganizationMemberships(
      invalidation.audience.organizations,
      invalidation.audience.orgId,
    ),
  );
  if (!memberships.ok) {
    L.warn("Failed to resolve connector client invalidation audience", {
      ...invalidationLogFields(invalidation),
      error: memberships.error,
    });
    return [];
  }

  const userIds = new Set<string>();
  let unidentifiedMembershipCount = 0;
  for (const membership of memberships.value) {
    const userId = membership.publicUserData?.userId;
    if (userId) {
      userIds.add(userId);
    } else {
      unidentifiedMembershipCount++;
    }
  }
  if (unidentifiedMembershipCount > 0) {
    L.warn("Skipped unidentified connector client invalidation members", {
      ...invalidationLogFields(invalidation),
      unidentifiedMembershipCount,
    });
  }
  return [...userIds];
}

async function publishInvalidationForUser(
  invalidation: ConnectorClientInvalidation,
  userId: string,
): Promise<void> {
  const publication =
    invalidation.kind === "builtin"
      ? publishUserSignal([userId], "connector:changed", {
          connectorSlug: invalidation.connectorSlug,
        } satisfies ConnectorChangedPayload)
      : publishUserSignal([userId], "customConnectorListChanged");
  const outcome = await settleIncludingAbort(publication);
  if (!outcome.ok) {
    L.warn("Failed to publish connector client invalidation", {
      ...invalidationLogFields(invalidation),
      recipientUserId: userId,
      error: outcome.error,
    });
  }
}

function captureAbort(
  captured: CapturedConnectorClientInvalidationAbort | undefined,
  signal: AbortSignal,
): CapturedConnectorClientInvalidationAbort | undefined {
  return captured ?? (signal.aborted ? { reason: signal.reason } : undefined);
}

/**
 * Attempts browser cache invalidation after an authoritative connector mutation
 * commits, then surfaces any request abort observed across that boundary.
 */
async function publishConnectorClientInvalidationAfterCommit(
  invalidation: ConnectorClientInvalidation,
  signal: AbortSignal,
  previouslyCapturedAbort?: CapturedConnectorClientInvalidationAbort,
): Promise<void> {
  let capturedAbort = captureAbort(previouslyCapturedAbort, signal);
  const userIds = await resolveInvalidationUserIds(invalidation);
  await Promise.all(
    userIds.map(async (userId) => {
      await publishInvalidationForUser(invalidation, userId);
    }),
  );
  capturedAbort = captureAbort(capturedAbort, signal);
  if (capturedAbort) {
    throw capturedAbort.reason;
  }
}

export async function publishBuiltinConnectorInvalidationAfterCommit(
  args: {
    readonly userId: string;
    readonly connectorSlug: ConnectorSlug;
    readonly previouslyCapturedAbort?: CapturedConnectorClientInvalidationAbort;
  },
  signal: AbortSignal,
): Promise<void> {
  await publishConnectorClientInvalidationAfterCommit(
    {
      kind: "builtin",
      audience: { kind: "user", userId: args.userId },
      connectorSlug: args.connectorSlug,
    },
    signal,
    args.previouslyCapturedAbort,
  );
}

export async function publishCustomConnectorUserInvalidationAfterCommit(
  userId: string,
  signal: AbortSignal,
  previouslyCapturedAbort?: CapturedConnectorClientInvalidationAbort,
): Promise<void> {
  await publishConnectorClientInvalidationAfterCommit(
    { kind: "custom", audience: { kind: "user", userId } },
    signal,
    previouslyCapturedAbort,
  );
}

export async function publishCustomConnectorOrganizationInvalidationAfterCommit(
  orgId: string,
  organizations: Pick<ClerkOrganizationsApi, "getOrganizationMembershipList">,
  signal: AbortSignal,
  previouslyCapturedAbort?: CapturedConnectorClientInvalidationAbort,
): Promise<void> {
  await publishConnectorClientInvalidationAfterCommit(
    {
      kind: "custom",
      audience: { kind: "organization", orgId, organizations },
    },
    signal,
    previouslyCapturedAbort,
  );
}
