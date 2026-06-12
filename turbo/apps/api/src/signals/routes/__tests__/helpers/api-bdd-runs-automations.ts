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
  automationsByRefContract,
  automationsMainContract,
  automationTriggersContract,
  type AutomationResponse,
  type AutomationTriggerResponse,
} from "@vm0/api-contracts/contracts/automations";
import { runnerRealtimeTokenContract } from "@vm0/api-contracts/contracts/realtime";
import { zeroModelPoliciesMainContract } from "@vm0/api-contracts/contracts/zero-model-policies";
import { zeroModelProvidersMainContract } from "@vm0/api-contracts/contracts/zero-model-providers";
import {
  cronAggregateInsightsContract,
  cronAggregateUsageContract,
  cronCleanupSandboxesContract,
  cronExecuteAutomationsContract,
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
import type { AutomationView } from "@vm0/api-contracts/contracts/automation-view";
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
type ContractCreateAutomationRequest = z.infer<
  (typeof automationsMainContract.create)["body"]
>;
type ContractUpdateAutomationRequest = z.infer<
  (typeof automationsByRefContract.update)["body"]
>;
type CreateTriggerRequest = z.infer<
  (typeof automationsByRefContract.addTrigger)["body"]
>;
type DeployAutomationRequest = {
  readonly name: string;
  readonly cronExpression?: string;
  readonly atTime?: string;
  readonly intervalSeconds?: number;
  readonly timezone?: string;
  readonly prompt: string;
  readonly description?: string;
  readonly appendSystemPrompt?: string;
  readonly agentId: string;
  readonly enabled?: boolean;
  readonly chatThreadId?: string;
};
type CreateAutomationRequest = DeployAutomationRequest;
type UpdateAutomationRequest = Omit<
  Partial<DeployAutomationRequest>,
  "description" | "appendSystemPrompt"
> & {
  readonly name?: string;
  readonly description?: string | null;
  readonly appendSystemPrompt?: string | null;
};
type CreateWebhookAutomationRequest = {
  readonly name: string;
  readonly instruction: string;
  readonly description?: string;
  readonly appendSystemPrompt?: string;
  readonly agentId: string;
  readonly enabled?: boolean;
  readonly chatThreadId?: string;
};
type DeployAutomationResponse = {
  readonly automation: AutomationView;
  readonly created: boolean;
};
type AutomationMutationResponse = {
  readonly automation: AutomationView;
  readonly created: boolean;
};
type AutomationListResponse = {
  readonly automations: readonly AutomationView[];
};
type WebhookAutomationResponse = AutomationResponse & {
  readonly webhookToken: string;
  readonly webhookUrl: string;
};
type WebhookAutomationCreateResponse = {
  readonly automation: WebhookAutomationResponse;
  readonly secret: string;
};
type WebhookAutomationListResponse = {
  readonly automations: readonly WebhookAutomationResponse[];
};
type AutomationResourceRef = {
  readonly id?: string;
  readonly name: string;
};
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

type TimeTriggerResponse = Extract<
  AutomationTriggerResponse,
  { readonly kind: "cron" | "once" | "loop" }
>;
type WebhookTriggerResponse = Extract<
  AutomationTriggerResponse,
  { readonly kind: "webhook" }
>;

function isTimeTrigger(
  trigger: AutomationTriggerResponse,
): trigger is TimeTriggerResponse {
  return (
    trigger.kind === "cron" ||
    trigger.kind === "once" ||
    trigger.kind === "loop"
  );
}

function timeTriggerFor(automation: AutomationResponse): TimeTriggerResponse {
  const trigger = automation.triggers.find(isTimeTrigger);
  if (!trigger) {
    throw new Error(`Automation ${automation.id} has no time trigger`);
  }
  return trigger;
}

function webhookTriggerFor(
  automation: AutomationResponse,
): WebhookTriggerResponse {
  const trigger = automation.triggers.find((item) => {
    return item.kind === "webhook";
  });
  if (!trigger) {
    throw new Error(`Automation ${automation.id} has no webhook trigger`);
  }
  return trigger;
}

function hasTimeTrigger(automation: AutomationResponse): boolean {
  return automation.triggers.some(isTimeTrigger);
}

function hasWebhookTrigger(automation: AutomationResponse): boolean {
  return automation.triggers.some((trigger) => {
    return trigger.kind === "webhook";
  });
}

function automationViewFromResponse(
  automation: AutomationResponse,
): AutomationView {
  const trigger = timeTriggerFor(automation);
  return {
    id: automation.id,
    agentId: automation.agentId,
    displayName: automation.displayName,
    userId: automation.userId,
    name: automation.name,
    triggerType: trigger.kind,
    cronExpression: trigger.kind === "cron" ? trigger.cronExpression : null,
    atTime: trigger.kind === "once" ? trigger.atTime : null,
    intervalSeconds: trigger.kind === "loop" ? trigger.intervalSeconds : null,
    timezone: trigger.timezone,
    prompt: automation.instruction,
    description: automation.description,
    appendSystemPrompt: automation.appendSystemPrompt,
    enabled: automation.enabled && trigger.enabled,
    nextRunAt: trigger.nextRunAt,
    lastRunAt: trigger.lastRunAt,
    retryStartedAt: null,
    consecutiveFailures: trigger.consecutiveFailures,
    chatThreadId: automation.chatThreadId,
    createdAt: automation.createdAt,
    updatedAt: automation.updatedAt,
  };
}

function webhookResponseFromAutomation(
  automation: AutomationResponse,
): WebhookAutomationResponse {
  const trigger = webhookTriggerFor(automation);
  return {
    ...automation,
    webhookToken: trigger.webhookToken,
    webhookUrl: trigger.webhookUrl,
  };
}

function createTimeTriggerRequest(
  body: Pick<
    DeployAutomationRequest,
    "cronExpression" | "atTime" | "intervalSeconds" | "timezone"
  >,
): CreateTriggerRequest | null {
  if (body.cronExpression !== undefined) {
    return {
      kind: "cron",
      cronExpression: body.cronExpression,
      ...(body.timezone === undefined ? {} : { timezone: body.timezone }),
    };
  }
  if (body.atTime !== undefined) {
    return {
      kind: "once",
      atTime: body.atTime,
      ...(body.timezone === undefined ? {} : { timezone: body.timezone }),
    };
  }
  if (body.intervalSeconds !== undefined) {
    return { kind: "loop", intervalSeconds: body.intervalSeconds };
  }
  return null;
}

function contractCreateAutomationBody(
  body: CreateAutomationRequest,
): ContractCreateAutomationRequest {
  const trigger = createTimeTriggerRequest(body);
  if (!trigger) {
    throw new Error("Time-trigger automation requires a trigger");
  }
  return {
    name: body.name,
    agentId: body.agentId,
    instruction: body.prompt,
    ...(body.description === undefined
      ? {}
      : { description: body.description }),
    ...(body.appendSystemPrompt === undefined
      ? {}
      : { appendSystemPrompt: body.appendSystemPrompt }),
    ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
    ...(body.chatThreadId === undefined
      ? {}
      : { chatThreadId: body.chatThreadId }),
    trigger,
  };
}

function contractCreateAutomationBodyUnchecked(
  body: unknown,
): ContractCreateAutomationRequest {
  if (
    typeof body === "object" &&
    body !== null &&
    "prompt" in body &&
    "name" in body &&
    "agentId" in body &&
    createTimeTriggerRequest(body as DeployAutomationRequest) !== null
  ) {
    return contractCreateAutomationBody(body as CreateAutomationRequest);
  }
  return body as ContractCreateAutomationRequest;
}

function contractCreateWebhookAutomationBody(
  body: CreateWebhookAutomationRequest,
): ContractCreateAutomationRequest {
  return {
    name: body.name,
    agentId: body.agentId,
    instruction: body.instruction,
    ...(body.description === undefined
      ? {}
      : { description: body.description }),
    ...(body.appendSystemPrompt === undefined
      ? {}
      : { appendSystemPrompt: body.appendSystemPrompt }),
    ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
    ...(body.chatThreadId === undefined
      ? {}
      : { chatThreadId: body.chatThreadId }),
    trigger: { kind: "webhook" },
  };
}

function contractCreateWebhookAutomationBodyUnchecked(
  body: unknown,
): ContractCreateAutomationRequest {
  if (
    typeof body === "object" &&
    body !== null &&
    "instruction" in body &&
    "name" in body &&
    "agentId" in body
  ) {
    return contractCreateWebhookAutomationBody(
      body as CreateWebhookAutomationRequest,
    );
  }
  return body as ContractCreateAutomationRequest;
}

function contractUpdateAutomationBody(
  body: UpdateAutomationRequest,
): ContractUpdateAutomationRequest {
  return {
    ...(body.name === undefined ? {} : { name: body.name }),
    ...(body.prompt === undefined ? {} : { instruction: body.prompt }),
    ...(body.description === undefined
      ? {}
      : { description: body.description }),
    ...(body.appendSystemPrompt === undefined
      ? {}
      : { appendSystemPrompt: body.appendSystemPrompt }),
  };
}

function automationRef(resource: AutomationResourceRef | string): string {
  return typeof resource === "string"
    ? resource
    : (resource.id ?? resource.name);
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

export function createRunsAutomationsApi(context: TestContext) {
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

    async enableAutomations(
      actor: ApiTestUser,
      options: { readonly webhookTriggers?: boolean } = {},
    ): Promise<void> {
      await accept(
        setupApp({ context })(zeroFeatureSwitchesContract).update({
          headers: authenticate(context, actor),
          body: {
            switches: {
              [FeatureSwitchKey.AutomationWebhookTriggers]:
                options.webhookTriggers ?? true,
            },
          },
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
          body: contractCreateAutomationBody(body),
        }),
        [201],
      );
      return {
        automation: automationViewFromResponse(response.body.automation),
        created: true,
      };
    },

    async requestCreateAutomationUnchecked(
      actor: ApiTestUser | null,
      body: unknown,
      statuses: readonly (201 | 400 | 401 | 403 | 404)[],
    ) {
      return await accept(
        setupApp({ context })(automationsMainContract).create({
          headers: authenticate(context, actor),
          body: contractCreateAutomationBodyUnchecked(body),
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
      return {
        automations: response.body.automations
          .filter(hasTimeTrigger)
          .map(automationViewFromResponse),
      };
    },

    async requestListAutomations(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 403 | 404)[],
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
      const updated = await accept(
        setupApp({ context })(automationsByRefContract).update({
          headers: authenticate(context, actor),
          params: { ref: name },
          body: contractUpdateAutomationBody(body),
        }),
        [200],
      );

      const trigger = createTimeTriggerRequest(body);
      if (trigger !== null) {
        const triggers = await accept(
          setupApp({ context })(automationsByRefContract).listTriggers({
            headers: authenticate(context, actor),
            params: { ref: updated.body.id },
          }),
          [200],
        );
        for (const existing of triggers.body.triggers) {
          if (isTimeTrigger(existing)) {
            await accept(
              setupApp({ context })(automationTriggersContract).remove({
                headers: authenticate(context, actor),
                params: { id: existing.id },
              }),
              [204],
            );
          }
        }
        await accept(
          setupApp({ context })(automationsByRefContract).addTrigger({
            headers: authenticate(context, actor),
            params: { ref: updated.body.id },
            body: trigger,
          }),
          [201],
        );
      }

      const shown = await accept(
        setupApp({ context })(automationsByRefContract).show({
          headers: authenticate(context, actor),
          params: { ref: updated.body.id },
        }),
        [200],
      );
      return {
        automation: automationViewFromResponse(shown.body),
        created: false,
      };
    },

    async enableAutomation(
      actor: ApiTestUser,
      automation: AutomationResourceRef,
    ): Promise<AutomationView> {
      const response = await accept(
        setupApp({ context })(automationsByRefContract).enable({
          headers: authenticate(context, actor),
          params: { ref: automationRef(automation) },
          body: {},
        }),
        [200],
      );
      return automationViewFromResponse(response.body);
    },

    async disableAutomation(
      actor: ApiTestUser,
      automation: AutomationResourceRef,
    ): Promise<AutomationView> {
      const response = await accept(
        setupApp({ context })(automationsByRefContract).disable({
          headers: authenticate(context, actor),
          params: { ref: automationRef(automation) },
          body: {},
        }),
        [200],
      );
      return automationViewFromResponse(response.body);
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
        setupApp({ context })(automationsByRefContract).run({
          headers: authenticate(context, actor),
          params: { ref: automationId },
          body: {},
        }),
        statuses,
      );
    },

    async deleteAutomation(
      actor: ApiTestUser,
      automation: AutomationResourceRef,
    ): Promise<void> {
      await accept(
        setupApp({ context })(automationsByRefContract).delete({
          headers: authenticate(context, actor),
          params: { ref: automationRef(automation) },
        }),
        [204],
      );
    },

    async requestDeleteAutomation(
      actor: ApiTestUser | null,
      automation: AutomationResourceRef,
      statuses: readonly (204 | 400 | 401 | 403 | 404)[],
    ) {
      return await accept(
        setupApp({ context })(automationsByRefContract).delete({
          headers: authenticate(context, actor),
          params: { ref: automationRef(automation) },
        }),
        statuses,
      );
    },

    async requestUpdateAutomationUnchecked(
      actor: ApiTestUser | null,
      name: string,
      body: unknown,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      return await accept(
        setupApp({ context })(automationsByRefContract).update({
          headers: authenticate(context, actor),
          params: { ref: name },
          body: contractUpdateAutomationBody(body as UpdateAutomationRequest),
        }),
        statuses,
      );
    },

    async requestEnableAutomation(
      actor: ApiTestUser | null,
      automation: AutomationResourceRef,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      return await accept(
        setupApp({ context })(automationsByRefContract).enable({
          headers: authenticate(context, actor),
          params: { ref: automationRef(automation) },
          body: {},
        }),
        statuses,
      );
    },

    async requestDisableAutomation(
      actor: ApiTestUser | null,
      automation: AutomationResourceRef,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      return await accept(
        setupApp({ context })(automationsByRefContract).disable({
          headers: authenticate(context, actor),
          params: { ref: automationRef(automation) },
          body: {},
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
        setupApp({ context })(automationsMainContract).create({
          headers: authenticate(context, actor),
          body: contractCreateWebhookAutomationBody(body),
        }),
        [201],
      );
      const secret = response.body.webhookSecret;
      if (secret === undefined) {
        throw new Error(
          "Expected webhook automation creation to return secret",
        );
      }
      return {
        automation: webhookResponseFromAutomation(response.body.automation),
        secret,
      };
    },

    async requestCreateWebhookAutomationUnchecked(
      actor: ApiTestUser | null,
      body: unknown,
      statuses: readonly (201 | 400 | 401 | 403 | 404)[],
    ) {
      return await accept(
        setupApp({ context })(automationsMainContract).create({
          headers: authenticate(context, actor),
          body: contractCreateWebhookAutomationBodyUnchecked(body),
        }),
        statuses,
      );
    },

    async listWebhookAutomations(
      actor: ApiTestUser,
    ): Promise<WebhookAutomationListResponse> {
      const response = await accept(
        setupApp({ context })(automationsMainContract).list({
          headers: authenticate(context, actor),
        }),
        [200],
      );
      return {
        automations: response.body.automations
          .filter(hasWebhookTrigger)
          .map(webhookResponseFromAutomation),
      };
    },

    async requestListWebhookAutomations(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      return await accept(
        setupApp({ context })(automationsMainContract).list({
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
        setupApp({ context })(automationsByRefContract).delete({
          headers: authenticate(context, actor),
          params: { ref: id },
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
        setupApp({ context })(automationsByRefContract).delete({
          headers: authenticate(context, actor),
          params: { ref: id },
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

    async deployAutomation(
      actor: ApiTestUser,
      body: DeployAutomationRequest,
    ): Promise<DeployAutomationResponse> {
      const existingList = await accept(
        setupApp({ context })(automationsMainContract).list({
          headers: authenticate(context, actor),
        }),
        [200],
      );
      const existing = existingList.body.automations.find((automation) => {
        return (
          automation.name === body.name &&
          automation.agentId === body.agentId &&
          hasTimeTrigger(automation)
        );
      });

      if (existing !== undefined) {
        const updated = await accept(
          setupApp({ context })(automationsByRefContract).update({
            headers: authenticate(context, actor),
            params: { ref: existing.id },
            body: contractUpdateAutomationBody(body),
          }),
          [200],
        );
        const triggers = await accept(
          setupApp({ context })(automationsByRefContract).listTriggers({
            headers: authenticate(context, actor),
            params: { ref: updated.body.id },
          }),
          [200],
        );
        for (const trigger of triggers.body.triggers) {
          if (isTimeTrigger(trigger)) {
            await accept(
              setupApp({ context })(automationTriggersContract).remove({
                headers: authenticate(context, actor),
                params: { id: trigger.id },
              }),
              [204],
            );
          }
        }
        const nextTrigger = createTimeTriggerRequest(body);
        if (!nextTrigger) {
          throw new Error("Automation deployment requires a time trigger");
        }
        await accept(
          setupApp({ context })(automationsByRefContract).addTrigger({
            headers: authenticate(context, actor),
            params: { ref: updated.body.id },
            body: nextTrigger,
          }),
          [201],
        );
        if (body.enabled === true && !updated.body.enabled) {
          await accept(
            setupApp({ context })(automationsByRefContract).enable({
              headers: authenticate(context, actor),
              params: { ref: updated.body.id },
              body: {},
            }),
            [200],
          );
        }
        if (body.enabled === false && updated.body.enabled) {
          await accept(
            setupApp({ context })(automationsByRefContract).disable({
              headers: authenticate(context, actor),
              params: { ref: updated.body.id },
              body: {},
            }),
            [200],
          );
        }
        const shown = await accept(
          setupApp({ context })(automationsByRefContract).show({
            headers: authenticate(context, actor),
            params: { ref: updated.body.id },
          }),
          [200],
        );
        return {
          automation: automationViewFromResponse(shown.body),
          created: false,
        };
      }

      const response = await accept(
        setupApp({ context })(automationsMainContract).create({
          headers: authenticate(context, actor),
          body: contractCreateAutomationBody(body),
        }),
        [201],
      );
      return {
        automation: automationViewFromResponse(response.body.automation),
        created: true,
      };
    },

    async requestDeployAutomationUnchecked(
      actor: ApiTestUser | null,
      body: unknown,
      statuses: readonly (201 | 400 | 401 | 403 | 404)[],
    ) {
      return await accept(
        setupApp({ context })(automationsMainContract).create({
          headers: authenticate(context, actor),
          body: contractCreateAutomationBodyUnchecked(body),
        }),
        statuses,
      );
    },

    async requestDeleteAutomationAs(
      authorization: string | undefined,
      automation: AutomationResourceRef,
      statuses: readonly (204 | 400 | 401 | 403 | 404)[],
    ) {
      return await accept(
        setupApp({ context })(automationsByRefContract).delete({
          headers: authorization === undefined ? {} : { authorization },
          params: { ref: automationRef(automation) },
        }),
        statuses,
      );
    },

    async executeAutomationsCron(validAuth: boolean) {
      return await accept(
        setupApp({ context })(cronExecuteAutomationsContract).execute({
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

export function uniqueAutomationName(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

/**
 * HMAC-SHA256 signature (`sha256=<hex>`) over the raw inbound webhook body,
 * matching the `x-vm0-signature-256` header the automation webhook verifies.
 */
export function signAutomationWebhook(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}
