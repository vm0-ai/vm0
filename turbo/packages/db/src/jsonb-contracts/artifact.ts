/**
 * Static preview image for an artifact card. Kept as JSONB so the catalog can
 * grow richer thumbnail descriptors without a schema migration.
 */
export interface ArtifactThumbnail {
  readonly url: string;
}
