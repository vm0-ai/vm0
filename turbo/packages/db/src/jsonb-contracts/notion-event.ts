export interface NotionWorkflowPendingEventContext {
  readonly workspaceId: string;
  readonly workspaceName: string | null;
  readonly authors: readonly {
    readonly id: string;
    readonly type: string;
  }[];
  readonly attemptNumber: number | null;
}

export type NotionWorkflowPendingEventContextJson =
  NotionWorkflowPendingEventContext | null;
