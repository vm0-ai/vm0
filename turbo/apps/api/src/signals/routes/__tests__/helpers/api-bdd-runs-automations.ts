import { randomUUID } from "node:crypto";

import type StripeSDK from "stripe";
import type { z } from "zod";
import {
  apiKeysByIdContract,
  apiKeysContract,
} from "@vm0/api-contracts/contracts/api-keys";
import { composesMainContract } from "@vm0/api-contracts/contracts/composes";
import { onboardingSetupContract } from "@vm0/api-contracts/contracts/onboarding";
import { runsMainContract } from "@vm0/api-contracts/contracts/runs";
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
  cronSummarizeMemoryContract,
  cronTelegramCleanupContract,
} from "@vm0/api-contracts/contracts/cron";
import {
  runnersConnectorNetworkPolicyContract,
  runnersHeartbeatContract,
  runnersJobClaimContract,
  runnersPollContract,
} from "@vm0/api-contracts/contracts/runners";
import {
  zeroRunsCancelContract,
  zeroRunContextContract,
  zeroRunRunnerContract,
  zeroRunsByIdContract,
  zeroRunsMainContract,
  zeroRunsQueueContract,
} from "@vm0/api-contracts/contracts/zero-runs";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";

import { createAppWithRoutes } from "../../../../app-factory-core";
import { setupAppWithRoutes } from "../../../../__tests__/test-app";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { mockEnv, mockOptionalEnv } from "../../../../lib/env";
import { now } from "../../../../lib/time";
import { generateSandboxToken } from "../../../auth/tokens";
import { mockStripeClient } from "../../../external/stripe-client";
import { agentComposesReadRoutes } from "../../agent-composes-read";
import { agentComposesRoutes } from "../../agent-composes";
import { agentRunsCreateRoutes } from "../../agent-runs-create";
import { agentRunsReadRoutes } from "../../agent-runs-read";
import { cronAggregateInsightsRoutes } from "../../cron-aggregate-insights";
import { cronAggregateUsageRoutes } from "../../cron-aggregate-usage";
import { cronProcessUsageEventsRoutes } from "../../cron-process-usage-events";
import { cronReconcileBillingEntitlementsRoutes } from "../../cron-reconcile-billing-entitlements";
import { cronSummarizeMemoryRoutes } from "../../cron-summarize-memory";
import { cronTelegramCleanupRoutes } from "../../cron-telegram-cleanup";
import { runnersRoutes } from "../../runners";
import { webhooksStripeRoutes } from "../../webhooks-stripe";
import { zeroAgentsRoutes } from "../../zero-agents";
import { zeroApiKeysDeleteRoutes } from "../../zero-api-keys-delete";
import { zeroApiKeysRoutes } from "../../zero-api-keys";
import { zeroBillingStatusRoutes } from "../../zero-billing-status";
import { zeroModelPoliciesRoutes } from "../../zero-model-policies";
import { zeroModelProvidersRoutes } from "../../zero-model-providers";
import { zeroOnboardingSetupRoutes } from "../../zero-onboarding-setup";
import { zeroRunDetailRoutes } from "../../zero-run-detail";
import { zeroRunsCancelRoutes } from "../../zero-runs-cancel";
import { zeroRunsRoutes } from "../../zero-runs";
import { zeroUserPermissionGrantsRoutes } from "../../zero-user-permission-grants";
import type { ApiTestUser } from "./api-bdd";
import { createZeroRouteMocks } from "./zero-route-test";

type AuthHeaders = { readonly authorization?: string };
type ZeroRunRequest = z.infer<(typeof zeroRunsMainContract.create)["body"]>;
type DirectRunRequest = z.infer<(typeof runsMainContract.create)["body"]>;
type RunsListQuery = z.input<(typeof runsMainContract.list)["query"]>;
type RunnerJobClaimRequest = z.infer<
  (typeof runnersJobClaimContract.claim)["body"]
>;
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

const runsAutomationRoutes = [
  ...zeroApiKeysRoutes,
  ...zeroApiKeysDeleteRoutes,
  ...agentComposesRoutes,
  ...agentComposesReadRoutes,
  ...cronAggregateInsightsRoutes,
  ...cronAggregateUsageRoutes,
  ...cronProcessUsageEventsRoutes,
  ...cronReconcileBillingEntitlementsRoutes,
  ...cronSummarizeMemoryRoutes,
  ...cronTelegramCleanupRoutes,
  ...zeroOnboardingSetupRoutes,
  ...runnersRoutes,
  ...agentRunsCreateRoutes,
  ...agentRunsReadRoutes,
  ...webhooksStripeRoutes,
  ...zeroBillingStatusRoutes,
  ...zeroModelPoliciesRoutes,
  ...zeroModelProvidersRoutes,
  ...zeroRunDetailRoutes,
  ...zeroRunsRoutes,
  ...zeroRunsCancelRoutes,
  ...zeroAgentsRoutes,
  ...zeroUserPermissionGrantsRoutes,
] as const;

function runsAutomationApp(context: TestContext) {
  return setupAppWithRoutes({ context, routes: runsAutomationRoutes });
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
    readonly profiles?: RunnerHeartbeatBody["profiles"];
    readonly admittableProfiles?: RunnerHeartbeatBody["admittableProfiles"];
    readonly omitAdmittableProfiles?: boolean;
    readonly availableProfiles?: RunnerHeartbeatBody["availableProfiles"];
    readonly omitAvailableProfiles?: boolean;
    readonly maxConcurrent?: RunnerHeartbeatBody["maxConcurrent"];
    readonly allocatedVcpu?: RunnerHeartbeatBody["allocatedVcpu"];
    readonly allocatedMemoryMb?: RunnerHeartbeatBody["allocatedMemoryMb"];
    readonly runningCount?: RunnerHeartbeatBody["runningCount"];
    readonly heldSessionStates?: RunnerHeartbeatBody["heldSessionStates"];
    readonly mode?: RunnerHeartbeatBody["mode"];
  } = {},
): RunnerHeartbeatBody {
  const profiles = args.profiles ?? ["vm0/default"];
  const body: RunnerHeartbeatBody = {
    runnerId: args.runnerId ?? randomUUID(),
    runnerName: "bdd-runner",
    group: args.group ?? "vm0/test",
    profiles,
    totalVcpu: 8,
    totalMemoryMb: 16_384,
    maxConcurrent: args.maxConcurrent ?? 2,
    allocatedVcpu: args.allocatedVcpu ?? 0,
    allocatedMemoryMb: args.allocatedMemoryMb ?? 0,
    runningCount: args.runningCount ?? 0,
    heldSessionStates: args.heldSessionStates ?? [],
    mode: args.mode ?? "running",
  };
  if (!args.omitAdmittableProfiles) {
    body.admittableProfiles =
      args.admittableProfiles ?? args.availableProfiles ?? profiles;
  }
  if (!args.omitAvailableProfiles) {
    body.availableProfiles = args.availableProfiles ?? profiles;
  }
  return body;
}

export function createRunsAutomationsApi(context: TestContext) {
  const applyUserPermissionGrantRequestBody = (
    body: {
      readonly agentId: string;
      readonly connectorRef: string;
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
      connectorRef: body.connectorRef,
      mode: "patch",
      grants: [grant],
    };
  };

  return {
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

      await accept(
        runsAutomationApp(context)(onboardingSetupContract).setup({
          headers: authenticate(context, actor),
          body: { displayName: "BDD Entitled Agent" },
        }),
        [200, 409],
      );

      const suffix = randomUUID().slice(0, 8);
      const customerId = `cus_bdd_${suffix}`;
      const subscriptionId = `sub_bdd_${suffix}`;
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
        items: { data: [{ price: { id: "price_bdd_pro" } }] },
      });
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
        runsAutomationApp(context)(webhookStripeContract).post({
          body: JSON.stringify(invoicePaidEvent),
          extraHeaders: { "stripe-signature": "t=1,v1=bdd" },
        }),
        [200],
      );

      const billingStatus = await accept(
        runsAutomationApp(context)(zeroBillingStatusContract).get({
          headers: authenticate(context, actor),
        }),
        [200],
      );
      if (billingStatus.body.tier !== "pro") {
        throw new Error(
          `Entitlement grant did not reach pro tier: ${billingStatus.body.tier}`,
        );
      }
      return { customerId, subscriptionId, invoiceId };
    },

    async createRun(actor: ApiTestUser, body: ZeroRunRequest) {
      const response = await accept(
        runsAutomationApp(context)(zeroRunsMainContract).create({
          headers: authenticate(context, actor),
          body,
        }),
        [201],
      );
      return response.body;
    },

    async claimRunnerJob(runId: string, body: RunnerJobClaimRequest = {}) {
      const response = await accept(
        runsAutomationApp(context)(runnersJobClaimContract).claim({
          headers: runnerHeaders(true),
          params: { id: runId },
          body,
        }),
        [200],
      );
      return response.body;
    },

    async refreshRunnerNetworkPolicy(runId: string, connectorRef: string) {
      const response = await accept(
        runsAutomationApp(context)(
          runnersConnectorNetworkPolicyContract,
        ).refresh({
          headers: runnerHeaders(true),
          params: { runId },
          body: { connectorRefs: [connectorRef] },
        }),
        [200],
      );
      const [refresh] = response.body.refreshes;
      if (!refresh) {
        throw new Error(
          `Expected refreshed network policy for ${connectorRef}`,
        );
      }
      return refresh;
    },

    async requestRefreshRunnerNetworkPolicyAs(
      authorization: string | undefined,
      runId: string,
      connectorRef: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 500)[],
    ) {
      return await accept(
        runsAutomationApp(context)(
          runnersConnectorNetworkPolicyContract,
        ).refresh({
          headers: authorization === undefined ? {} : { authorization },
          params: { runId },
          body: { connectorRefs: [connectorRef] },
        }),
        statuses,
      );
    },

    async createApiKey(actor: ApiTestUser): Promise<{
      readonly id: string;
      readonly token: string;
    }> {
      const response = await accept(
        runsAutomationApp(context)(apiKeysContract).create({
          headers: authenticate(context, actor),
          body: {
            name: `bdd-runner-key-${randomUUID().slice(0, 8)}`,
            expiresInDays: 30,
          },
        }),
        [201],
      );
      return { id: response.body.id, token: response.body.token };
    },

    async revokeApiKey(actor: ApiTestUser, id: string): Promise<void> {
      await accept(
        runsAutomationApp(context)(apiKeysByIdContract).delete({
          headers: authenticate(context, actor),
          params: { id },
        }),
        [204],
      );
    },

    async requestPollRunnerAs(
      authorization: string | undefined,
      body: RunnerPollBody,
      statuses: readonly (200 | 400 | 401 | 500)[],
    ) {
      return await accept(
        runsAutomationApp(context)(runnersPollContract).poll({
          headers: authorization === undefined ? {} : { authorization },
          body,
        }),
        statuses,
      );
    },

    async requestClaimRunnerJobAs(
      authorization: string | undefined,
      runId: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 409 | 500)[],
      body: z.infer<(typeof runnersJobClaimContract.claim)["body"]> = {},
    ) {
      return await accept(
        runsAutomationApp(context)(runnersJobClaimContract).claim({
          headers: authorization === undefined ? {} : { authorization },
          params: { id: runId },
          body,
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
        runsAutomationApp(context)(runnerRealtimeTokenContract).create({
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

    async createCompose(
      actor: ApiTestUser,
      content: ComposeContent,
    ): Promise<{ readonly composeId: string; readonly name: string }> {
      const response = await accept(
        runsAutomationApp(context)(composesMainContract).create({
          headers: authenticate(context, actor),
          body: { content },
        }),
        [200, 201],
      );
      return { composeId: response.body.composeId, name: response.body.name };
    },

    async createDirectRun(actor: ApiTestUser, body: DirectRunRequest) {
      const response = await accept(
        runsAutomationApp(context)(runsMainContract).create({
          headers: authenticate(context, actor),
          body,
        }),
        [201],
      );
      return response.body;
    },

    async requestDirectRun(
      actor: ApiTestUser | null,
      body: DirectRunRequest,
      statuses: readonly (201 | 400 | 401 | 402 | 403 | 404 | 429 | 503)[],
    ) {
      return await accept(
        runsAutomationApp(context)(runsMainContract).create({
          headers: authenticate(context, actor),
          body,
        }),
        statuses,
      );
    },

    async listAgentRuns(actor: ApiTestUser, query: RunsListQuery) {
      const response = await accept(
        runsAutomationApp(context)(runsMainContract).list({
          headers: authenticate(context, actor),
          query,
        }),
        [200],
      );
      return response.body;
    },

    async applyUserPermissionGrant(
      actor: ApiTestUser,
      body: {
        readonly agentId: string;
        readonly connectorRef: string;
      } & ApplyUserPermissionGrant,
    ): Promise<UserPermissionGrantResponse> {
      const response = await accept(
        runsAutomationApp(context)(zeroUserPermissionGrantsContract).apply({
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
        readonly connectorRef: string;
      } & ApplyUserPermissionGrant,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 500)[],
    ) {
      return await accept(
        runsAutomationApp(context)(zeroUserPermissionGrantsContract).apply({
          headers: authenticate(context, actor),
          body: applyUserPermissionGrantRequestBody(body),
        }),
        statuses,
      );
    },

    async listUserPermissionGrants(
      actor: ApiTestUser,
      agentId: string,
    ): Promise<readonly UserPermissionGrantResponse[]> {
      const response = await accept(
        runsAutomationApp(context)(zeroUserPermissionGrantsContract).list({
          headers: authenticate(context, actor),
          query: { agentId },
        }),
        [200],
      );
      return response.body;
    },

    enableAutomations(
      _actor: ApiTestUser,
      _options: { readonly webhookTriggers?: boolean } = {},
    ): Promise<void> {
      return Promise.resolve();
    },

    /**
     * Replaces the caller's enabled connector types for an agent through
     * PUT /api/zero/agents/:id/user-connectors and returns the visible set.
     */
    async enableAgentConnectors(
      actor: ApiTestUser,
      agentId: string,
      connectorTypes: readonly string[],
    ): Promise<readonly string[]> {
      const response = await accept(
        runsAutomationApp(context)(zeroUserConnectorsContract).update({
          headers: authenticate(context, actor),
          params: { id: agentId },
          body: { enabledTypes: [...connectorTypes] },
        }),
        [200],
      );
      return response.body.enabledTypes;
    },

    async listOrgModelProviders(
      actor: ApiTestUser,
    ): Promise<readonly ModelProviderResponse[]> {
      const response = await accept(
        runsAutomationApp(context)(zeroModelProvidersMainContract).list({
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
        runsAutomationApp(context)(zeroModelProvidersMainContract).upsert({
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
        runsAutomationApp(context)(zeroModelPoliciesMainContract).update({
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
        runsAutomationApp(context)(zeroModelProvidersMainContract).upsert({
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
        runsAutomationApp(context)(zeroModelPoliciesMainContract).update({
          headers: authenticate(context, actor),
          body: { policies },
        }),
        [200],
      );

      return { providerId };
    },

    async readBillingStatus(actor: ApiTestUser) {
      const response = await accept(
        runsAutomationApp(context)(zeroBillingStatusContract).get({
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
    ) {
      return await accept(
        runsAutomationApp(context)(zeroRunsMainContract).create({
          headers: authenticate(context, actor),
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
        runsAutomationApp(context)(zeroRunsMainContract).create({
          headers: authenticate(context, actor),
          body: body as ZeroRunRequest,
        }),
        statuses,
      );
    },

    /**
     * Creates a zero run with a raw bearer credential (run-scoped zero token
     * or sandbox token taken from a runner claim) instead of a Clerk session.
     */
    async requestCreateRunAs(
      authorization: string,
      body: ZeroRunRequest,
      statuses: readonly (201 | 400 | 401 | 402 | 403 | 404 | 429 | 503)[],
    ) {
      return await accept(
        runsAutomationApp(context)(zeroRunsMainContract).create({
          headers: { authorization },
          body,
        }),
        statuses,
      );
    },

    async readRun(actor: ApiTestUser, runId: string) {
      const response = await accept(
        runsAutomationApp(context)(zeroRunsByIdContract).getById({
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
        runsAutomationApp(context)(zeroRunsByIdContract).getById({
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
        runsAutomationApp(context)(zeroRunContextContract).getContext({
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
        runsAutomationApp(context)(zeroRunRunnerContract).getRunner({
          headers: authenticate(context, actor),
          params: { id: runId },
        }),
        statuses,
      );
    },

    async readRunQueue(actor: ApiTestUser) {
      return await accept(
        runsAutomationApp(context)(zeroRunsQueueContract).getQueue({
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
        runsAutomationApp(context)(zeroRunsQueueContract).getQueue({
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
        runsAutomationApp(context)(zeroRunsCancelContract).cancel({
          headers: authenticate(context, actor),
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
        routes: runsAutomationRoutes,
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
        runsAutomationApp(context)(runnersHeartbeatContract).heartbeat({
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
        readonly group?: string;
        readonly profiles?: RunnerHeartbeatBody["profiles"];
        readonly admittableProfiles?: RunnerHeartbeatBody["admittableProfiles"];
        readonly omitAdmittableProfiles?: boolean;
        readonly availableProfiles?: RunnerHeartbeatBody["availableProfiles"];
        readonly omitAvailableProfiles?: boolean;
        readonly maxConcurrent?: RunnerHeartbeatBody["maxConcurrent"];
        readonly allocatedVcpu?: RunnerHeartbeatBody["allocatedVcpu"];
        readonly allocatedMemoryMb?: RunnerHeartbeatBody["allocatedMemoryMb"];
        readonly runningCount?: RunnerHeartbeatBody["runningCount"];
        readonly heldSessionStates?: RunnerHeartbeatBody["heldSessionStates"];
        readonly mode?: RunnerHeartbeatBody["mode"];
      } = {},
    ) {
      return await accept(
        runsAutomationApp(context)(runnersHeartbeatContract).heartbeat({
          headers: runnerHeaders(validAuth),
          body: runnerHeartbeatBody(args),
        }),
        statuses,
      );
    },

    async pollRunner(group?: string) {
      return await accept(
        runsAutomationApp(context)(runnersPollContract).poll({
          headers: runnerHeaders(true),
          body: {
            group: group ?? "vm0/test",
            supportedProfiles: ["vm0/default"],
            profiles: ["vm0/default"],
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
        runsAutomationApp(context)(runnersPollContract).poll({
          headers: runnerHeaders(validAuth),
          body,
        }),
        statuses,
      );
    },

    async requestClaimRunnerJob(
      validAuth: boolean,
      runId: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 409 | 500)[],
      body: RunnerJobClaimRequest = {},
    ) {
      return await accept(
        runsAutomationApp(context)(runnersJobClaimContract).claim({
          headers: runnerHeaders(validAuth),
          params: { id: runId },
          body,
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
        runsAutomationApp(context)(runnerRealtimeTokenContract).create({
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
        runsAutomationApp(context)(cronAggregateUsageContract).aggregate({
          headers,
        }),
        [401],
      );
      const aggregateInsights = await accept(
        runsAutomationApp(context)(cronAggregateInsightsContract).aggregate({
          headers,
        }),
        [401],
      );
      const processUsageEvents = await accept(
        runsAutomationApp(context)(cronProcessUsageEventsContract).process({
          headers,
        }),
        [401],
      );
      const summarizeMemory = await accept(
        runsAutomationApp(context)(cronSummarizeMemoryContract).summarize({
          headers,
        }),
        [401],
      );
      const telegramCleanup = await accept(
        runsAutomationApp(context)(cronTelegramCleanupContract).cleanup({
          headers,
        }),
        [401],
      );

      return {
        aggregateUsage,
        aggregateInsights,
        processUsageEvents,
        summarizeMemory,
        telegramCleanup,
      };
    },

    // Valid reconciliation coverage belongs in its owner file: the sweep
    // retrieves every org needing reconciliation, and stale orgs created by the
    // BILL-01 chains in run-lifecycle.bdd.test.ts must only be swept by that
    // file's own Stripe mocks.
    async reconcileBillingCron(validAuth: boolean) {
      return await accept(
        runsAutomationApp(context)(
          cronReconcileBillingEntitlementsContract,
        ).reconcile({
          headers: cronHeaders(validAuth),
        }),
        [200, 401],
      );
    },
  };
}
