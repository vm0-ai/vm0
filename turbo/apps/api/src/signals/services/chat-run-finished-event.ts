import type { ChatRunFinishedRunStatus } from "@okouai/api-contracts/contracts/workflows";

export interface ChatRunFinishedEvent {
  readonly chatThreadId: string;
  readonly runId: string;
  readonly runStatus: ChatRunFinishedRunStatus;
  readonly lastResultText: string | null;
  readonly sourceAgentId: string;
  readonly sourceThreadTitle: string | null;
}
