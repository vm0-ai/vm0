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

export interface PiResourceSnapshot {
  readonly schemaVersion: 1;
  readonly agentsFiles: readonly PiResourceSnapshotAgentsFile[];
  readonly skills: readonly PiResourceSnapshotSkill[];
}
