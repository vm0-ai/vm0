import {
  clerkRateLimit,
  createClerkReadContext,
  type ClerkClient,
  type ClerkReadContext,
} from "../external/clerk";
import {
  listAllOrganizationMemberships,
  listAllPendingOrganizationInvitations,
} from "../external/clerk-organization-lists";
import { onRejection, settle } from "../utils";

export class BillingClerkReadRateLimitError extends Error {
  constructor(
    readonly retryAfterSeconds: number,
    cause: unknown,
  ) {
    super("Billing Clerk read rate limit exhausted", { cause });
    this.name = "BillingClerkReadRateLimitError";
  }
}

async function billingClerkRead<T>(
  read: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  const result = await settle(read, signal);
  if (result.ok) {
    return result.value;
  }
  const rateLimit = clerkRateLimit(result.error);
  if (!rateLimit) {
    throw result.error;
  }
  throw new BillingClerkReadRateLimitError(
    rateLimit.retryAfterSeconds,
    result.error,
  );
}

export async function loadBillingOrganizationMemberships(
  clerk: ClerkClient,
  orgId: string,
  context: ClerkReadContext = createClerkReadContext(),
  signal: AbortSignal = new AbortController().signal,
): Promise<Awaited<ReturnType<typeof listAllOrganizationMemberships>>> {
  return await billingClerkRead(
    listAllOrganizationMemberships(clerk.organizations, orgId, context, signal),
    signal,
  );
}

export async function loadBillingOrganizationPendingInvitations(
  clerk: ClerkClient,
  orgId: string,
  context: ClerkReadContext = createClerkReadContext(),
  signal: AbortSignal = new AbortController().signal,
): Promise<Awaited<ReturnType<typeof listAllPendingOrganizationInvitations>>> {
  return await billingClerkRead(
    listAllPendingOrganizationInvitations(
      clerk.organizations,
      orgId,
      context,
      signal,
    ),
    signal,
  );
}

interface BillingOrganizationDirectory {
  readonly memberships: Awaited<
    ReturnType<typeof listAllOrganizationMemberships>
  >;
  readonly invitations: Awaited<
    ReturnType<typeof listAllPendingOrganizationInvitations>
  >;
}

export async function loadBillingOrganizationDirectory(
  clerk: ClerkClient,
  orgId: string,
  signal: AbortSignal,
): Promise<BillingOrganizationDirectory> {
  const controller = new AbortController();
  const readSignal = AbortSignal.any([signal, controller.signal]);
  const readContext = createClerkReadContext();
  const [memberships, invitations] = await onRejection(
    Promise.all([
      loadBillingOrganizationMemberships(clerk, orgId, readContext, readSignal),
      loadBillingOrganizationPendingInvitations(
        clerk,
        orgId,
        readContext,
        readSignal,
      ),
    ]),
    () => {
      controller.abort();
    },
  );
  controller.abort();
  signal.throwIfAborted();
  return { memberships, invitations };
}
