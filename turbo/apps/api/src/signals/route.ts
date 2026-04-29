import type { AppRoute } from "@ts-rest/core";
import { healthContract } from "@vm0/api-contracts/contracts/health";

import { audioTranscriptionsV1Routes } from "./routes/audio-transcriptions-v1";
import type { SignalRouteHandler } from "./context/route";
import { chatThreadsV1Routes } from "./routes/chat-threads-v1";
import { deviceTokenRoutes } from "./routes/device-token";
import { apiHealth$ } from "./routes/health";
import { healthAuthProbeRoutes } from "./routes/health-auth-probe";
import { modelStatsRoutes } from "./routes/model-stats";
import { zeroBillingAutoRechargeRoutes } from "./routes/zero-billing-auto-recharge";
import { zeroChatThreadRoutes } from "./routes/zero-chat-threads";
import { zeroFeatureSwitchesRoutes } from "./routes/zero-feature-switches";
import { zeroOnboardingStatusRoutes } from "./routes/zero-onboarding-status";
import { zeroQueuePositionRoutes } from "./routes/zero-queue-position";
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
  ...zeroBillingAutoRechargeRoutes(),
  ...zeroChatThreadRoutes(),
  ...zeroFeatureSwitchesRoutes(),
  ...zeroVoiceIoQuotaRoutes(),
  ...zeroQueuePositionRoutes(),
  ...zeroOnboardingStatusRoutes(),
  ...chatThreadsV1Routes,
  ...audioTranscriptionsV1Routes,
  ...modelStatsRoutes,
];
