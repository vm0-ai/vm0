export interface PiResourceSnapshotAgentsFile {
  readonly path: string;
  readonly content: string;
}

export interface PiResourceSnapshotSkill {
  readonly name: string;
  readonly description: string;
  readonly filePath: string;
  readonly baseDir: string;
  readonly scope: "user" | "project" | "temporary";
  readonly disableModelInvocation: boolean;
}

export interface PiResourceSnapshotV1 {
  readonly schemaVersion: 1;
  readonly agentsFiles: readonly PiResourceSnapshotAgentsFile[];
  readonly skills: readonly PiResourceSnapshotSkill[];
}

export type PiMemoryRecallSelection =
  | {
      readonly status: "no-content";
      readonly memoryStorageId: string;
      readonly storageVersionId: string;
    }
  | {
      readonly status: "ready";
      readonly memoryStorageId: string;
      readonly storageVersionId: string;
      readonly content: string;
      readonly sourceHash: string;
      readonly sourceSize: number;
      readonly tokenCount: number;
    };

export interface PiResourceSnapshotV2 {
  readonly schemaVersion: 2;
  readonly agentsFiles: readonly PiResourceSnapshotAgentsFile[];
  readonly skills: readonly PiResourceSnapshotSkill[];
  readonly memoryRecall: PiMemoryRecallSelection;
}

export type PiResourceSnapshot = PiResourceSnapshotV1 | PiResourceSnapshotV2;
