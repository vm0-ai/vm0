import { createHmac, randomUUID } from "node:crypto";

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
  type UpsertUserPermissionGrantRequest,
  type UserPermissionGrantResponse,
} from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import {
  automationRunContract,
  automationsByNameContract,
  automationsEnableContract,
  automationsMainContract,
  type AutomationListResponse,
  type AutomationMutationResponse,
  type AutomationResponse,
} from "@vm0/api-contracts/contracts/automations";
import {
  webhookAutomationsByIdContract,
  webhookAutomationsMainContract,
  type WebhookAutomationCreateResponse,
  type WebhookAutomationListResponse,
} from "@vm0/api-contracts/contracts/webhook-automations";
import { runnerRealtimeTokenContract } from "@vm0/api-contracts/contracts/realtime";
import { zeroModelPoliciesMainContract } from "@vm0/api-contracts/contracts/zero-model-policies";
import { zeroModelProvidersMainContract } from "@vm0/api-contracts/contracts/zero-model-providers";
import {
  cronAggregateInsightsContract,
  cronAggregateUsageContract,
  cronCleanupSandboxesContract,
  cronExecuteSchedulesContract,
  cronProcessUsageEventsContract,
  cronReconcileBillingEntitlementsContract,
  cronSummarizeMemoryContract,
  cronTelegramCleanupContract,
} from "@vm0/api-contracts/contracts/cron";
import {
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
import {
  zeroScheduleRunContract,
  zeroSchedulesByNameContract,
  zeroSchedulesEnableContract,
  zeroSchedulesMainContract,
  type DeployScheduleResponse,
  type ScheduleListResponse,
  type ScheduleResponse,
} from "@vm0/api-contracts/contracts/zero-schedules";
import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

import { createApp } from "../../../../app-factory";
import { mockEnv, mockOptionalEnv } from "../../../../lib/env";
import { now } from "../../../../lib/time";
import {
  accept,
  setupApp,
  type TestContext,
} from "../../../../__tests__/test-helpers";
import { generateSandboxToken } from "../../../auth/tokens";
import { mockStripeClient } from "../../../external/stripe-client";
import type { ApiTestUser } from "./api-bdd";
import { createZeroRouteMocks } from "./zero-route-test";

type AuthHeaders = { readonly authorization?: string };
type ZeroRunRequest = z.infer<(typeof zeroRunsMainContract.create)["body"]>;
type DirectRunRequest = z.infer<(typeof runsMainContract.create)["body"]>;
type ComposeContent = z.infer<
  (typeof composesMainContract.create)["body"]
>["content"];
type CreateAutomationRequest = z.infer<
  (typeof automationsMainContract.create)["body"]
>;
type UpdateAutomationRequest = z.infer<
  (typeof automationsByNameContract.update)["body"]
>;
type CreateWebhookAutomationRequest = z.infer<
  (typeof webhookAutomationsMainContract.create)["body"]
>;
type DeployScheduleRequest = z.infer<
  (typeof zeroSchedulesMainContract.deploy)["body"]
>;
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
    readonly heldSessionStates?: RunnerHeartbeatBody["heldSessionStates"];
  } = {},
): RunnerHeartbeatBody {
  return {
    runnerId: args.runnerId ?? randomUUID(),
    runnerName: "bdd-runner",
    group: args.group ?? "vm0/test",
    profiles: ["vm0/default"],
    totalVcpu: 8,
    totalMemoryMb: 16_384,
    maxConcurrent: 2,
    allocatedVcpu: 0,
    allocatedMemoryMb: 0,
    runningCount: 0,
    heldSessionStates: args.heldSessionStates ?? [],
    mode: "running",
  };
}

export function createRunsSchedulesApi(context: TestContext) {
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
      options: { readonly periodEndUnix?: number } = {},
    ): Promise<{
      readonly customerId: string;
      readonly subscriptionId: string;
      readonly invoiceId: string;
    }> {
      mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
      mockEnv(
        "ZERO_PRICE",
        JSON.stringify({ pro: ["price_bdd_pro"], team: ["price_bdd_team"] }),
      );
      mockOptionalEnv("STRIPE_WEBHOOK_SECRET", "whsec_bdd_stripe");

      await accept(
        setupApp({ context })(onboardingSetupContract).setup({
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
        cancel_at: null,
        schedule: null,
        trial_end: null,
        metadata: {},
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
        setupApp({ context })(webhookStripeContract).post({
          body: JSON.stringify(invoicePaidEvent),
          extraHeaders: { "stripe-signature": "t=1,v1=bdd" },
        }),
        [200],
      );

      const billingStatus = await accept(
        setupApp({ context })(zeroBillingStatusContract).get({
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
        setupApp({ context })(zeroRunsMainContract).create({
          headers: authenticate(context, actor),
          body,
        }),
        [201],
      );
      return response.body;
    },

    async claimRunnerJob(runId: string) {
      const response = await accept(
        setupApp({ context })(runnersJobClaimContract).claim({
          headers: runnerHeaders(true),
          params: { id: runId },
          body: {},
        }),
        [200],
      );
      return response.body;
    },

    async createApiKey(actor: ApiTestUser): Promise<{
      readonly id: string;
      readonly token: string;
    }> {
      const response = await accept(
        setupApp({ context })(apiKeysContract).create({
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
        setupApp({ context })(apiKeysByIdContract).delete({
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
        setupApp({ context })(runnersPollContract).poll({
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
        setupApp({ context })(runnersJobClaimContract).claim({
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
        setupApp({ context })(runnerRealtimeTokenContract).create({
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
        setupApp({ context })(composesMainContract).create({
          headers: authenticate(context, actor),
          body: { content },
        }),
        [200, 201],
      );
      return { composeId: response.body.composeId, name: response.body.name };
    },

    async createDirectRun(actor: ApiTestUser, body: DirectRunRequest) {
      const response = await accept(
        setupApp({ context })(runsMainContract).create({
          headers: authenticate(context, actor),
          body,
        }),
        [201],
      );
      return response.body;
    },

    async upsertUserPermissionGrant(
      actor: ApiTestUser,
      body: UpsertUserPermissionGrantRequest,
    ): Promise<UserPermissionGrantResponse> {
      const response = await accept(
        setupApp({ context })(zeroUserPermissionGrantsContract).upsert({
          headers: authenticate(context, actor),
          body,
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
        setupApp({ context })(zeroUserPermissionGrantsContract).list({
          headers: authenticate(context, actor),
          query: { agentId },
        }),
        [200],
      );
      return response.body;
    },

    async enableAutomations(actor: ApiTestUser): Promise<void> {
      await accept(
        setupApp({ context })(zeroFeatureSwitchesContract).update({
          headers: authenticate(context, actor),
          body: { switches: { [FeatureSwitchKey.ZeroAutomations]: true } },
        }),
        [200],
      );
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
        setupApp({ context })(zeroUserConnectorsContract).update({
          headers: authenticate(context, actor),
          params: { id: agentId },
          body: { enabledTypes: [...connectorTypes] },
        }),
        [200],
      );
      return response.body.enabledTypes;
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
        setupApp({ context })(zeroModelProvidersMainContract).upsert({
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
        setupApp({ context })(zeroModelPoliciesMainContract).update({
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
        setupApp({ context })(zeroModelProvidersMainContract).upsert({
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
        setupApp({ context })(zeroModelPoliciesMainContract).update({
          headers: authenticate(context, actor),
          body: { policies },
        }),
        [200],
      );

      return { providerId };
    },

    async requestCreateRun(
      actor: ApiTestUser | null,
      body: ZeroRunRequest,
      statuses: readonly (201 | 400 | 401 | 402 | 403 | 404 | 429 | 503)[],
    ) {
      return await accept(
        setupApp({ context })(zeroRunsMainContract).create({
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
        setupApp({ context })(zeroRunsMainContract).create({
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
        setupApp({ context })(zeroRunsMainContract).create({
          headers: { authorization },
          body,
        }),
        statuses,
      );
    },

    async readRun(actor: ApiTestUser, runId: string) {
      const response = await accept(
        setupApp({ context })(zeroRunsByIdContract).getById({
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
        setupApp({ context })(zeroRunsByIdContract).getById({
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
        setupApp({ context })(zeroRunContextContract).getContext({
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
        setupApp({ context })(zeroRunRunnerContract).getRunner({
          headers: authenticate(context, actor),
          params: { id: runId },
        }),
        statuses,
      );
    },

    async readRunQueue(actor: ApiTestUser) {
      return await accept(
        setupApp({ context })(zeroRunsQueueContract).getQueue({
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
        setupApp({ context })(zeroRunsQueueContract).getQueue({
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
        setupApp({ context })(zeroRunsCancelContract).cancel({
          headers: authenticate(context, actor),
          params: { id: runId },
        }),
        statuses,
      );
    },

    async heartbeatRunner(group?: string) {
      return await accept(
        setupApp({ context })(runnersHeartbeatContract).heartbeat({
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
        readonly heldSessionStates?: RunnerHeartbeatBody["heldSessionStates"];
      } = {},
    ) {
      return await accept(
        setupApp({ context })(runnersHeartbeatContract).heartbeat({
          headers: runnerHeaders(validAuth),
          body: runnerHeartbeatBody(args),
        }),
        statuses,
      );
    },

    async pollRunner(group?: string) {
      return await accept(
        setupApp({ context })(runnersPollContract).poll({
          headers: runnerHeaders(true),
          body: { group: group ?? "vm0/test", profiles: ["vm0/default"] },
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
        setupApp({ context })(runnersPollContract).poll({
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
    ) {
      return await accept(
        setupApp({ context })(runnersJobClaimContract).claim({
          headers: runnerHeaders(validAuth),
          params: { id: runId },
          body: {},
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
        setupApp({ context })(runnerRealtimeTokenContract).create({
          headers: runnerHeaders(validAuth),
          body,
        }),
        statuses,
      );
    },

    async createAutomation(
      actor: ApiTestUser,
      body: CreateAutomationRequest,
    ): Promise<AutomationMutationResponse> {
      const response = await accept(
        setupApp({ context })(automationsMainContract).create({
          headers: authenticate(context, actor),
          body,
        }),
        [200, 201],
      );
      return response.body;
    },

    async requestCreateAutomationUnchecked(
      actor: ApiTestUser | null,
      body: unknown,
      statuses: readonly (200 | 201 | 400 | 401 | 403 | 404)[],
    ) {
      return await accept(
        setupApp({ context })(automationsMainContract).create({
          headers: authenticate(context, actor),
          body: body as CreateAutomationRequest,
        }),
        statuses,
      );
    },

    async listAutomations(actor: ApiTestUser): Promise<AutomationListResponse> {
      const response = await accept(
        setupApp({ context })(automationsMainContract).list({
          headers: authenticate(context, actor),
        }),
        [200],
      );
      return response.body;
    },

    async requestListAutomations(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 403)[],
    ) {
      return await accept(
        setupApp({ context })(automationsMainContract).list({
          headers: authenticate(context, actor),
        }),
        statuses,
      );
    },

    async updateAutomation(
      actor: ApiTestUser,
      name: string,
      body: UpdateAutomationRequest,
    ): Promise<AutomationMutationResponse> {
      const response = await accept(
        setupApp({ context })(automationsByNameContract).update({
          headers: authenticate(context, actor),
          params: { name },
          body,
        }),
        [200, 201],
      );
      return response.body;
    },

    async enableAutomation(
      actor: ApiTestUser,
      automation: Pick<AutomationResponse, "agentId" | "name">,
    ): Promise<AutomationResponse> {
      const response = await accept(
        setupApp({ context })(automationsEnableContract).enable({
          headers: authenticate(context, actor),
          params: { name: automation.name },
          body: { agentId: automation.agentId },
        }),
        [200],
      );
      return response.body;
    },

    async disableAutomation(
      actor: ApiTestUser,
      automation: Pick<AutomationResponse, "agentId" | "name">,
    ): Promise<AutomationResponse> {
      const response = await accept(
        setupApp({ context })(automationsEnableContract).disable({
          headers: authenticate(context, actor),
          params: { name: automation.name },
          body: { agentId: automation.agentId },
        }),
        [200],
      );
      return response.body;
    },

    async requestRunAutomation(
      actor: ApiTestUser | null,
      automationId: string,
      statuses: readonly (
        | 201
        | 400
        | 401
        | 402
        | 403
        | 404
        | 409
        | 429
        | 503
      )[],
    ) {
      return await accept(
        setupApp({ context })(automationRunContract).run({
          headers: authenticate(context, actor),
          body: { automationId },
        }),
        statuses,
      );
    },

    async deleteAutomation(
      actor: ApiTestUser,
      automation: Pick<AutomationResponse, "agentId" | "name">,
    ): Promise<void> {
      await accept(
        setupApp({ context })(automationsByNameContract).delete({
          headers: authenticate(context, actor),
          params: { name: automation.name },
          query: { agentId: automation.agentId },
        }),
        [204],
      );
    },

    async requestDeleteAutomation(
      actor: ApiTestUser | null,
      automation: Pick<AutomationResponse, "agentId" | "name">,
      statuses: readonly (204 | 400 | 401 | 403 | 404)[],
    ) {
      return await accept(
        setupApp({ context })(automationsByNameContract).delete({
          headers: authenticate(context, actor),
          params: { name: automation.name },
          query: { agentId: automation.agentId },
        }),
        statuses,
      );
    },

    async requestUpdateAutomationUnchecked(
      actor: ApiTestUser | null,
      name: string,
      body: unknown,
      statuses: readonly (200 | 201 | 400 | 401 | 403 | 404)[],
    ) {
      return await accept(
        setupApp({ context })(automationsByNameContract).update({
          headers: authenticate(context, actor),
          params: { name },
          body: body as UpdateAutomationRequest,
        }),
        statuses,
      );
    },

    async requestEnableAutomation(
      actor: ApiTestUser | null,
      automation: Pick<AutomationResponse, "agentId" | "name">,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      return await accept(
        setupApp({ context })(automationsEnableContract).enable({
          headers: authenticate(context, actor),
          params: { name: automation.name },
          body: { agentId: automation.agentId },
        }),
        statuses,
      );
    },

    async requestDisableAutomation(
      actor: ApiTestUser | null,
      automation: Pick<AutomationResponse, "agentId" | "name">,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      return await accept(
        setupApp({ context })(automationsEnableContract).disable({
          headers: authenticate(context, actor),
          params: { name: automation.name },
          body: { agentId: automation.agentId },
        }),
        statuses,
      );
    },

    // The automations list contract has no 404 response (the feature gate is
    // meant to be indistinguishable from an unmounted route), so the ts-rest
    // client with throwOnUnknownStatus cannot express the gated case — read
    // the route through a raw app request instead.
    async requestListAutomationsRaw(
      actor: ApiTestUser,
    ): Promise<{ readonly status: number; readonly body: unknown }> {
      const { authorization } = authenticate(context, actor);
      const app = createApp({ signal: context.signal });
      const response = await app.request("/api/automations", {
        method: "GET",
        headers: authorization === undefined ? {} : { authorization },
      });
      const body: unknown = await response.json();
      return { status: response.status, body };
    },

    async createWebhookAutomation(
      actor: ApiTestUser,
      body: CreateWebhookAutomationRequest,
    ): Promise<WebhookAutomationCreateResponse> {
      const response = await accept(
        setupApp({ context })(webhookAutomationsMainContract).create({
          headers: authenticate(context, actor),
          body,
        }),
        [201],
      );
      return response.body;
    },

    async requestCreateWebhookAutomationUnchecked(
      actor: ApiTestUser | null,
      body: unknown,
      statuses: readonly (201 | 400 | 401 | 403 | 404)[],
    ) {
      return await accept(
        setupApp({ context })(webhookAutomationsMainContract).create({
          headers: authenticate(context, actor),
          body: body as CreateWebhookAutomationRequest,
        }),
        statuses,
      );
    },

    async listWebhookAutomations(
      actor: ApiTestUser,
    ): Promise<WebhookAutomationListResponse> {
      const response = await accept(
        setupApp({ context })(webhookAutomationsMainContract).list({
          headers: authenticate(context, actor),
        }),
        [200],
      );
      return response.body;
    },

    async requestListWebhookAutomations(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      return await accept(
        setupApp({ context })(webhookAutomationsMainContract).list({
          headers: authenticate(context, actor),
        }),
        statuses,
      );
    },

    async deleteWebhookAutomation(
      actor: ApiTestUser,
      id: string,
    ): Promise<void> {
      await accept(
        setupApp({ context })(webhookAutomationsByIdContract).delete({
          headers: authenticate(context, actor),
          params: { id },
        }),
        [204],
      );
    },

    async requestDeleteWebhookAutomation(
      actor: ApiTestUser | null,
      id: string,
      statuses: readonly (204 | 400 | 401 | 403 | 404)[],
    ) {
      return await accept(
        setupApp({ context })(webhookAutomationsByIdContract).delete({
          headers: authenticate(context, actor),
          params: { id },
        }),
        statuses,
      );
    },

    // Inbound signed webhook POST. The route verifies an HMAC over the exact
    // bytes received, so this goes through a raw app request: the ts-rest
    // client JSON-stringifies string bodies, which would double-encode the
    // payload and break both the signature and the payload render into the
    // run context (same pattern as the GitHub webhook helper in
    // api-bdd-webhooks.ts).
    async postAutomationWebhook(
      token: string,
      rawBody: string,
      opts: {
        readonly signature?: string;
        readonly extraHeaders?: Record<string, string>;
      } = {},
    ): Promise<{ readonly status: number; readonly body: unknown }> {
      const app = createApp({ signal: context.signal });
      const response = await app.request(`/api/automations/webhooks/${token}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(opts.signature === undefined
            ? {}
            : { "x-vm0-signature-256": opts.signature }),
          ...opts.extraHeaders,
        },
        body: rawBody,
      });
      const contentType = response.headers.get("content-type") ?? "";
      const body: unknown = contentType.includes("application/json")
        ? await response.json()
        : await response.text();
      return { status: response.status, body };
    },

    async deploySchedule(
      actor: ApiTestUser,
      body: DeployScheduleRequest,
    ): Promise<DeployScheduleResponse> {
      const response = await accept(
        setupApp({ context })(zeroSchedulesMainContract).deploy({
          headers: authenticate(context, actor),
          body,
        }),
        [200, 201],
      );
      return response.body;
    },

    async requestDeployScheduleUnchecked(
      actor: ApiTestUser | null,
      body: unknown,
      statuses: readonly (200 | 201 | 400 | 401 | 403 | 404)[],
    ) {
      return await accept(
        setupApp({ context })(zeroSchedulesMainContract).deploy({
          headers: authenticate(context, actor),
          body: body as DeployScheduleRequest,
        }),
        statuses,
      );
    },

    async listSchedules(actor: ApiTestUser): Promise<ScheduleListResponse> {
      const response = await accept(
        setupApp({ context })(zeroSchedulesMainContract).list({
          headers: authenticate(context, actor),
        }),
        [200],
      );
      return response.body;
    },

    async requestListSchedules(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 403)[],
    ) {
      return await accept(
        setupApp({ context })(zeroSchedulesMainContract).list({
          headers: authenticate(context, actor),
        }),
        statuses,
      );
    },

    async enableSchedule(
      actor: ApiTestUser,
      schedule: Pick<ScheduleResponse, "agentId" | "name">,
    ): Promise<ScheduleResponse> {
      const response = await accept(
        setupApp({ context })(zeroSchedulesEnableContract).enable({
          headers: authenticate(context, actor),
          params: { name: schedule.name },
          body: { agentId: schedule.agentId },
        }),
        [200],
      );
      return response.body;
    },

    async disableSchedule(
      actor: ApiTestUser,
      schedule: Pick<ScheduleResponse, "agentId" | "name">,
    ): Promise<ScheduleResponse> {
      const response = await accept(
        setupApp({ context })(zeroSchedulesEnableContract).disable({
          headers: authenticate(context, actor),
          params: { name: schedule.name },
          body: { agentId: schedule.agentId },
        }),
        [200],
      );
      return response.body;
    },

    async requestEnableSchedule(
      actor: ApiTestUser | null,
      schedule: Pick<ScheduleResponse, "agentId" | "name">,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      return await accept(
        setupApp({ context })(zeroSchedulesEnableContract).enable({
          headers: authenticate(context, actor),
          params: { name: schedule.name },
          body: { agentId: schedule.agentId },
        }),
        statuses,
      );
    },

    async runScheduleNow(
      actor: ApiTestUser,
      scheduleId: string,
      statuses: readonly (
        | 201
        | 400
        | 401
        | 402
        | 403
        | 404
        | 409
        | 429
        | 503
      )[],
    ) {
      return await accept(
        setupApp({ context })(zeroScheduleRunContract).run({
          headers: authenticate(context, actor),
          body: { scheduleId },
        }),
        statuses,
      );
    },

    async deleteSchedule(
      actor: ApiTestUser,
      schedule: Pick<ScheduleResponse, "agentId" | "name">,
    ): Promise<void> {
      await accept(
        setupApp({ context })(zeroSchedulesByNameContract).delete({
          headers: authenticate(context, actor),
          params: { name: schedule.name },
          query: { agentId: schedule.agentId },
        }),
        [204],
      );
    },

    async requestDeleteSchedule(
      actor: ApiTestUser | null,
      schedule: Pick<ScheduleResponse, "agentId" | "name">,
      statuses: readonly (204 | 400 | 401 | 403 | 404)[],
    ) {
      return await accept(
        setupApp({ context })(zeroSchedulesByNameContract).delete({
          headers: authenticate(context, actor),
          params: { name: schedule.name },
          query: { agentId: schedule.agentId },
        }),
        statuses,
      );
    },

    async executeSchedulesCron(validAuth: boolean) {
      return await accept(
        setupApp({ context })(cronExecuteSchedulesContract).execute({
          headers: cronHeaders(validAuth),
        }),
        [200, 401],
      );
    },

    // The email-outbox drain and billing reconciliation crons are deliberately
    // NOT part of this list: they sweep their work tables globally, so calling
    // them from other test files would race the email chains
    // (runs-schedules.bdd.test.ts) and BILL-01 chains (run-lifecycle.bdd.test.ts)
    // on the shared database, hitting rows whose Resend/Stripe mocks live in
    // another worker process.
    async runSafeCronRoutes(validAuth: boolean) {
      const headers = cronHeaders(validAuth);
      context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
        { data: [] },
      );
      const aggregateUsage = await accept(
        setupApp({ context })(cronAggregateUsageContract).aggregate({
          headers,
        }),
        [200, 401],
      );
      const aggregateInsights = await accept(
        setupApp({ context })(cronAggregateInsightsContract).aggregate({
          headers,
        }),
        [200, 401],
      );
      const cleanupSandboxes = await accept(
        setupApp({ context })(cronCleanupSandboxesContract).cleanup({
          headers,
        }),
        [200, 401],
      );
      const processUsageEvents = await accept(
        setupApp({ context })(cronProcessUsageEventsContract).process({
          headers,
        }),
        [200, 401],
      );
      const summarizeMemory = await accept(
        setupApp({ context })(cronSummarizeMemoryContract).summarize({
          headers,
        }),
        [200, 401],
      );
      const telegramCleanup = await accept(
        setupApp({ context })(cronTelegramCleanupContract).cleanup({
          headers,
        }),
        [200, 401],
      );

      return {
        aggregateUsage,
        aggregateInsights,
        cleanupSandboxes,
        processUsageEvents,
        summarizeMemory,
        telegramCleanup,
      };
    },

    // Kept out of runSafeCronRoutes for the same shared-database reason as the
    // email drain: the reconcile sweep retrieves the Stripe subscription of
    // every org needing reconciliation, and stale orgs created by the BILL-01
    // chains in run-lifecycle.bdd.test.ts must only be swept by that file's
    // own Stripe mocks.
    async reconcileBillingCron(validAuth: boolean) {
      return await accept(
        setupApp({ context })(
          cronReconcileBillingEntitlementsContract,
        ).reconcile({
          headers: cronHeaders(validAuth),
        }),
        [200, 401],
      );
    },
  };
}

export function uniqueScheduleName(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

/**
 * HMAC-SHA256 signature (`sha256=<hex>`) over the raw inbound webhook body,
 * matching the `x-vm0-signature-256` header the automation webhook verifies.
 */
export function signAutomationWebhook(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}
