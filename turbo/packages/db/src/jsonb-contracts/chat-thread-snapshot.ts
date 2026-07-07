export interface ChatThreadSnapshotProjection {
  readonly id: string;
  readonly agentId: string;
  readonly title: string | null;
  readonly sortAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly pinnedAt: string | null;
  readonly renamedAt: string | null;
  readonly selectedModel: string | null;
}

export type ChatThreadSnapshotProjections = ChatThreadSnapshotProjection[];
