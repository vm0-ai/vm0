import { randomUUID } from "node:crypto";

import {
  apiKeysByIdContract,
  apiKeysContract,
} from "@vm0/api-contracts/contracts/api-keys";
import {
  chatSearchContract,
  chatThreadByIdContract,
  chatThreadMessagesContract,
  chatThreadModelSelectionContract,
  chatThreadPinContract,
  chatThreadRenameContract,
  chatThreadsContract,
  chatThreadUnpinContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import {
  zeroPersonalModelProvidersByTypeContract,
  zeroPersonalModelProvidersMainContract,
} from "@vm0/api-contracts/contracts/zero-personal-model-providers";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { zeroOrgListContract } from "@vm0/api-contracts/contracts/zero-org-list";
import { integrationsGithubContract } from "@vm0/api-contracts/contracts/integrations-github";
import { zeroUploadsContract } from "@vm0/api-contracts/contracts/zero-uploads";
import { zeroUsageRunsContract } from "@vm0/api-contracts/contracts/zero-usage-daily";
import { zeroUsageMembersContract } from "@vm0/api-contracts/contracts/zero-usage";
import { zeroUsageInsightContract } from "@vm0/api-contracts/contracts/zero-usage-insight";
import {
  zeroConnectorScopeDiffContract,
  zeroConnectorsByTypeContract,
  zeroConnectorsMainContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import {
  zeroBillingAutoRechargeContract,
  zeroBillingCheckoutContract,
  zeroBillingDowngradeContract,
  zeroBillingInvoicesContract,
  zeroBillingPortalContract,
  zeroBillingRedeemCodeContract,
  zeroBillingRestoreContract,
} from "@vm0/api-contracts/contracts/zero-billing";
import { zeroOrgLogoContract } from "@vm0/api-contracts/contracts/zero-org-logo";
import { zeroTeamContract } from "@vm0/api-contracts/contracts/zero-team";
import {
  zeroOrgContract,
  zeroOrgDeleteContract,
  zeroOrgLeaveContract,
} from "@vm0/api-contracts/contracts/zero-org";
import {
  zeroRunsByIdContract,
  zeroRunsCancelContract,
  zeroRunsMainContract,
  zeroLogsSearchContract,
} from "@vm0/api-contracts/contracts/zero-runs";
import { logsSearchContract } from "@vm0/api-contracts/contracts/runs";
import { zeroSlackChannelsContract } from "@vm0/api-contracts/contracts/zero-slack-channels";
import { zeroSlackConnectContract } from "@vm0/api-contracts/contracts/zero-slack-connect";
import { zeroIntegrationsSlackContract } from "@vm0/api-contracts/contracts/zero-integrations-slack";
import {
  integrationsSlackMessageContract,
  integrationsSlackUploadInitContract,
  integrationsSlackUploadCompleteContract,
  integrationsTelegramMessageContract,
  integrationsTelegramUploadCompleteContract,
} from "@vm0/api-contracts/contracts/integrations";
import {
  onboardingStatusContract,
  onboardingSetupContract,
} from "@vm0/api-contracts/contracts/onboarding";
import { zeroQueuePositionContract } from "@vm0/api-contracts/contracts/zero-queue-position";
import {
  zeroSchedulesByNameContract,
  zeroSchedulesEnableContract,
} from "@vm0/api-contracts/contracts/zero-schedules";
import {
  zeroOrgInviteContract,
  zeroOrgMembersContract,
  zeroOrgMembershipRequestsContract,
} from "@vm0/api-contracts/contracts/zero-org-members";
import { zeroAttributionContract } from "@vm0/api-contracts/contracts/zero-attribution";
import { authContract } from "@vm0/api-contracts/contracts/auth";
import { platformRealtimeTokenContract } from "@vm0/api-contracts/contracts/realtime";
import { desktopUpdatesContract } from "@vm0/api-contracts/contracts/desktop-updates";
import {
  healthAuthContract,
  healthContract,
} from "@vm0/api-contracts/contracts";
import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import { zeroUserPreferencesContract } from "@vm0/api-contracts/contracts/zero-user-preferences";
import { zeroUserModelPreferenceContract } from "@vm0/api-contracts/contracts/zero-user-model-preference";
import { zeroAgentCustomConnectorsContract } from "@vm0/api-contracts/contracts/zero-agent-custom-connectors";
import {
  logsListContract,
  logsByIdContract,
} from "@vm0/api-contracts/contracts/logs";
import {
  zeroAgentsByIdContract,
  zeroAgentInstructionsContract,
  zeroAgentsMainContract,
  zeroSkillsCollectionContract,
} from "@vm0/api-contracts/contracts/zero-agents";
import {
  zeroComposesByIdContract,
  zeroComposesListContract,
  zeroComposesMainContract,
  zeroComposesMetadataContract,
} from "@vm0/api-contracts/contracts/zero-composes";
import {
  zeroCustomConnectorByIdContract,
  zeroCustomConnectorSecretContract,
  zeroCustomConnectorsContract,
} from "@vm0/api-contracts/contracts/zero-custom-connectors";
import {
  zeroSecretsByNameContract,
  zeroSecretsContract,
  zeroVariablesByNameContract,
  zeroVariablesContract,
} from "@vm0/api-contracts/contracts/zero-secrets";

import { setupApp, type TestContext } from "../../../../__tests__/test-helpers";
import { now } from "../../../../lib/time";
import { signSandboxJwtForTests } from "../../../auth/tokens";
import { createZeroRouteMocks } from "./zero-route-test";

/**
 * API-first BDD harness for route tests. Every interaction goes through a real
 * HTTP request via `setupApp`; the only thing mocked here are external services
 * (Clerk session resolution, S3 uploads) through `context.mocks`. There are no
 * database writers or readers — preconditions and assertions must be expressed
 * as real API calls by the test, per the migration plan in `api.bdd.md`.
 */
export const SESSION_AUTH = {
  authorization: "Bearer clerk-session",
} as const;

interface BddActor {
  readonly userId: string;
  readonly orgId: string;
}

function newOrgId(): string {
  return `org_${randomUUID()}`;
}

function newUserId(): string {
  return `user_${randomUUID()}`;
}

export function createBddApi(context: TestContext) {
  const mocks = createZeroRouteMocks(context);

  return {
    /** ts-rest client for `/api/zero/agents` (create + list). */
    agents: setupApp({ context })(zeroAgentsMainContract),
    /** ts-rest client for `/api/zero/agents/:id` (get/update/patch/delete). */
    agentsById: setupApp({ context })(zeroAgentsByIdContract),
    /** ts-rest client for `/api/zero/agents/:id/instructions` (get + put). A
     * successful update needs instructions storage on an existing agent; the
     * auth, capability, invalid-id and not-found rejections are reachable. */
    agentInstructions: setupApp({ context })(zeroAgentInstructionsContract),
    /** ts-rest client for `/api/zero/skills` (create), used to build the
     * `customSkills` precondition through the public API. */
    skills: setupApp({ context })(zeroSkillsCollectionContract),
    /** ts-rest client for `/api/zero/custom-connectors` (create/list), used to
     * build the org custom-connector precondition through the public API. */
    customConnectors: setupApp({ context })(zeroCustomConnectorsContract),
    /** ts-rest client for `/api/zero/custom-connectors/:id/secret` (set/delete
     * a per-user secret on a custom connector). */
    customConnectorSecret: setupApp({ context })(
      zeroCustomConnectorSecretContract,
    ),
    /** ts-rest client for `/api/zero/custom-connectors/:id` (patch/delete). */
    customConnectorById: setupApp({ context })(zeroCustomConnectorByIdContract),
    /** ts-rest client for `/api/zero/agents/:id/custom-connectors`
     * (get/update the connectors enabled on an agent). */
    agentCustomConnectors: setupApp({ context })(
      zeroAgentCustomConnectorsContract,
    ),
    /** ts-rest client for `/api/zero/agents/:id/user-connectors`
     * (get/update the built-in connector types enabled on an agent). */
    agentUserConnectors: setupApp({ context })(zeroUserConnectorsContract),
    /** ts-rest client for `/api/zero/variables` (list/set user variables). */
    variables: setupApp({ context })(zeroVariablesContract),
    /** ts-rest client for `/api/zero/variables/:name` (delete a variable). */
    variableByName: setupApp({ context })(zeroVariablesByNameContract),
    /** ts-rest client for `/api/zero/secrets` (list/set user secrets). */
    secrets: setupApp({ context })(zeroSecretsContract),
    /** ts-rest client for `/api/zero/secrets/:name` (delete a secret). */
    secretByName: setupApp({ context })(zeroSecretsByNameContract),
    /** ts-rest client for `/api/zero/user-preferences` (get/update). */
    userPreferences: setupApp({ context })(zeroUserPreferencesContract),
    /** ts-rest client for `/api/zero/user-model-preference` (get/update the
     * caller's model-first pin). */
    userModelPreference: setupApp({ context })(zeroUserModelPreferenceContract),
    /** ts-rest client for `/api/zero/feature-switches` (get/update/delete). */
    featureSwitches: setupApp({ context })(zeroFeatureSwitchesContract),
    /** ts-rest client for `/api/zero/api-keys` (list/create personal tokens). */
    apiKeys: setupApp({ context })(apiKeysContract),
    /** ts-rest client for `/api/zero/api-keys/:id` (delete a token). */
    apiKeyById: setupApp({ context })(apiKeysByIdContract),
    /** ts-rest client for `/api/zero/me/model-providers` (list/upsert). */
    personalModelProviders: setupApp({ context })(
      zeroPersonalModelProvidersMainContract,
    ),
    /** ts-rest client for `/api/zero/me/model-providers/:type` (delete). */
    personalModelProviderByType: setupApp({ context })(
      zeroPersonalModelProvidersByTypeContract,
    ),
    /** ts-rest client for `/api/zero/composes/:id` (read/delete a compose). */
    composesById: setupApp({ context })(zeroComposesByIdContract),
    /** ts-rest client for `/api/zero/composes` (list org composes). */
    composesList: setupApp({ context })(zeroComposesListContract),
    /** ts-rest client for `/api/zero/composes` getByName. */
    composesMain: setupApp({ context })(zeroComposesMainContract),
    /** ts-rest client for `/api/zero/composes/:id/metadata` (update). */
    composesMetadata: setupApp({ context })(zeroComposesMetadataContract),
    /** ts-rest client for `/api/zero/chat-threads` (create + list). */
    chatThreads: setupApp({ context })(chatThreadsContract),
    /** ts-rest client for `/api/zero/chat-threads/:id` (get/patch/delete). */
    chatThreadById: setupApp({ context })(chatThreadByIdContract),
    /** ts-rest client for `/api/zero/chat-threads/:id/messages` (list). Messages
     * with content need a funded run that emits them (GAP-CHAT-MESSAGE-SEED); the
     * auth, not-found and empty-thread cases are reachable directly. */
    chatThreadMessages: setupApp({ context })(chatThreadMessagesContract),
    /** ts-rest client for `/api/zero/chat/search` (keyword search across the
     * caller's chat messages). Matching results need seeded messages
     * (GAP-CHAT-MESSAGE-SEED); the auth, capability and empty-result cases are
     * reachable directly. */
    chatSearch: setupApp({ context })(chatSearchContract),
    /** ts-rest client for `/api/zero/chat-threads/:id/pin`. */
    chatThreadPin: setupApp({ context })(chatThreadPinContract),
    /** ts-rest client for `/api/zero/chat-threads/:id/unpin`. */
    chatThreadUnpin: setupApp({ context })(chatThreadUnpinContract),
    /** ts-rest client for `/api/zero/chat-threads/:id/rename`. */
    chatThreadRename: setupApp({ context })(chatThreadRenameContract),
    /** ts-rest client for `/api/zero/chat-threads/:id/model-selection`. */
    chatThreadModelSelection: setupApp({ context })(
      chatThreadModelSelectionContract,
    ),
    /** ts-rest client for `/api/zero/org/list` (list the caller's orgs). */
    orgList: setupApp({ context })(zeroOrgListContract),
    /** ts-rest client for `/api/integrations/github` (installation get/link/etc).
     * A connected installation needs the GitHub OAuth flow; only the
     * auth/capability/no-installation rejections are reachable. */
    githubIntegration: setupApp({ context })(integrationsGithubContract),
    /** ts-rest client for `/api/zero/uploads` (prepare/complete an upload). The
     * presigned-URL success path needs S3 + org context; the
     * auth/capability/validation rejections are reachable directly. */
    uploads: setupApp({ context })(zeroUploadsContract),
    /** ts-rest client for `/api/zero/usage/runs` (per-run usage). A fresh org
     * has no processed usage, so the empty result is reachable; populated rows
     * need seeded runs/usage events (GAP-USAGE-EVENTS). */
    usageRuns: setupApp({ context })(zeroUsageRunsContract),
    /** ts-rest client for `/api/zero/usage/members` (per-member billing-period
     * usage). Aggregated member totals need seeded usage rows; the auth and
     * free-tier empty (`{ period: null, members: [] }`) cases are reachable. */
    usageMembers: setupApp({ context })(zeroUsageMembersContract),
    /** ts-rest client for `/api/zero/usage/insight` (activity insight). Seeded
     * activity is needed for non-empty buckets; the auth, timezone/range
     * validation and empty-buckets cases are reachable directly. */
    usageInsight: setupApp({ context })(zeroUsageInsightContract),
    /** ts-rest client for `/api/zero/onboarding/status` (per-user onboarding
     * state). */
    /** ts-rest client for `/api/zero/slack/channels` (list bot-member Slack
     * channels). Listing real channels needs a seeded Slack installation plus an
     * Axiom/Slack API mock; the auth and no-installation cases are reachable. */
    slackChannels: setupApp({ context })(zeroSlackChannelsContract),
    /** ts-rest client for `/api/zero/integrations/slack/connect` (get status +
     * connect). A successful connect needs a seeded Slack installation
     * (GAP-CONNECTOR-CONNECT); the auth, disconnected-status and
     * unknown-workspace cases are reachable directly. */
    slackConnect: setupApp({ context })(zeroSlackConnectContract),
    /** ts-rest client for `/api/zero/integrations/slack` (org Slack status). A
     * connected workspace and environment details need a seeded installation /
     * connection (GAP-CONNECTOR-CONNECT); the auth and not-installed (install
     * URLs) cases are reachable directly. */
    slackIntegration: setupApp({ context })(zeroIntegrationsSlackContract),
    /** ts-rest clients for the sandbox-facing Slack message + file-upload
     * endpoints. Posting/uploading needs a seeded Slack installation reachable
     * via a zero token whose org has a membership (GAP-CONNECTOR-CONNECT); the
     * no-auth and missing-`slack:write`-capability rejections are reachable. */
    slackMessage: setupApp({ context })(integrationsSlackMessageContract),
    slackUploadInit: setupApp({ context })(integrationsSlackUploadInitContract),
    slackUploadComplete: setupApp({ context })(
      integrationsSlackUploadCompleteContract,
    ),
    /** ts-rest clients for the sandbox-facing Telegram message + file-upload
     * endpoints. Sending/uploading needs a zero token whose org has a seeded
     * custom/official bot (GAP-CONNECTOR-CONNECT); the no-auth and
     * no-org-context rejections are reachable. */
    telegramMessage: setupApp({ context })(integrationsTelegramMessageContract),
    telegramUploadComplete: setupApp({ context })(
      integrationsTelegramUploadCompleteContract,
    ),
    onboardingStatus: setupApp({ context })(onboardingStatusContract),
    /** ts-rest client for `/api/zero/onboarding/setup` (admin one-shot default
     * agent creation). Creating the default agent is free, so the happy path is
     * reachable; the disabled-connector 422 and Clerk-org-update variants need
     * seeded connectors / Clerk mocks and stay in the kept legacy. */
    onboardingSetup: setupApp({ context })(onboardingSetupContract),
    /** ts-rest client for `/api/zero/connectors/:type` (get/delete by type). A
     * connected connector needs the OAuth/manual connect flow; the
     * auth/not-found rejections are reachable directly. */
    /** ts-rest client for `/api/zero/connectors` (list configured connectors). A
     * populated list needs connected connector rows (GAP-CONNECTOR-CONNECT); the
     * auth and empty-list cases are reachable directly. */
    connectorsList: setupApp({ context })(zeroConnectorsMainContract),
    connectorByType: setupApp({ context })(zeroConnectorsByTypeContract),
    /** ts-rest client for `/api/zero/connectors/:type/scope-diff`. */
    connectorScopeDiff: setupApp({ context })(zeroConnectorScopeDiffContract),
    /** ts-rest client for `/api/logs` (run-log list). Seeded run logs need a
     * funded run (GAP-RUN-CREDITS); the auth/validation/empty cases are
     * reachable directly. */
    logsList: setupApp({ context })(logsListContract),
    /** ts-rest client for `/api/zero/logs/:id` (single run-log detail). The 200
     * detail needs a funded run (GAP-RUN-CREDITS); the auth, capability and
     * not-found rejections are reachable directly. */
    logsById: setupApp({ context })(logsByIdContract),
    /** ts-rest client for `/api/logs/search` (Axiom keyword search). Matched
     * results need seeded runs plus an Axiom mock; the auth and
     * empty-agent-filter (no runs -> short-circuit, Axiom not queried) cases are
     * reachable directly. */
    logsSearch: setupApp({ context })(logsSearchContract),
    /** ts-rest client for `/api/zero/logs/search` (zero-token Axiom search). */
    zeroLogsSearch: setupApp({ context })(zeroLogsSearchContract),
    /** ts-rest client for `/api/zero/org/invite` (invite/revoke org members). */
    orgInvite: setupApp({ context })(zeroOrgInviteContract),
    /** ts-rest client for `/api/zero/org/membership-requests` (accept/reject). */
    membershipRequests: setupApp({ context })(
      zeroOrgMembershipRequestsContract,
    ),
    /** ts-rest client for `/api/zero/org/members` (list/update/remove). The
     * Clerk-membership-driven cases need Clerk mocks; the auth/role/validation
     * rejections are reachable directly. */
    orgMembers: setupApp({ context })(zeroOrgMembersContract),
    /** ts-rest client for `/api/zero/billing/redeem-code` (consume a code). */
    billingRedeemCode: setupApp({ context })(zeroBillingRedeemCodeContract),
    /** ts-rest client for `/api/zero/billing/portal` (open the Stripe portal).
     * The funded success path needs a seeded Stripe customer with no API
     * surface; only the auth/validation/config rejections are reachable. */
    billingPortal: setupApp({ context })(zeroBillingPortalContract),
    /** ts-rest client for `/api/zero/billing/invoices` (list invoices). With no
     * Stripe customer the list is empty; the funded cases need a seeded
     * customer. */
    billingInvoices: setupApp({ context })(zeroBillingInvoicesContract),
    /** ts-rest client for `/api/zero/billing/checkout`. The funded success +
     * tier-transition cases need seeded org/Stripe state; only the
     * auth/validation/config rejections before the price check are reachable. */
    billingCheckout: setupApp({ context })(zeroBillingCheckoutContract),
    /** ts-rest client for `/api/zero/billing/auto-recharge` (get/update). With
     * no org metadata the config reads the legacy default; the funded toggles
     * need a seeded tier. */
    billingAutoRecharge: setupApp({ context })(zeroBillingAutoRechargeContract),
    /** ts-rest client for `/api/zero/billing/downgrade`. */
    billingDowngrade: setupApp({ context })(zeroBillingDowngradeContract),
    /** ts-rest client for `/api/zero/billing/restore`. */
    billingRestore: setupApp({ context })(zeroBillingRestoreContract),
    /** ts-rest client for `/api/zero/org/logo` (get/delete; POST is multipart
     * and is issued as a raw request by the test). */
    orgLogo: setupApp({ context })(zeroOrgLogoContract),
    /** ts-rest client for `/api/zero/team` (list the org's agents/composes). */
    team: setupApp({ context })(zeroTeamContract),
    /** ts-rest client for `/api/zero/org/delete`. The successful cascade delete
     * needs seeded org data; only the auth/validation/identity rejections are
     * reachable (org identity + slug come from the Clerk mock). */
    orgDelete: setupApp({ context })(zeroOrgDeleteContract),
    /** ts-rest client for `/api/zero/org` (get/update). */
    org: setupApp({ context })(zeroOrgContract),
    /** ts-rest client for `/api/zero/org/leave`. */
    orgLeave: setupApp({ context })(zeroOrgLeaveContract),
    /** ts-rest client for `/api/zero/runs` (create a run). The funded happy path
     * needs seeded credits with no API surface; only the pre-admission
     * rejections (auth/validation/credits/ownership) are reachable. */
    zeroRuns: setupApp({ context })(zeroRunsMainContract),
    /** ts-rest client for `/api/zero/runs/:id` (get a run). Reading an actual
     * run needs a seeded run; only auth/validation/not-found are reachable. */
    zeroRunsById: setupApp({ context })(zeroRunsByIdContract),
    /** ts-rest client for `/api/zero/runs/:id/cancel`. */
    zeroRunsCancel: setupApp({ context })(zeroRunsCancelContract),
    /** ts-rest client for `/api/zero/queue-position`. */
    zeroQueuePosition: setupApp({ context })(zeroQueuePositionContract),
    /** ts-rest client for `/api/zero/schedules/:name/{enable,disable}`. Mutating
     * an actual schedule needs a deployed schedule (external scheduler); only
     * the not-found/validation/auth rejections are reachable. */
    scheduleEnable: setupApp({ context })(zeroSchedulesEnableContract),
    /** ts-rest client for `/api/zero/schedules/:name` (delete). */
    scheduleByName: setupApp({ context })(zeroSchedulesByNameContract),
    /** ts-rest client for `/api/zero/attribution/signup` (record first-touch
     * signup attribution into Clerk private metadata). */
    attribution: setupApp({ context })(zeroAttributionContract),
    /** ts-rest client for `/api/auth/me` (resolve the caller's id + email). */
    authMe: setupApp({ context })(authContract),
    /** ts-rest client for `/api/zero/realtime/token` (mint an Ably token). */
    realtimeToken: setupApp({ context })(platformRealtimeTokenContract),
    /** ts-rest client for `/api/desktop/updates/...` (public auto-update feed). */
    desktopUpdates: setupApp({ context })(desktopUpdatesContract),
    /** ts-rest client for `/api/health` (public liveness check). */
    health: setupApp({ context })(healthContract),
    /** ts-rest client for `/api/health/auth` (auth-gated liveness check). */
    healthAuth: setupApp({ context })(healthAuthContract),

    /** Authorization header for the active Clerk session actor. */
    auth: SESSION_AUTH,

    /** Mock a Clerk admin session and return the acting identity. */
    actAsAdmin(actor: Partial<BddActor> = {}): BddActor {
      const identity: BddActor = {
        userId: actor.userId ?? newUserId(),
        orgId: actor.orgId ?? newOrgId(),
      };
      mocks.clerk.session(identity.userId, identity.orgId, "org:admin");
      return identity;
    },

    /** Mock a Clerk session for a non-admin member of `actor.orgId`. */
    actAsMember(actor: BddActor): BddActor {
      mocks.clerk.session(actor.userId, actor.orgId, "org:member");
      return actor;
    },

    /** Mock a Clerk session with no active organization. */
    actAsNoOrg(userId: string = newUserId()): void {
      mocks.clerk.session(userId, null);
    },

    /** Mock the caller's Clerk organization memberships (the external source of
     * truth for `/api/zero/org/list`). Clerk owns org membership, so there is
     * no in-app API to create it — mocking the provider is the precondition. */
    mockOrgMemberships(
      memberships: readonly {
        readonly orgId: string;
        readonly slug: string;
        readonly role: "org:admin" | "org:member";
      }[],
    ): void {
      context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue(
        {
          data: memberships.map((membership) => {
            return {
              organization: { id: membership.orgId, slug: membership.slug },
              role: membership.role,
            };
          }),
        },
      );
    },

    /** Mock the Clerk user lookup so a route that reads/writes Clerk private
     * metadata sees `privateMetadata` for `userId`, and allow the write. Clerk
     * owns this profile data, so it is an external precondition to mock. */
    mockClerkUserPrivateMetadata(
      userId: string,
      privateMetadata: Record<string, unknown>,
    ): void {
      context.mocks.clerk.users.getUserList.mockResolvedValue({
        data: [{ id: userId, privateMetadata }],
      });
      context.mocks.clerk.users.updateUser.mockResolvedValue({});
    },

    /** Build an `Authorization` header for a sandbox "zero" token carrying the
     * given capabilities — used to exercise capability-gated 403 branches. */
    zeroAuth(capabilities: readonly ZeroCapability[]): {
      readonly authorization: string;
    } {
      const seconds = Math.floor(now() / 1000);
      const token = signSandboxJwtForTests({
        scope: "zero",
        userId: newUserId(),
        orgId: newOrgId(),
        runId: `run_${randomUUID()}`,
        capabilities: [...capabilities],
        iat: seconds,
        exp: seconds + 60,
      });
      return { authorization: `Bearer ${token}` };
    },

    /** Build an `Authorization` header for a sandbox-scoped token bound to a
     * known `userId` (so a Clerk profile mock for that user can be matched). */
    sandboxAuth(userId: string): { readonly authorization: string } {
      const seconds = Math.floor(now() / 1000);
      const token = signSandboxJwtForTests({
        scope: "sandbox",
        userId,
        orgId: newOrgId(),
        runId: `run_${randomUUID()}`,
        iat: seconds,
        exp: seconds + 60,
      });
      return { authorization: `Bearer ${token}` };
    },

    /** Build an `Authorization` header for a zero-scoped token bound to a known
     * `userId` and carrying the given capabilities. */
    zeroAuthFor(
      userId: string,
      capabilities: readonly ZeroCapability[],
    ): { readonly authorization: string } {
      const seconds = Math.floor(now() / 1000);
      const token = signSandboxJwtForTests({
        scope: "zero",
        userId,
        orgId: newOrgId(),
        runId: `run_${randomUUID()}`,
        capabilities: [...capabilities],
        iat: seconds,
        exp: seconds + 60,
      });
      return { authorization: `Bearer ${token}` };
    },

    /** Mock the Clerk profile lookup so a route that resolves a user's email
     * (e.g. `/api/auth/me`) sees a primary email for `userId`. Clerk owns the
     * profile, so it is an external precondition to mock. */
    mockClerkUserEmail(
      userId: string,
      email: string,
      name: { readonly firstName?: string; readonly lastName?: string } = {},
    ): void {
      const emailId = `email_${userId}`;
      context.mocks.clerk.users.getUserList.mockResolvedValue({
        data: [
          {
            id: userId,
            firstName: name.firstName ?? null,
            lastName: name.lastName ?? null,
            emailAddresses: [{ id: emailId, emailAddress: email }],
            primaryEmailAddressId: emailId,
          },
        ],
      });
    },

    /** Stub S3 so the instructions-storage upload during agent creation
     * succeeds (the only external dependency the create path touches). */
    allowInstructionsStorage(): void {
      context.mocks.s3.send.mockResolvedValue({});
    },
  };
}
