export type ArtifactMissingRootPolicy = "fail" | "preserveParentVersion";

export interface ContextArtifact {
  name: string;
  version?: string;
  mountPath: string;
  missingRootPolicy?: ArtifactMissingRootPolicy;
}
