export interface ImageArtifactEditSnapshotItem {
  readonly url: string;
  readonly x: number;
  readonly y: number;
  readonly zIndex: number;
}

export interface ImageArtifactEditSnapshotState {
  readonly items: readonly ImageArtifactEditSnapshotItem[];
  readonly version: 1;
}
