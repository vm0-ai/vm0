import type { AppRoute } from "@ts-rest/core";
import { healthContract } from "@vm0/api-contracts/contracts/health";

import { audioTranscriptionsV1Routes } from "./routes/audio-transcriptions-v1";
import type { SignalRouteHandler } from "./context/route";
import { chatThreadsV1Routes } from "./routes/chat-threads-v1";
import { deviceTokenRoutes } from "./routes/device-token";
import { apiHealth$ } from "./routes/health";
import { healthAuthProbeRoutes } from "./routes/health-auth-probe";
import { modelStatsRoutes } from "./routes/model-stats";
import { zeroAgentsRoutes } from "./routes/zero-agents";
import { zeroApiKeysRoutes } from "./routes/zero-api-keys";
import { zeroBillingAutoRechargeRoutes } from "./routes/zero-billing-auto-recharge";
import { zeroBillingStatusRoutes } from "./routes/zero-billing-status";
import { zeroChatThreadRoutes } from "./routes/zero-chat-threads";
import { zeroComposesRoutes } from "./routes/zero-composes";
import { zeroComputerUseRoutes } from "./routes/zero-computer-use";
import { zeroConnectorsRoutes } from "./routes/zero-connectors";
import { zeroCustomConnectorsRoutes } from "./routes/zero-custom-connectors";
import { zeroFeatureSwitchesRoutes } from "./routes/zero-feature-switches";
import { zeroInsightsRoutes } from "./routes/zero-insights";
import { zeroMemberCreditCapRoutes } from "./routes/zero-member-credit-cap";
import { zeroModelProvidersRoutes } from "./routes/zero-model-providers";
import { zeroOnboardingStatusRoutes } from "./routes/zero-onboarding-status";
import { zeroQueuePositionRoutes } from "./routes/zero-queue-position";
import { zeroRunsRoutes } from "./routes/zero-runs";
import { zeroSchedulesRoutes } from "./routes/zero-schedules";
import { zeroSecretsRoutes } from "./routes/zero-secrets";
import { zeroSkillsRoutes } from "./routes/zero-skills";
import { zeroSlackConnectRoutes } from "./routes/zero-slack-connect";
import { zeroTeamRoutes } from "./routes/zero-team";
import { zeroUsageInsightRoutes } from "./routes/zero-usage-insight";
import { zeroUserPreferencesRoutes } from "./routes/zero-user-preferences";
import { zeroVoiceIoQuotaRoutes } from "./routes/zero-voice-io-quota";

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
  ...zeroAgentsRoutes,
  ...zeroApiKeysRoutes,
  ...zeroBillingAutoRechargeRoutes,
  ...zeroBillingStatusRoutes,
  ...zeroChatThreadRoutes,
  ...zeroComposesRoutes,
  ...zeroComputerUseRoutes,
  ...zeroConnectorsRoutes,
  ...zeroCustomConnectorsRoutes,
  ...zeroFeatureSwitchesRoutes,
  ...zeroInsightsRoutes,
  ...zeroMemberCreditCapRoutes,
  ...zeroModelProvidersRoutes,
  ...zeroVoiceIoQuotaRoutes,
  ...zeroQueuePositionRoutes,
  ...zeroRunsRoutes,
  ...zeroSchedulesRoutes,
  ...zeroOnboardingStatusRoutes,
  ...zeroUserPreferencesRoutes,
  ...zeroSecretsRoutes,
  ...zeroSkillsRoutes,
  ...zeroSlackConnectRoutes,
  ...zeroTeamRoutes,
  ...zeroUsageInsightRoutes,
  ...chatThreadsV1Routes,
  ...audioTranscriptionsV1Routes,
  ...modelStatsRoutes,
];
