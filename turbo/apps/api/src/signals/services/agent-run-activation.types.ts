import type {
  RunnerJobNotification,
  RunnerJobPreActivationTiming,
} from "./runner-dispatch.service";
import type { PiApiFirstTurnActivation } from "./pi-api-first-turn-config";

export interface PendingRunActivation {
  readonly apiStartTime: number;
  readonly chatThreadId: string | undefined;
  readonly runnerNotification: RunnerJobNotification;
  readonly timing: RunnerJobPreActivationTiming;
  readonly piApiFirstTurn?: PiApiFirstTurnActivation;
}
