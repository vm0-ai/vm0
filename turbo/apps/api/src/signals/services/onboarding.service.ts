import { command, computed, type Computed } from "ccstate";
import { randomUUID } from "node:crypto";
import type { OnboardingStatusResponse } from "@vm0/api-contracts/contracts/onboarding";
import type { ConnectorType } from "@vm0/connectors/connectors";
import { SEED_INSTRUCTIONS } from "@vm0/core/zero-seed-instructions";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { userConnectors } from "@vm0/db/schema/user-connector";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { and, eq } from "drizzle-orm";

import type { AuthContext } from "../../types/auth";
import { logger } from "../../lib/log";
import { clerk$ } from "../external/clerk";
import { db$, writeDb$, type Db } from "../external/db";
import { nowDate } from "../external/time";
import { settle, tapError } from "../utils";
import { serverSideZeroAgentCompose$ } from "./agent-compose.service";
import {
  unavailableUserConnectorTypes,
  userConnectorAvailability,
} from "./connector-availability.service";
import { upsertOrgNoSecretModelProvider$ } from "./zero-model-provider.service";

const L = logger("onboarding.service");

interface DefaultAgentInfo {
  readonly composeId: string;
  readonly metadata: OnboardingStatusResponse["defaultAgentMetadata"];
}

type DefaultAgentMetadata = NonNullable<
  OnboardingStatusResponse["defaultAgentMetadata"]
>;

interface OnboardingSetupArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly workspaceName?: string;
  readonly sound?: string;
  readonly avatarUrl?: string;
  readonly selectedConnectors: readonly ConnectorType[];
  readonly timezone?: string;
  readonly onboardingRole?: string;
  readonly onboardingPaymentPending?: boolean;
}

type OnboardingSetupResponse =
  | {
      readonly status: 200;
      readonly body: { readonly agentId: string };
    }
  | {
      readonly status: 403;
      readonly body: {
        readonly error: {
          readonly message: string;
          readonly code: "FORBIDDEN";
        };
      };
    };

type OnboardingSetupForbiddenResponse = Extract<
  OnboardingSetupResponse,
  { readonly status: 403 }
>;

function unavailableSelectedConnectorsError(
  unavailableTypes: readonly ConnectorType[],
): OnboardingSetupForbiddenResponse | null {
  if (unavailableTypes.length === 0) {
    return null;
  }

  return {
    status: 403,
    body: {
      error: {
        message: `Connector types are not available: ${unavailableTypes.join(", ")}`,
        code: "FORBIDDEN",
      },
    },
  };
}

function nameToSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

function isClerkSlugConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const errors = Reflect.get(error, "errors");
  if (!Array.isArray(errors)) {
    return false;
  }

  return errors.some((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) {
      return false;
    }
    const code = Reflect.get(entry, "code");
    const message = Reflect.get(entry, "message");
    const meta = Reflect.get(entry, "meta");
    const paramName =
      typeof meta === "object" && meta !== null
        ? Reflect.get(meta, "paramName")
        : undefined;

    return (
      code === "form_identifier_exists" ||
      paramName === "slug" ||
      (typeof message === "string" &&
        (message.includes("already exists") || message.includes("slug")))
    );
  });
}

async function updateOrgWithOptionalSlug(
  client: ReturnType<typeof clerk$.read>,
  orgId: string,
  name: string,
  slug: string,
): Promise<"updated" | "conflict"> {
  const settled = await settle(
    client.organizations.updateOrganization(orgId, { name, slug }),
  );
  if (settled.ok) {
    return "updated" as const;
  }
  if (isClerkSlugConflict(settled.error)) {
    return "conflict" as const;
  }
  throw settled.error;
}

async function updateOrgNameAndSlug(
  client: ReturnType<typeof clerk$.read>,
  orgId: string,
  workspaceName: string,
): Promise<void> {
  const name = workspaceName.trim();
  if (!name) {
    return;
  }

  const baseSlug = nameToSlug(name);
  if (!baseSlug) {
    await client.organizations.updateOrganization(orgId, { name });
    return;
  }

  const slugCandidates = [
    baseSlug,
    `${baseSlug.slice(0, 56)}-${Math.random().toString(36).slice(2, 8)}`,
  ].filter((slug) => {
    return slug.length >= 3;
  });

  for (const slug of slugCandidates) {
    if (
      (await updateOrgWithOptionalSlug(client, orgId, name, slug)) === "updated"
    ) {
      return;
    }
  }

  await client.organizations.updateOrganization(orgId, { name });
}

async function existingDefaultAgentId(
  db: Db,
  orgId: string,
): Promise<string | null> {
  const [orgRow] = await db
    .select({ defaultAgentId: orgMetadata.defaultAgentId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);

  if (!orgRow?.defaultAgentId) {
    return null;
  }

  const [existing] = await db
    .select({ id: zeroAgents.id })
    .from(zeroAgents)
    .where(
      and(
        eq(zeroAgents.id, orgRow.defaultAgentId),
        eq(zeroAgents.orgId, orgId),
      ),
    )
    .limit(1);

  return existing?.id ?? null;
}

async function ensureAgentComposeRow(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly name: string;
  },
): Promise<string> {
  const [created] = await db
    .insert(agentComposes)
    .values({ userId: args.userId, orgId: args.orgId, name: args.name })
    .onConflictDoNothing()
    .returning({ id: agentComposes.id });

  if (created) {
    return created.id;
  }

  const [existing] = await db
    .select({ id: agentComposes.id })
    .from(agentComposes)
    .where(
      and(
        eq(agentComposes.orgId, args.orgId),
        eq(agentComposes.name, args.name),
      ),
    )
    .limit(1);

  if (!existing) {
    throw new Error("Expected existing agent compose after insert conflict");
  }

  return existing.id;
}

async function upsertDefaultAgentMetadata(
  db: Db,
  args: {
    readonly orgId: string;
    readonly agentId: string;
    readonly onboardingPaymentPending?: boolean;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(orgMetadata)
      .values({
        orgId: args.orgId,
        defaultAgentId: args.agentId,
        onboardingPaymentPending: args.onboardingPaymentPending ?? false,
      })
      .onConflictDoUpdate({
        target: orgMetadata.orgId,
        set: {
          defaultAgentId: args.agentId,
          ...(args.onboardingPaymentPending === undefined
            ? {}
            : { onboardingPaymentPending: args.onboardingPaymentPending }),
          updatedAt: nowDate(),
        },
      });
  });
}

async function upsertSetupMemberMetadata(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly timezone?: string;
    readonly onboardingRole?: string;
  },
): Promise<void> {
  await db
    .insert(orgMembersMetadata)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      timezone: args.timezone ?? null,
      onboardingRole: args.onboardingRole ?? null,
      createdAt: nowDate(),
      updatedAt: nowDate(),
    })
    .onConflictDoUpdate({
      target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
      set: {
        ...(args.onboardingRole === undefined
          ? {}
          : { onboardingRole: args.onboardingRole }),
        updatedAt: nowDate(),
      },
    });
}

async function upsertSetupMemberRole(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
  },
): Promise<void> {
  await db
    .insert(orgMembersCache)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      role: "admin",
      cachedAt: nowDate(),
    })
    .onConflictDoUpdate({
      target: [orgMembersCache.orgId, orgMembersCache.userId],
      set: { role: "admin", cachedAt: nowDate() },
    });
}

async function replaceSelectedConnectors(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string;
    readonly selectedConnectors: readonly ConnectorType[];
  },
): Promise<void> {
  if (args.selectedConnectors.length === 0) {
    return;
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(userConnectors)
      .where(
        and(
          eq(userConnectors.orgId, args.orgId),
          eq(userConnectors.userId, args.userId),
          eq(userConnectors.agentId, args.agentId),
        ),
      );
    await tx.insert(userConnectors).values(
      args.selectedConnectors.map((connectorType) => {
        return {
          orgId: args.orgId,
          userId: args.userId,
          agentId: args.agentId,
          connectorType,
        };
      }),
    );
  });
}

async function updateOnboardingPaymentPending(
  db: Db,
  orgId: string,
  onboardingPaymentPending: boolean,
): Promise<void> {
  await db
    .update(orgMetadata)
    .set({
      onboardingPaymentPending,
      updatedAt: nowDate(),
    })
    .where(eq(orgMetadata.orgId, orgId));
}

async function completeExistingDefaultAgentSetup(
  db: Db,
  args: OnboardingSetupArgs,
  selectedConnectors: readonly ConnectorType[],
  agentId: string,
  signal: AbortSignal,
): Promise<OnboardingSetupResponse> {
  await replaceSelectedConnectors(db, {
    orgId: args.orgId,
    userId: args.userId,
    agentId,
    selectedConnectors,
  });
  signal.throwIfAborted();

  await upsertSetupMemberMetadata(db, {
    orgId: args.orgId,
    userId: args.userId,
    timezone: args.timezone,
    onboardingRole: args.onboardingRole,
  });
  signal.throwIfAborted();

  if (args.onboardingPaymentPending !== undefined) {
    await updateOnboardingPaymentPending(
      db,
      args.orgId,
      args.onboardingPaymentPending,
    );
    signal.throwIfAborted();
  }

  return { status: 200 as const, body: { agentId } };
}

function defaultAgentId(orgId: string): Computed<Promise<string | null>> {
  return computed(async (get): Promise<string | null> => {
    const db = get(db$);
    const [row] = await db
      .select({ defaultAgentId: orgMetadata.defaultAgentId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .limit(1);

    return row?.defaultAgentId ?? null;
  });
}

function onboardingPaymentPending(orgId: string): Computed<Promise<boolean>> {
  return computed(async (get): Promise<boolean> => {
    const db = get(db$);
    const [row] = await db
      .select({
        onboardingPaymentPending: orgMetadata.onboardingPaymentPending,
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .limit(1);

    return row?.onboardingPaymentPending ?? false;
  });
}

function orgTier(orgId: string): Computed<Promise<string>> {
  return computed(async (get): Promise<string> => {
    const db = get(db$);
    const [row] = await db
      .select({ tier: orgMetadata.tier })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .limit(1);

    return row?.tier ?? "pro-suspend";
  });
}

function defaultAgentInfo(
  orgId: string,
  composeId: string,
): Computed<Promise<DefaultAgentInfo | null>> {
  return computed(async (get): Promise<DefaultAgentInfo | null> => {
    const db = get(db$);
    const [row] = await db
      .select({
        displayName: zeroAgents.displayName,
        description: zeroAgents.description,
        sound: zeroAgents.sound,
      })
      .from(agentComposes)
      .innerJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
      .where(
        and(eq(agentComposes.id, composeId), eq(agentComposes.orgId, orgId)),
      )
      .limit(1);

    if (!row) {
      return null;
    }

    const metadata: DefaultAgentMetadata = {};
    if (row.displayName !== null) {
      metadata.displayName = row.displayName;
    }
    if (row.description !== null) {
      metadata.description = row.description;
    }
    if (row.sound !== null) {
      metadata.sound = row.sound;
    }

    return {
      composeId,
      metadata: Object.keys(metadata).length > 0 ? metadata : null,
    };
  });
}

export function onboardingStatus(
  auth: AuthContext,
): Computed<Promise<OnboardingStatusResponse>> {
  return computed(async (get): Promise<OnboardingStatusResponse> => {
    if (!auth.orgId) {
      return {
        needsOnboarding: true,
        isAdmin: false,
        hasOrg: false,
        hasDefaultAgent: false,
        defaultAgentId: null,
        defaultAgentMetadata: null,
      };
    }

    const isAdmin = "orgRole" in auth && auth.orgRole === "admin";
    const agentId = await get(defaultAgentId(auth.orgId));
    const paymentPending = await get(onboardingPaymentPending(auth.orgId));
    const tier = await get(orgTier(auth.orgId));
    const defaultAgent = agentId
      ? await get(defaultAgentInfo(auth.orgId, agentId))
      : null;

    // New pro-suspend onboarding stays active until checkout clears the
    // pending marker. Paid orgs do not re-enter onboarding just because a
    // stale marker exists.
    return {
      needsOnboarding:
        isAdmin &&
        (!defaultAgent || (tier === "pro-suspend" && paymentPending)),
      isAdmin,
      hasOrg: true,
      hasDefaultAgent: defaultAgent !== null,
      defaultAgentId: defaultAgent?.composeId ?? null,
      defaultAgentMetadata: defaultAgent?.metadata ?? null,
    };
  });
}

export const setupOnboarding$ = command(
  async (
    { get, set },
    args: OnboardingSetupArgs,
    signal: AbortSignal,
  ): Promise<OnboardingSetupResponse> => {
    const selectedConnectors = Array.from(new Set(args.selectedConnectors));
    const unavailableTypes =
      selectedConnectors.length === 0
        ? []
        : unavailableUserConnectorTypes(
            await get(userConnectorAvailability(args.orgId, args.userId)),
            selectedConnectors,
          );
    signal.throwIfAborted();
    const availabilityError =
      unavailableSelectedConnectorsError(unavailableTypes);
    if (availabilityError) {
      return availabilityError;
    }

    const writeDb = set(writeDb$);
    const existingAgentId = await existingDefaultAgentId(writeDb, args.orgId);
    signal.throwIfAborted();

    if (existingAgentId) {
      // Default agent already exists — onboarding step 1 is done. Still
      // authorize any connectors the user picked in the (skippable) step 2.
      return completeExistingDefaultAgentSetup(
        writeDb,
        args,
        selectedConnectors,
        existingAgentId,
        signal,
      );
    }

    await set(
      upsertOrgNoSecretModelProvider$,
      {
        orgId: args.orgId,
        type: "vm0",
        selectedModel: "claude-sonnet-4-6",
      },
      signal,
    );
    signal.throwIfAborted();

    const agentName = randomUUID();
    const composeId = await ensureAgentComposeRow(writeDb, {
      orgId: args.orgId,
      userId: args.userId,
      name: agentName,
    });
    signal.throwIfAborted();

    const composeResult = await set(
      serverSideZeroAgentCompose$,
      {
        userId: args.userId,
        orgId: args.orgId,
        agentComposeId: composeId,
        agentName,
        instructions: SEED_INSTRUCTIONS,
      },
      signal,
    );
    signal.throwIfAborted();

    if (args.workspaceName?.trim()) {
      const client = get(clerk$);
      await tapError(
        updateOrgNameAndSlug(client, args.orgId, args.workspaceName),
        (error) => {
          L.warn("Failed to update org name/slug (non-blocking)", {
            orgId: args.orgId,
            error,
          });
        },
      );
      signal.throwIfAborted();
    }

    await writeDb
      .insert(zeroAgents)
      .values({
        id: composeResult.composeId,
        orgId: args.orgId,
        name: composeResult.composeName,
        owner: args.userId,
        displayName: args.displayName,
        description: null,
        sound: args.sound ?? null,
        avatarUrl: args.avatarUrl ?? null,
        customSkills: [],
      })
      .onConflictDoUpdate({
        target: [zeroAgents.orgId, zeroAgents.name],
        set: {
          displayName: args.displayName,
          sound: args.sound ?? null,
          avatarUrl: args.avatarUrl ?? null,
          updatedAt: nowDate(),
        },
      });
    signal.throwIfAborted();

    await upsertDefaultAgentMetadata(writeDb, {
      orgId: args.orgId,
      agentId: composeResult.composeId,
      onboardingPaymentPending: args.onboardingPaymentPending,
    });
    signal.throwIfAborted();

    await upsertSetupMemberMetadata(writeDb, {
      orgId: args.orgId,
      userId: args.userId,
      timezone: args.timezone,
      onboardingRole: args.onboardingRole,
    });
    signal.throwIfAborted();

    await upsertSetupMemberRole(writeDb, {
      orgId: args.orgId,
      userId: args.userId,
    });
    signal.throwIfAborted();

    await replaceSelectedConnectors(writeDb, {
      orgId: args.orgId,
      userId: args.userId,
      agentId: composeResult.composeId,
      selectedConnectors,
    });
    signal.throwIfAborted();

    L.debug("Onboarding setup completed", {
      orgId: args.orgId,
      agentId: composeResult.composeId,
    });

    return { status: 200 as const, body: { agentId: composeResult.composeId } };
  },
);
