export interface ChatThreadSnapshotProjection {
  readonly id: string;
  readonly agentId: string;
  readonly title: string | null;
  readonly sortAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly pinnedAt: string | null;
  /** Absent in snapshots compacted before manual pin ordering. */
  readonly pinOrder?: string | null;
  readonly renamedAt: string | null;
  readonly selectedModel: string | null;
  readonly serviceTier: "priority" | null;
  readonly computerUseHostId: string | null;
  readonly cloudBrowserEnabled: boolean;
  readonly selectedVideoModel: string | null;
  readonly selectedImageModel: string | null;
}

export type ChatThreadSnapshotProjections = ChatThreadSnapshotProjection[];
