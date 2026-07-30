import { randomUUID } from "node:crypto";

import type StripeSDK from "stripe";
import type { z } from "zod";
import {
  cliAuthApproveContract,
  cliAuthDeviceContract,
  cliAuthTokenContract,
} from "@vm0/api-contracts/contracts/cli-auth";
import {
  composesMainContract,
  type ZeroCapability,
} from "@vm0/api-contracts/contracts/composes";
import { webhookStripeContract } from "@vm0/api-contracts/contracts/webhooks";
import { zeroBillingStatusContract } from "@vm0/api-contracts/contracts/zero-billing";
import {
  zeroUserPermissionGrantsContract,
  type ApplyUserPermissionGrant,
  type ApplyUserPermissionGrantsRequest,
  type UserPermissionGrantResponse,
} from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import { runnerRealtimeTokenContract } from "@vm0/api-contracts/contracts/realtime";
import { zeroModelPoliciesMainContract } from "@vm0/api-contracts/contracts/zero-model-policies";
import { zeroModelProvidersMainContract } from "@vm0/api-contracts/contracts/zero-model-providers";
import type { ModelProviderResponse } from "@vm0/api-contracts/contracts/model-providers";
import {
  cronAggregateInsightsContract,
  cronAggregateUsageContract,
  cronProcessUsageEventsContract,
  cronReconcileBillingEntitlementsContract,
  cronTelegramCleanupContract,
} from "@vm0/api-contracts/contracts/cron";
import {
  runnersNetworkPolicyRefreshContract,
  runnersHeartbeatContract,
  runnersJobClaimContract,
  runnersPollContract,
  type CanonicalStorageManifest,
  type StorageManifest,
} from "@vm0/api-contracts/contracts/runners";
import {
  zeroRunsCancelContract,
  zeroRunCreateBodySchema,
  zeroRunContextContract,
  zeroRunRunnerContract,
  zeroRunsByIdContract,
  zeroRunsQueueContract,
} from "@vm0/api-contracts/contracts/zero-runs";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";

import { createAppWithRoutes } from "../../../../app-factory-core";
import { setupAppWithRoutes } from "../../../../__tests__/test-app";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { mockEnv, mockOptionalEnv } from "../../../../lib/env";
import { now } from "../../../../lib/time";
import {
  createDirectRunFixture,
  listAgentRunsFixture,
  type DirectRunFixtureRequest,
} from "../../../../test-fixtures/agent-runs";
import {
  generateSandboxToken,
  signSandboxJwtForTests,
} from "../../../auth/tokens";
import { mockStripeClient } from "../../../external/stripe-client";
import { agentComposesReadRoutes } from "../../agent-composes-read";
import { agentComposesRoutes } from "../../agent-composes";
import { cliAuthRoutes } from "../../cli-auth";
import { cronAggregateInsightsRoutes } from "../../cron-aggregate-insights";
import { cronAggregateUsageRoutes } from "../../cron-aggregate-usage";
import { cronProcessUsageEventsRoutes } from "../../cron-process-usage-events";
import { cronReconcileBillingEntitlementsRoutes } from "../../cron-reconcile-billing-entitlements";
import { cronTelegramCleanupRoutes } from "../../cron-telegram-cleanup";
import { runnersRoutes } from "../../runners";
import { webhooksStripeRoutes } from "../../webhooks-stripe";
import { zeroAgentsRoutes } from "../../zero-agents";
import { zeroBillingStatusRoutes } from "../../zero-billing-status";
import { zeroModelPoliciesRoutes } from "../../zero-model-policies";
import { zeroModelProvidersRoutes } from "../../zero-model-providers";
import { zeroRunDetailRoutes } from "../../zero-run-detail";
import { zeroRunsCancelRoutes } from "../../zero-runs-cancel";
import { zeroRunsRoutes } from "../../zero-runs";
import {
  zeroRunFixtureContract,
  zeroRunFixtureRoutes,
} from "../../test-zero-run-fixture";
import { zeroUserPermissionGrantsRoutes } from "../../zero-user-permission-grants";
import { createBddApi, type ApiTestUser } from "./api-bdd";
import { createZeroRouteMocks } from "./zero-route-test";

type AuthHeaders = { readonly authorization?: string };
type ZeroRunRequest = z.infer<typeof zeroRunCreateBodySchema>;
type DirectRunRequest = DirectRunFixtureRequest;
interface RunsListQuery {
  readonly status?: string;
  readonly agent?: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
}
type RunnerJobClaimRequest = z.infer<
  (typeof runnersJobClaimContract.claim)["body"]
>;
type RunnerNetworkPolicyRefreshRequest = z.input<
  (typeof runnersNetworkPolicyRefreshContract.refresh)["body"]
>;
type RunnerNetworkPolicyRefreshStatus = 200 | 400 | 401 | 403 | 404 | 409 | 500;
type ComposeContent = z.infer<
  (typeof composesMainContract.create)["body"]
>["content"];
type OrgModelPolicyRequest = z.infer<
  (typeof zeroModelPoliciesMainContract.update)["body"]
>;
type OrgModelProviderUpsertRequest = z.infer<
  (typeof zeroModelProvidersMainContract.upsert)["body"]
>;
type RunnerHeartbeatBody = z.infer<
  (typeof runnersHeartbeatContract.heartbeat)["body"]
>;
type RunnerPollBody = z.infer<(typeof runnersPollContract.poll)["body"]>;
type RunnerRealtimeTokenBody = z.infer<
  (typeof runnerRealtimeTokenContract.create)["body"]
>;

export function expectCanonicalStorageManifest(
  manifest: StorageManifest | null | undefined,
): CanonicalStorageManifest | null | undefined {
  if (manifest === null || manifest === undefined) {
    return manifest;
  }
  if (!("storageMounts" in manifest)) {
    throw new Error("Expected a canonical Storage manifest");
  }
  return manifest;
}

interface ClerkUserProfile {
  readonly id: string;
  readonly emailAddresses: readonly {
    readonly id: string;
    readonly emailAddress: string;
  }[];
  readonly primaryEmailAddressId: string;
  readonly firstName: string;
  readonly lastName: string;
}

interface ClerkOrganizationMembership {
  readonly publicUserData: {
    readonly userId: string;
  };
}

const OFFICIAL_RUNNER_AUTHORIZATION =
  "Bearer vm0_official_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const CRON_AUTHORIZATION = "Bearer test-cron-secret";

const runRoutes = [
  ...cliAuthRoutes,
  ...agentComposesRoutes,
  ...agentComposesReadRoutes,
  ...cronAggregateInsightsRoutes,
  ...cronAggregateUsageRoutes,
  ...cronProcessUsageEventsRoutes,
  ...cronReconcileBillingEntitlementsRoutes,
  ...cronTelegramCleanupRoutes,
  ...runnersRoutes,
  ...webhooksStripeRoutes,
  ...zeroBillingStatusRoutes,
  ...zeroModelPoliciesRoutes,
  ...zeroModelProvidersRoutes,
  ...zeroRunDetailRoutes,
  ...zeroRunFixtureRoutes,
  ...zeroRunsRoutes,
  ...zeroRunsCancelRoutes,
  ...zeroAgentsRoutes,
  ...zeroUserPermissionGrantsRoutes,
] as const;

function runApp(context: TestContext) {
  return setupAppWithRoutes({ context, routes: runRoutes });
}

function clerkUserProfile(actor: ApiTestUser): ClerkUserProfile {
  const emailId = `email_${actor.userId}`;
  return {
    id: actor.userId,
    emailAddresses: [{ id: emailId, emailAddress: actor.email }],
    primaryEmailAddressId: emailId,
    firstName: "BDD",
    lastName: "Runner",
  };
}

function clerkOrganizationMemberships(
  actor: ApiTestUser,
): readonly ClerkOrganizationMembership[] {
  if (!actor.orgId) {
    return [];
  }

  return [{ publicUserData: { userId: actor.userId } }];
}

function authenticate(
  context: TestContext,
  nextActor: ApiTestUser | null,
): AuthHeaders {
  if (!nextActor) {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    return {};
  }

  createZeroRouteMocks(context).clerk.session(
    nextActor.userId,
    nextActor.orgId,
    nextActor.orgRole,
  );
  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: [clerkUserProfile(nextActor)],
  });
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: clerkOrganizationMemberships(nextActor),
    },
  );
  return { authorization: "Bearer clerk-session" };
}

function cronHeaders(valid: boolean): AuthHeaders {
  return valid ? { authorization: CRON_AUTHORIZATION } : {};
}

function runnerHeaders(valid: boolean): AuthHeaders {
  return valid ? { authorization: OFFICIAL_RUNNER_AUTHORIZATION } : {};
}

function runnerHeartbeatBody(
  args: {
    readonly runnerId?: string;
    readonly group?: string;
    readonly snapshotGeneration?: RunnerHeartbeatBody["snapshotGeneration"];
    readonly snapshotSequence?: RunnerHeartbeatBody["snapshotSequence"];
    readonly admittableProfiles?: RunnerHeartbeatBody["admittableProfiles"];
    readonly maxConcurrent?: RunnerHeartbeatBody["maxConcurrent"];
    readonly allocatedVcpu?: RunnerHeartbeatBody["allocatedVcpu"];
    readonly allocatedMemoryMb?: RunnerHeartbeatBody["allocatedMemoryMb"];
    readonly runningCount?: RunnerHeartbeatBody["runningCount"];
    readonly heldSessionStates?: RunnerHeartbeatBody["heldSessionStates"];
    readonly mode?: RunnerHeartbeatBody["mode"];
  } = {},
): RunnerHeartbeatBody {
  return {
    runnerId: args.runnerId ?? randomUUID(),
    runnerName: "bdd-runner",
    group: args.group ?? "vm0/test",
    snapshotGeneration: args.snapshotGeneration ?? 1,
    snapshotSequence: args.snapshotSequence ?? 1,
    totalVcpu: 8,
    totalMemoryMb: 16_384,
    maxConcurrent: args.maxConcurrent ?? 2,
    allocatedVcpu: args.allocatedVcpu ?? 0,
    allocatedMemoryMb: args.allocatedMemoryMb ?? 0,
    runningCount: args.runningCount ?? 0,
    admittableProfiles: args.admittableProfiles ?? ["vm0/default"],
    heldSessionStates: args.heldSessionStates ?? [],
    mode: args.mode ?? "running",
  };
}

export function createRunsApi(context: TestContext) {
  const applyUserPermissionGrantRequestBody = (
    body: {
      readonly agentId: string;
      readonly connectorSlug: string;
    } & ApplyUserPermissionGrant,
  ): ApplyUserPermissionGrantsRequest => {
    const grant: ApplyUserPermissionGrant =
      body.action === "allow"
        ? {
            permission: body.permission,
            action: "allow",
            ...(body.expiresIn ? { expiresIn: body.expiresIn } : {}),
          }
        : {
            permission: body.permission,
            action: "deny",
          };
    return {
      agentId: body.agentId,
      connectorRef: body.connectorSlug,
      mode: "patch",
      grants: [grant],
    };
  };

  async function createDirectRunThroughService(
    actor: ApiTestUser | null,
    body: DirectRunRequest,
  ) {
    if (!actor?.orgId) {
      return {
        status: 401 as const,
        body: {
          error: {
            message: "Not authenticated",
            code: "UNAUTHORIZED" as const,
          },
        },
      };
    }
    return await createDirectRunFixture({
      userId: actor.userId,
      orgId: actor.orgId,
      body,
      signal: context.signal,
    });
  }

  return {
    async requestRemovedZeroRunCreation(actor: ApiTestUser): Promise<number> {
      const { authorization } = authenticate(context, actor);
      const app = createAppWithRoutes({
        signal: context.signal,
        routes: runRoutes,
      });
      const response = await app.request("/api/zero/runs", {
        method: "POST",
        headers: {
          ...(authorization === undefined ? {} : { authorization }),
          "content-type": "application/json",
        },
        body: JSON.stringify({ agentId: randomUUID(), prompt: "removed" }),
      });
      return response.status;
    },

    configureRunnerGroup(): string {
      const group = `vm0/bdd-${randomUUID().slice(0, 8)}`;
      mockOptionalEnv("RUNNER_DEFAULT_GROUP", group);
      return group;
    },

    acceptStorageDownloads(): void {
      context.mocks.s3.getSignedUrl.mockResolvedValue(
        "https://r2.example.com/storage/archive.tar.gz?sig=bdd",
      );
    },

    acceptTelemetryIngest(): void {
      context.mocks.axiom.ingest.mockResolvedValue(true);
      context.mocks.axiom.query.mockResolvedValue([]);
    },

    // `periodEndUnix` moves the granted subscription period (and therefore
    // the credit expiry, period end + 1 month) — a far-past period end yields
    // an org whose entire credit balance is already expired.
    async grantProEntitlement(
      actor: ApiTestUser,
      options: {
        readonly customerId?: string;
        readonly subscriptionId?: string;
        readonly tier?: "pro" | "team";
        readonly periodEndUnix?: number;
        readonly subscriptionMetadata?: Record<string, string>;
        readonly cancelAtUnix?: number | null;
      } = {},
    ): Promise<{
      readonly customerId: string;
      readonly subscriptionId: string;
      readonly invoiceId: string;
    }> {
      mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
      mockEnv("ZERO_PRICE_PRO", "price_bdd_pro");
      mockEnv("ZERO_PRICE_TEAM", "price_bdd_team");
      mockEnv("ATOM_GRANT_PRICE", "price_bdd_atom_grant");
      mockEnv("ZERO_PRICE_CONCURRENCY", "price_bdd_concurrency");
      mockOptionalEnv("STRIPE_WEBHOOK_SECRET", "whsec_bdd_stripe");
      const tier = options.tier ?? "pro";

      const suffix = randomUUID().slice(0, 8);
      const customerId = options.customerId ?? `cus_bdd_${suffix}`;
      const subscriptionId = options.subscriptionId ?? `sub_bdd_${suffix}`;
      const invoiceId = `in_bdd_${suffix}`;
      context.mocks.stripe.customers.retrieve.mockResolvedValue({
        id: customerId,
        metadata: { orgId: actor.orgId },
      });
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
        id: subscriptionId,
        status: "active",
        customer: customerId,
        cancel_at_period_end: false,
        cancel_at: options.cancelAtUnix ?? null,
        schedule: null,
        trial_end: null,
        metadata: options.subscriptionMetadata ?? {},
        items: {
          data: [
            {
              price: {
                id: tier === "team" ? "price_bdd_team" : "price_bdd_pro",
              },
            },
          ],
        },
      });
      if (tier === "team") {
        context.mocks.stripe.subscriptions.list.mockResolvedValue({ data: [] });
      }
      const invoicePaidEvent = {
        type: "invoice.paid",
        data: {
          object: {
            id: invoiceId,
            customer: customerId,
            metadata: {},
            parent: { subscription_details: { subscription: subscriptionId } },
            lines: {
              data: [
                {
                  parent: { type: "subscription_item_details" },
                  period: {
                    end:
                      options.periodEndUnix ??
                      Math.floor(now() / 1000) + 30 * 86_400,
                  },
                },
              ],
            },
          },
        },
      };
      context.mocks.stripe.webhooks.constructEvent.mockReturnValueOnce(
        invoicePaidEvent,
      );
      await accept(
        runApp(context)(webhookStripeContract).post({
          body: JSON.stringify(invoicePaidEvent),
          extraHeaders: { "stripe-signature": "t=1,v1=bdd" },
        }),
        [200],
      );

      const billingStatus = await accept(
        runApp(context)(zeroBillingStatusContract).get({
          headers: authenticate(context, actor),
        }),
        [200],
      );
      if (billingStatus.body.tier !== tier) {
        throw new Error(
          `Entitlement grant did not reach ${tier} tier: ${billingStatus.body.tier}`,
        );
      }

      // Bootstrap only after the paid entitlement exists. Onboarding status
      // then creates a default agent without granting limited-free credits or
      // replacing metadata on an existing default agent.
      const bdd = createBddApi(context);
      const onboarding = await bdd.readOnboardingStatus(actor);
      if (!onboarding.defaultAgentId) {
        throw new Error("Expected paid onboarding to create a default agent");
      }
      const completed = await bdd.completeOnboarding(actor);
      if (completed.status !== 200) {
        throw new Error(
          `Expected paid onboarding completion, got ${completed.status}`,
        );
      }

      return { customerId, subscriptionId, invoiceId };
    },

    async createRun(actor: ApiTestUser, body: ZeroRunRequest) {
      const response = await accept(
        runApp(context)(zeroRunFixtureContract).create({
          headers: authenticate(context, actor),
          body,
        }),
        [201],
      );
      return response.body;
    },

    async claimRunnerJob(runId: string, body: RunnerJobClaimRequest = {}) {
      const response = await accept(
        runApp(context)(runnersJobClaimContract).claim({
          headers: runnerHeaders(true),
          params: { id: runId },
          body,
        }),
        [200],
      );
      return response.body;
    },

    async refreshRunnerNetworkPolicy(runId: string, connectorSlug: string) {
      const response = await accept(
        runApp(context)(runnersNetworkPolicyRefreshContract).refresh({
          headers: runnerHeaders(true),
          params: { runId },
          body: {
            connectorSlugs: [connectorSlug],
          },
        }),
        [200],
      );
      const [refresh] = response.body.refreshes;
      if (!refresh) {
        throw new Error(
          `Expected refreshed network policy for ${connectorSlug}`,
        );
      }
      return refresh;
    },

    async requestRefreshRunnerNetworkPolicy<
      TStatus extends RunnerNetworkPolicyRefreshStatus,
    >(
      runId: string,
      body: RunnerNetworkPolicyRefreshRequest,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        runApp(context)(runnersNetworkPolicyRefreshContract).refresh({
          headers: runnerHeaders(true),
          params: { runId },
          body,
        }),
        statuses,
      );
    },

    async requestRefreshRunnerNetworkPolicyAs<
      TStatus extends RunnerNetworkPolicyRefreshStatus,
    >(
      authorization: string | undefined,
      runId: string,
      body: RunnerNetworkPolicyRefreshRequest,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        runApp(context)(runnersNetworkPolicyRefreshContract).refresh({
          headers: authorization === undefined ? {} : { authorization },
          params: { runId },
          body,
        }),
        statuses,
      );
    },

    async createCliToken(actor: ApiTestUser): Promise<{
      readonly token: string;
    }> {
      const device = await accept(
        runApp(context)(cliAuthDeviceContract).create({ body: {} }),
        [200],
      );
      await accept(
        runApp(context)(cliAuthApproveContract).approve({
          headers: authenticate(context, actor),
          body: { device_code: device.body.device_code },
        }),
        [200],
      );
      const token = await accept(
        runApp(context)(cliAuthTokenContract).exchange({
          body: { device_code: device.body.device_code },
        }),
        [200],
      );
      return { token: token.body.access_token };
    },

    async requestPollRunnerAs(
      authorization: string | undefined,
      body: RunnerPollBody,
      statuses: readonly (200 | 400 | 401 | 500)[],
    ) {
      return await accept(
        runApp(context)(runnersPollContract).poll({
          headers: authorization === undefined ? {} : { authorization },
          body,
        }),
        statuses,
      );
    },

    async requestClaimRunnerJobAs(
      authorization: string | undefined,
      runId: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 500)[],
      body: z.infer<(typeof runnersJobClaimContract.claim)["body"]> = {},
    ) {
      return await accept(
        runApp(context)(runnersJobClaimContract).claim({
          headers: authorization === undefined ? {} : { authorization },
          params: { id: runId },
          body,
        }),
        statuses,
      );
    },

    async requestRawClaimRunnerJobAs(
      authorization: string | undefined,
      runId: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 500)[],
      body: unknown,
    ) {
      return await accept(
        runApp(context)(runnersJobClaimContract).claim({
          headers: authorization === undefined ? {} : { authorization },
          params: { id: runId },
          body: body as RunnerJobClaimRequest,
        }),
        statuses,
      );
    },

    async requestRunnerRealtimeTokenAs(
      authorization: string | undefined,
      body: RunnerRealtimeTokenBody,
      statuses: readonly (200 | 400 | 401 | 403 | 500)[],
    ) {
      return await accept(
        runApp(context)(runnerRealtimeTokenContract).create({
          headers: authorization === undefined ? {} : { authorization },
          body,
        }),
        statuses,
      );
    },

    /**
     * Signs a sandbox webhook token for an API-created run, so sandbox
     * report webhooks (heartbeat/complete/...) can act on runs that were
     * never claimed by a runner.
     */
    sandboxTokenForRun(actor: ApiTestUser, runId: string): string {
      if (!actor.orgId) {
        throw new Error("Sandbox run tokens require an org-scoped actor");
      }
      return generateSandboxToken(actor.userId, runId, actor.orgId);
    },

    /** Mints a route-test token without changing production capability issuance. */
    zeroTokenForRunWithCapabilities(
      actor: ApiTestUser,
      runId: string,
      capabilities: readonly ZeroCapability[],
    ): string {
      if (!actor.orgId) {
        throw new Error("Zero run tokens require an org-scoped actor");
      }
      const seconds = Math.floor(now() / 1000);
      return signSandboxJwtForTests({
        scope: "zero",
        userId: actor.userId,
        orgId: actor.orgId,
        runId,
        capabilities: [...capabilities],
        iat: seconds,
        exp: seconds + 3600,
      });
    },

    async createCompose(
      actor: ApiTestUser,
      content: ComposeContent,
    ): Promise<{
      readonly composeId: string;
      readonly name: string;
      readonly versionId: string;
    }> {
      const response = await accept(
        runApp(context)(composesMainContract).create({
          headers: authenticate(context, actor),
          body: { content },
        }),
        [200, 201],
      );
      return {
        composeId: response.body.composeId,
        name: response.body.name,
        versionId: response.body.versionId,
      };
    },

    async createDirectRun(actor: ApiTestUser, body: DirectRunRequest) {
      const response = await accept(
        createDirectRunThroughService(actor, body),
        [201],
      );
      return response.body;
    },

    async requestDirectRun(
      actor: ApiTestUser | null,
      body: DirectRunRequest,
      statuses: readonly (201 | 400 | 401 | 402 | 403 | 404 | 429 | 503)[],
    ) {
      return await accept(createDirectRunThroughService(actor, body), statuses);
    },

    async listAgentRuns(actor: ApiTestUser, query: RunsListQuery) {
      if (!actor.orgId) {
        throw new Error("Agent run list service requires an organization");
      }
      const result = await listAgentRunsFixture({
        userId: actor.userId,
        orgId: actor.orgId,
        status: query.status,
        agent: query.agent,
        since: query.since,
        until: query.until,
        limit: query.limit,
      });
      if (result.kind === "bad-request") {
        throw new Error(result.message);
      }
      return result.body;
    },

    async applyUserPermissionGrant(
      actor: ApiTestUser,
      body: {
        readonly agentId: string;
        readonly connectorSlug: string;
      } & ApplyUserPermissionGrant,
    ): Promise<UserPermissionGrantResponse> {
      const response = await accept(
        runApp(context)(zeroUserPermissionGrantsContract).apply({
          headers: authenticate(context, actor),
          body: applyUserPermissionGrantRequestBody(body),
        }),
        [200],
      );
      const grant = response.body[0];
      if (!grant) {
        throw new Error("User permission grant apply did not return a grant");
      }
      return grant;
    },

    async requestUserPermissionGrant(
      actor: ApiTestUser,
      body: {
        readonly agentId: string;
        readonly connectorSlug: string;
      } & ApplyUserPermissionGrant,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 500)[],
    ) {
      return await accept(
        runApp(context)(zeroUserPermissionGrantsContract).apply({
          headers: authenticate(context, actor),
          body: applyUserPermissionGrantRequestBody(body),
        }),
        statuses,
      );
    },

    async replaceUserPermissionGrants(
      actor: ApiTestUser,
      body: {
        readonly agentId: string;
        readonly connectorSlug: string;
        readonly grants: readonly ApplyUserPermissionGrant[];
      },
    ): Promise<readonly UserPermissionGrantResponse[]> {
      const response = await accept(
        runApp(context)(zeroUserPermissionGrantsContract).apply({
          headers: authenticate(context, actor),
          body: {
            agentId: body.agentId,
            connectorRef: body.connectorSlug,
            mode: "replace",
            grants: [...body.grants],
          },
        }),
        [200],
      );
      return response.body;
    },

    async listUserPermissionGrants(
      actor: ApiTestUser,
      agentId: string,
    ): Promise<readonly UserPermissionGrantResponse[]> {
      const response = await accept(
        runApp(context)(zeroUserPermissionGrantsContract).list({
          headers: authenticate(context, actor),
          query: { agentId },
        }),
        [200],
      );
      return response.body;
    },

    /**
     * Replaces the caller's enabled connector slugs for an agent through
     * PUT /api/zero/agents/:id/user-connectors and returns the visible set.
     */
    async enableAgentConnectors(
      actor: ApiTestUser,
      agentId: string,
      connectorSlugs: readonly string[],
    ): Promise<readonly string[]> {
      const response = await accept(
        runApp(context)(zeroUserConnectorsContract).update({
          headers: authenticate(context, actor),
          params: { id: agentId },
          body: { enabledTypes: [...connectorSlugs] },
        }),
        [200],
      );
      return response.body.enabledTypes;
    },

    async listOrgModelProviders(
      actor: ApiTestUser,
    ): Promise<readonly ModelProviderResponse[]> {
      const response = await accept(
        runApp(context)(zeroModelProvidersMainContract).list({
          headers: authenticate(context, actor),
        }),
        [200],
      );
      return response.body.modelProviders;
    },

    /**
     * Upserts an org-level model provider with an arbitrary contract body
     * (single secret or multi-auth secrets map) and returns the provider id.
     */
    async createOrgModelProvider(
      actor: ApiTestUser,
      body: OrgModelProviderUpsertRequest,
    ): Promise<{ readonly providerId: string }> {
      const response = await accept(
        runApp(context)(zeroModelProvidersMainContract).upsert({
          headers: authenticate(context, actor),
          body,
        }),
        [200, 201],
      );
      return { providerId: response.body.provider.id };
    },

    /**
     * Replaces the org model-first policies with the given request-shaped
     * list (the PUT is a wholesale replace of supported-run-model rows).
     */
    async updateOrgModelPolicies(
      actor: ApiTestUser,
      policies: OrgModelPolicyRequest["policies"],
    ): Promise<void> {
      await accept(
        runApp(context)(zeroModelPoliciesMainContract).update({
          headers: authenticate(context, actor),
          body: { policies },
        }),
        [200],
      );
    },

    async ensureOrgModelProvider(
      actor: ApiTestUser,
    ): Promise<{ readonly providerId: string }> {
      const providerResponse = await accept(
        runApp(context)(zeroModelProvidersMainContract).upsert({
          headers: authenticate(context, actor),
          body: {
            type: "anthropic-api-key",
            secret: "test-anthropic-key",
          },
        }),
        [200, 201],
      );

      const providerId = providerResponse.body.provider.id;
      const policies: OrgModelPolicyRequest["policies"] = [
        {
          model: "claude-sonnet-4-6",
          isDefault: true,
          defaultProviderType: "anthropic-api-key",
          credentialScope: "org",
          modelProviderId: providerId,
        },
      ];

      await accept(
        runApp(context)(zeroModelPoliciesMainContract).update({
          headers: authenticate(context, actor),
          body: { policies },
        }),
        [200],
      );

      return { providerId };
    },

    async readBillingStatus(actor: ApiTestUser) {
      const response = await accept(
        runApp(context)(zeroBillingStatusContract).get({
          headers: authenticate(context, actor),
        }),
        [200],
      );
      return response.body;
    },

    async requestCreateRun(
      actor: ApiTestUser | null,
      body: ZeroRunRequest,
      statuses: readonly (201 | 400 | 401 | 402 | 403 | 404 | 429 | 503)[],
      extraHeaders?: Readonly<Record<string, string>>,
    ) {
      return await accept(
        runApp(context)(zeroRunFixtureContract).create({
          headers: {
            ...authenticate(context, actor),
            ...extraHeaders,
          },
          body,
        }),
        statuses,
      );
    },

    async requestCreateRunUnchecked(
      actor: ApiTestUser | null,
      body: unknown,
      statuses: readonly (201 | 400 | 401 | 402 | 403 | 404 | 429 | 503)[],
    ) {
      return await accept(
        runApp(context)(zeroRunFixtureContract).create({
          headers: authenticate(context, actor),
          body: body as ZeroRunRequest,
        }),
        statuses,
      );
    },

    async readRun(actor: ApiTestUser, runId: string) {
      const response = await accept(
        runApp(context)(zeroRunsByIdContract).getById({
          headers: authenticate(context, actor),
          params: { id: runId },
        }),
        [200],
      );
      return response.body;
    },

    async requestReadRun(
      actor: ApiTestUser | null,
      runId: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      return await accept(
        runApp(context)(zeroRunsByIdContract).getById({
          headers: authenticate(context, actor),
          params: { id: runId },
        }),
        statuses,
      );
    },

    async requestRunContext(
      actor: ApiTestUser | null,
      runId: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      return await accept(
        runApp(context)(zeroRunContextContract).getContext({
          headers: authenticate(context, actor),
          params: { id: runId },
        }),
        statuses,
      );
    },

    async requestRunRunner(
      actor: ApiTestUser | null,
      runId: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      return await accept(
        runApp(context)(zeroRunRunnerContract).getRunner({
          headers: authenticate(context, actor),
          params: { id: runId },
        }),
        statuses,
      );
    },

    async readRunQueue(actor: ApiTestUser) {
      return await accept(
        runApp(context)(zeroRunsQueueContract).getQueue({
          headers: authenticate(context, actor),
        }),
        [200],
      );
    },

    async requestReadRunQueue(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 403)[],
    ) {
      return await accept(
        runApp(context)(zeroRunsQueueContract).getQueue({
          headers: authenticate(context, actor),
        }),
        statuses,
      );
    },

    async requestCancelRun(
      actor: ApiTestUser | null,
      runId: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      return await accept(
        runApp(context)(zeroRunsCancelContract).cancel({
          headers: authenticate(context, actor),
          params: { id: runId },
        }),
        statuses,
      );
    },

    async requestCancelRunAs(
      authorization: string,
      runId: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      return await accept(
        runApp(context)(zeroRunsCancelContract).cancel({
          headers: { authorization },
          params: { id: runId },
        }),
        statuses,
      );
    },

    async requestCancelRunWithSignal(
      actor: ApiTestUser,
      runId: string,
      signal: AbortSignal,
    ): Promise<{ readonly status: number; readonly body: unknown }> {
      const { authorization } = authenticate(context, actor);
      const app = createAppWithRoutes({
        signal,
        routes: runRoutes,
      });
      const response = await app.request(`/api/zero/runs/${runId}/cancel`, {
        method: "POST",
        headers: authorization === undefined ? {} : { authorization },
      });
      const body: unknown = await response.json();
      return { status: response.status, body };
    },

    async heartbeatRunner(group?: string) {
      return await accept(
        runApp(context)(runnersHeartbeatContract).heartbeat({
          headers: runnerHeaders(true),
          body: runnerHeartbeatBody({ group }),
        }),
        [200],
      );
    },

    async requestHeartbeatRunner(
      validAuth: boolean,
      statuses: readonly (200 | 400 | 401 | 500)[],
      args: {
        readonly runnerId?: string;
        readonly group?: string;
        readonly snapshotGeneration?: RunnerHeartbeatBody["snapshotGeneration"];
        readonly snapshotSequence?: RunnerHeartbeatBody["snapshotSequence"];
        readonly admittableProfiles?: RunnerHeartbeatBody["admittableProfiles"];
        readonly maxConcurrent?: RunnerHeartbeatBody["maxConcurrent"];
        readonly allocatedVcpu?: RunnerHeartbeatBody["allocatedVcpu"];
        readonly allocatedMemoryMb?: RunnerHeartbeatBody["allocatedMemoryMb"];
        readonly runningCount?: RunnerHeartbeatBody["runningCount"];
        readonly heldSessionStates?: RunnerHeartbeatBody["heldSessionStates"];
        readonly mode?: RunnerHeartbeatBody["mode"];
      } = {},
    ) {
      return await accept(
        runApp(context)(runnersHeartbeatContract).heartbeat({
          headers: runnerHeaders(validAuth),
          body: runnerHeartbeatBody(args),
        }),
        statuses,
      );
    },

    async requestRawHeartbeatRunner(
      validAuth: boolean,
      statuses: readonly (200 | 400 | 401 | 500)[],
      body: unknown,
    ) {
      return await accept(
        runApp(context)(runnersHeartbeatContract).heartbeat({
          headers: runnerHeaders(validAuth),
          body: body as RunnerHeartbeatBody,
        }),
        statuses,
      );
    },

    async pollRunner(group?: string) {
      return await accept(
        runApp(context)(runnersPollContract).poll({
          headers: runnerHeaders(true),
          body: {
            group: group ?? "vm0/test",
            supportedProfiles: ["vm0/default"],
          },
        }),
        [200],
      );
    },

    async requestPollRunner(
      validAuth: boolean,
      body: RunnerPollBody,
      statuses: readonly (200 | 400 | 401 | 500)[],
    ) {
      return await accept(
        runApp(context)(runnersPollContract).poll({
          headers: runnerHeaders(validAuth),
          body,
        }),
        statuses,
      );
    },

    async requestRawPollRunner(
      validAuth: boolean,
      body: unknown,
      statuses: readonly (200 | 400 | 401 | 500)[],
    ) {
      return await accept(
        runApp(context)(runnersPollContract).poll({
          headers: runnerHeaders(validAuth),
          body: body as RunnerPollBody,
        }),
        statuses,
      );
    },

    async requestClaimRunnerJob(
      validAuth: boolean,
      runId: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 500)[],
      body: RunnerJobClaimRequest = {},
    ) {
      return await accept(
        runApp(context)(runnersJobClaimContract).claim({
          headers: runnerHeaders(validAuth),
          params: { id: runId },
          body,
        }),
        statuses,
      );
    },

    async requestRawClaimRunnerJob(
      validAuth: boolean,
      runId: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 500)[],
      body: unknown,
    ) {
      return await accept(
        runApp(context)(runnersJobClaimContract).claim({
          headers: runnerHeaders(validAuth),
          params: { id: runId },
          body: body as RunnerJobClaimRequest,
        }),
        statuses,
      );
    },

    async requestRunnerRealtimeToken(
      validAuth: boolean,
      body: RunnerRealtimeTokenBody,
      statuses: readonly (200 | 400 | 401 | 403 | 500)[],
    ) {
      return await accept(
        runApp(context)(runnerRealtimeTokenContract).create({
          headers: runnerHeaders(validAuth),
          body,
        }),
        statuses,
      );
    },

    // Valid cron coverage belongs in the file that owns each global sweep.
    // This helper only checks auth rejection, so route handlers never scan the
    // shared test database.
    async requestSharedCronRoutesWithoutAuth() {
      const headers = cronHeaders(false);
      const aggregateUsage = await accept(
        runApp(context)(cronAggregateUsageContract).aggregate({
          headers,
        }),
        [401],
      );
      const aggregateInsights = await accept(
        runApp(context)(cronAggregateInsightsContract).aggregate({
          headers,
        }),
        [401],
      );
      const processUsageEvents = await accept(
        runApp(context)(cronProcessUsageEventsContract).process({
          headers,
        }),
        [401],
      );
      const telegramCleanup = await accept(
        runApp(context)(cronTelegramCleanupContract).cleanup({
          headers,
        }),
        [401],
      );

      return {
        aggregateUsage,
        aggregateInsights,
        processUsageEvents,
        telegramCleanup,
      };
    },

    // Valid reconciliation coverage belongs in its owner file: the sweep
    // retrieves every org needing reconciliation, and stale orgs created by the
    // BILL-01 chains in run-lifecycle.bdd.test.ts must only be swept by that
    // file's own Stripe mocks.
    async reconcileBillingCron(validAuth: boolean) {
      return await accept(
        runApp(context)(cronReconcileBillingEntitlementsContract).reconcile({
          headers: cronHeaders(validAuth),
        }),
        [200, 401],
      );
    },
  };
}
