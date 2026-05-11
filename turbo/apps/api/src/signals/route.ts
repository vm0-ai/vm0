import type { AppRoute } from "@ts-rest/core";
import { healthContract } from "@vm0/api-contracts/contracts/health";

import { audioTranscriptionsV1Routes } from "./routes/audio-transcriptions-v1";
import type { SignalRouteHandler } from "./context/route";
import { chatThreadsV1Routes } from "./routes/chat-threads-v1";
import { deviceTokenRoutes } from "./routes/device-token";
import { apiHealth$ } from "./routes/health";
import { healthAuthProbeRoutes } from "./routes/health-auth-probe";
import { internalEventConsumerTelegramTypingRoutes } from "./routes/internal-event-consumers-telegram-typing";
import { modelStatsRoutes } from "./routes/model-stats";
import { zeroAgentInstructionsRoutes } from "./routes/zero-agent-instructions";
import { zeroAgentsRoutes } from "./routes/zero-agents";
import { zeroApiKeysRoutes } from "./routes/zero-api-keys";
import { zeroBillingAutoRechargeRoutes } from "./routes/zero-billing-auto-recharge";
import { zeroBillingCheckoutRoutes } from "./routes/zero-billing-checkout";
import { zeroBillingDowngradeRoutes } from "./routes/zero-billing-downgrade";
import { zeroBillingInvoicesRoutes } from "./routes/zero-billing-invoices";
import { zeroBillingPortalRoutes } from "./routes/zero-billing-portal";
import { zeroBillingStatusRoutes } from "./routes/zero-billing-status";
import { zeroChatThreadRoutes } from "./routes/zero-chat-threads";
import { zeroComposesRoutes } from "./routes/zero-composes";
import { zeroComputerUseRoutes } from "./routes/zero-computer-use";
import { zeroConnectorsRoutes } from "./routes/zero-connectors";
import { zeroCustomConnectorsRoutes } from "./routes/zero-custom-connectors";
import { zeroDefaultAgentRoutes } from "./routes/zero-default-agent";
import { zeroFeatureSwitchesRoutes } from "./routes/zero-feature-switches";
import { zeroInsightsRoutes } from "./routes/zero-insights";
import { zeroLogsRoutes } from "./routes/zero-logs";
import { zeroMemberCreditCapRoutes } from "./routes/zero-member-credit-cap";
import { zeroModelPoliciesRoutes } from "./routes/zero-model-policies";
import { zeroModelProvidersRoutes } from "./routes/zero-model-providers";
import { zeroOnboardingCompleteRoutes } from "./routes/zero-onboarding-complete";
import { zeroOnboardingStatusRoutes } from "./routes/zero-onboarding-status";
import { zeroOrgInviteRoutes } from "./routes/zero-org-invite";
import { zeroOrgMembershipRequestsRoutes } from "./routes/zero-org-membership-requests";
import { zeroOrgReadRoutes } from "./routes/zero-org-read";
import { zeroPermissionPoliciesRoutes } from "./routes/zero-permission-policies";
import { zeroPushSubscriptionsRoutes } from "./routes/zero-push-subscriptions";
import { zeroQueuePositionRoutes } from "./routes/zero-queue-position";
import { zeroRunDetailRoutes } from "./routes/zero-run-detail";
import { zeroRunsRoutes } from "./routes/zero-runs";
import { zeroRunsCancelRoutes } from "./routes/zero-runs-cancel";
import { zeroSchedulesRoutes } from "./routes/zero-schedules";
import { zeroMeModelProvidersDeleteRoutes } from "./routes/zero-me-model-providers-delete";
import { zeroMeModelProvidersUpsertRoutes } from "./routes/zero-me-model-providers-upsert";
import { zeroSecretsRoutes } from "./routes/zero-secrets";
import { zeroSkillsRoutes } from "./routes/zero-skills";
import { zeroIntegrationsSlackRoutes } from "./routes/zero-integrations-slack";
import { zeroIntegrationsSlackMessageRoutes } from "./routes/zero-integrations-slack-message";
import { zeroIntegrationsTelegramRoutes } from "./routes/zero-integrations-telegram";
import { zeroIntegrationsTelegramMessageRoutes } from "./routes/zero-integrations-telegram-message";
import { zeroSlackChannelsRoutes } from "./routes/zero-slack-channels";
import { zeroSlackConnectRoutes } from "./routes/zero-slack-connect";
import { zeroTeamRoutes } from "./routes/zero-team";
import { zeroUploadsCompleteRoutes } from "./routes/zero-uploads-complete";
import { zeroUploadsPrepareRoutes } from "./routes/zero-uploads-prepare";
import { zeroUsageInsightRoutes } from "./routes/zero-usage-insight";
import { zeroUserPreferencesRoutes } from "./routes/zero-user-preferences";
import { zeroUserModelPreferenceRoutes } from "./routes/zero-user-model-preference";
import { zeroVoiceChatRoutes } from "./routes/zero-voice-chat";
import { zeroVoiceIoQuotaRoutes } from "./routes/zero-voice-io-quota";
import { zeroWebDownloadRoutes } from "./routes/zero-web-download";

export type { SignalRouteHandler };

export interface RouteEntry {
  readonly route: AppRoute;
  readonly handler: SignalRouteHandler<unknown>;
}

export const ROUTES: readonly RouteEntry[] = [
  {
    route: healthContract.check,
    handler: apiHealth$,
  },
  ...healthAuthProbeRoutes,
  ...internalEventConsumerTelegramTypingRoutes,
  ...deviceTokenRoutes,
  ...zeroAgentInstructionsRoutes,
  ...zeroAgentsRoutes,
  ...zeroApiKeysRoutes,
  ...zeroBillingAutoRechargeRoutes,
  ...zeroBillingCheckoutRoutes,
  ...zeroBillingDowngradeRoutes,
  ...zeroBillingInvoicesRoutes,
  ...zeroBillingPortalRoutes,
  ...zeroBillingStatusRoutes,
  ...zeroChatThreadRoutes,
  ...zeroComposesRoutes,
  ...zeroComputerUseRoutes,
  ...zeroConnectorsRoutes,
  ...zeroCustomConnectorsRoutes,
  ...zeroDefaultAgentRoutes,
  ...zeroFeatureSwitchesRoutes,
  ...zeroInsightsRoutes,
  ...zeroLogsRoutes,
  ...zeroMemberCreditCapRoutes,
  ...zeroModelPoliciesRoutes,
  ...zeroModelProvidersRoutes,
  ...zeroMeModelProvidersDeleteRoutes,
  ...zeroMeModelProvidersUpsertRoutes,
  ...zeroVoiceChatRoutes,
  ...zeroVoiceIoQuotaRoutes,
  ...zeroWebDownloadRoutes,
  ...zeroQueuePositionRoutes,
  ...zeroRunDetailRoutes,
  ...zeroRunsRoutes,
  ...zeroRunsCancelRoutes,
  ...zeroSchedulesRoutes,
  ...zeroOnboardingCompleteRoutes,
  ...zeroOnboardingStatusRoutes,
  ...zeroOrgInviteRoutes,
  ...zeroOrgMembershipRequestsRoutes,
  ...zeroOrgReadRoutes,
  ...zeroPermissionPoliciesRoutes,
  ...zeroPushSubscriptionsRoutes,
  ...zeroUserPreferencesRoutes,
  ...zeroUserModelPreferenceRoutes,
  ...zeroSecretsRoutes,
  ...zeroSkillsRoutes,
  ...zeroSlackConnectRoutes,
  ...zeroIntegrationsSlackRoutes,
  ...zeroIntegrationsSlackMessageRoutes,
  ...zeroSlackChannelsRoutes,
  ...zeroIntegrationsTelegramRoutes,
  ...zeroIntegrationsTelegramMessageRoutes,
  ...zeroTeamRoutes,
  ...zeroUploadsCompleteRoutes,
  ...zeroUploadsPrepareRoutes,
  ...zeroUsageInsightRoutes,
  ...chatThreadsV1Routes,
  ...audioTranscriptionsV1Routes,
  ...modelStatsRoutes,
];
