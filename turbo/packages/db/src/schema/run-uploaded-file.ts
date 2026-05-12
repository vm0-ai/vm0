import {
  bigint,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { agentRuns } from "./agent-run";

export const RUN_UPLOADED_FILE_SOURCES = [
  "schedule",
  "web",
  "slack",
  "email",
  "telegram",
  "agentphone",
  "github",
  "cli",
  "agent",
  "voice-chat",
] as const;
export type RunUploadedFileSource = (typeof RUN_UPLOADED_FILE_SOURCES)[number];

export const runUploadedFiles = pgTable(
  "run_uploaded_files",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(
        () => {
          return agentRuns.id;
        },
        { onDelete: "cascade" },
      ),
    source: varchar("source", { length: 32 }).notNull(),
    externalId: text("external_id").notNull(),
    userId: text("user_id").notNull(),
    orgId: text("org_id"),
    filename: text("filename"),
    contentType: text("content_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    url: text("url"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_run_uploaded_files_run").on(table.runId),
      uniqueIndex("idx_run_uploaded_files_run_source_external").on(
        table.runId,
        table.source,
        table.externalId,
      ),
      index("idx_run_uploaded_files_source_external").on(
        table.source,
        table.externalId,
      ),
    ];
  },
);
