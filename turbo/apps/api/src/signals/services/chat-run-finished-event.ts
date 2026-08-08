import type { ChatRunFinishedRunStatus } from "@vm0/api-contracts/contracts/zero-workflows";

export interface ChatRunFinishedEvent {
  readonly chatThreadId: string;
  readonly runId: string;
  readonly runStatus: ChatRunFinishedRunStatus;
  readonly lastResultText: string | null;
}
