import type { AppRoute } from "@ts-rest/core";
import { healthContract } from "@vm0/api-contracts/contracts/health";
import { zeroRunAgentEventsContract } from "@vm0/api-contracts/contracts/zero-runs";

import { promoteToApiSource } from "./context/shadow-compare";

import { audioTranscriptionsV1Routes } from "./routes/audio-transcriptions-v1";
import type { SignalRouteHandler } from "./context/route";
import { chatThreadsV1Routes } from "./routes/chat-threads-v1";
import { deviceTokenRoutes } from "./routes/device-token";
import { apiHealth$ } from "./routes/health";
import { healthAuthProbeRoutes } from "./routes/health-auth-probe";
import { modelStatsRoutes } from "./routes/model-stats";
import { zeroAgentInstructionsRoutes } from "./routes/zero-agent-instructions";
import { zeroAgentsRoutes } from "./routes/zero-agents";
import { zeroApiKeysRoutes } from "./routes/zero-api-keys";
import { zeroBillingAutoRechargeRoutes } from "./routes/zero-billing-auto-recharge";
import { zeroBillingInvoicesRoutes } from "./routes/zero-billing-invoices";
import { zeroBillingStatusRoutes } from "./routes/zero-billing-status";
import { zeroChatThreadRoutes } from "./routes/zero-chat-threads";
import { zeroComposesRoutes } from "./routes/zero-composes";
import { zeroComputerUseRoutes } from "./routes/zero-computer-use";
import { zeroConnectorsRoutes } from "./routes/zero-connectors";
import { zeroCustomConnectorsRoutes } from "./routes/zero-custom-connectors";
import { zeroFeatureSwitchesRoutes } from "./routes/zero-feature-switches";
import { zeroInsightsRoutes } from "./routes/zero-insights";
import { zeroLogsRoutes } from "./routes/zero-logs";
import { zeroMemberCreditCapRoutes } from "./routes/zero-member-credit-cap";
import { zeroModelProvidersRoutes } from "./routes/zero-model-providers";
import { zeroOnboardingStatusRoutes } from "./routes/zero-onboarding-status";
import { zeroOrgReadRoutes } from "./routes/zero-org-read";
import { zeroQueuePositionRoutes } from "./routes/zero-queue-position";
import { zeroRunDetailRoutes } from "./routes/zero-run-detail";
import { zeroRunsRoutes } from "./routes/zero-runs";
import { zeroSchedulesRoutes } from "./routes/zero-schedules";
import { zeroSecretsRoutes } from "./routes/zero-secrets";
import { zeroSkillsRoutes } from "./routes/zero-skills";
import { zeroIntegrationsSlackRoutes } from "./routes/zero-integrations-slack";
import { zeroIntegrationsTelegramRoutes } from "./routes/zero-integrations-telegram";
import { zeroSlackChannelsRoutes } from "./routes/zero-slack-channels";
import { zeroSlackConnectRoutes } from "./routes/zero-slack-connect";
import { zeroTeamRoutes } from "./routes/zero-team";
import { zeroUsageInsightRoutes } from "./routes/zero-usage-insight";
import { zeroUserPreferencesRoutes } from "./routes/zero-user-preferences";
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
  ...deviceTokenRoutes,
  ...zeroAgentInstructionsRoutes,
  ...zeroAgentsRoutes,
  ...zeroApiKeysRoutes,
  ...zeroBillingAutoRechargeRoutes,
  ...zeroBillingInvoicesRoutes,
  ...zeroBillingStatusRoutes,
  ...zeroChatThreadRoutes,
  ...zeroComposesRoutes,
  ...zeroComputerUseRoutes,
  ...zeroConnectorsRoutes,
  ...zeroCustomConnectorsRoutes,
  ...zeroFeatureSwitchesRoutes,
  ...zeroInsightsRoutes,
  ...zeroLogsRoutes,
  ...zeroMemberCreditCapRoutes,
  ...zeroModelProvidersRoutes,
  ...zeroVoiceChatRoutes,
  ...zeroVoiceIoQuotaRoutes,
  ...zeroWebDownloadRoutes,
  ...zeroQueuePositionRoutes,
  ...zeroRunDetailRoutes,
  ...zeroRunsRoutes,
  ...zeroSchedulesRoutes,
  ...zeroOnboardingStatusRoutes,
  ...zeroOrgReadRoutes,
  ...zeroUserPreferencesRoutes,
  ...zeroSecretsRoutes,
  ...zeroSkillsRoutes,
  ...zeroSlackConnectRoutes,
  ...zeroIntegrationsSlackRoutes,
  ...zeroSlackChannelsRoutes,
  ...zeroIntegrationsTelegramRoutes,
  ...zeroTeamRoutes,
  ...zeroUsageInsightRoutes,
  ...chatThreadsV1Routes,
  ...audioTranscriptionsV1Routes,
  ...modelStatsRoutes,
];

promoteToApiSource([zeroRunAgentEventsContract.getAgentEvents]);
