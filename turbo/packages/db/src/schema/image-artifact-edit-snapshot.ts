import {
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { ImageArtifactEditSnapshotState } from "@okouai/db/jsonb-contracts/image-artifact-edit-snapshot";

export type { ImageArtifactEditSnapshotState } from "@okouai/db/jsonb-contracts/image-artifact-edit-snapshot";

export const imageArtifactEditSnapshots = pgTable(
  "image_artifact_edit_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    artifactUrl: text("artifact_url").notNull(),
    snapshot: jsonb("snapshot")
      .$type<ImageArtifactEditSnapshotState>()
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_image_artifact_edit_snapshots_owner_artifact").on(
        table.orgId,
        table.userId,
        table.artifactUrl,
      ),
    ];
  },
);
