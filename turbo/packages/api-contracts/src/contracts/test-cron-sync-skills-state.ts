import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

const testCronSyncSkillsStateErrorSchema = z.object({
  error: z.string(),
});

const skillVersionSeedSchema = z.object({
  name: z.string(),
  url: z.string(),
  full_path: z.string(),
  storage_name: z.string(),
  version_hash: z.string(),
  size: z.number(),
  archive_size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  file_count: z.number(),
  frontmatter: z.unknown(),
});

const ownedSkillSchema = z.object({
  name: z.string(),
  url: z.string(),
  full_path: z.string(),
  frontmatter: z.unknown(),
});

const skillRowSchema = z.object({
  name: z.string(),
  full_path: z.string(),
  commit_sha: z.string().nullable(),
  version_hash: z.string().nullable(),
  file_count: z.number(),
  frontmatter: z.unknown(),
});

const storageRowSchema = z.object({
  head_version_id: z.string().nullable(),
  s3_prefix: z.string(),
  size: z.number(),
  version_size: z.number().nullable(),
  archive_size: z.number().nullable(),
});

export const testCronSyncSkillsStateActionBodySchema = z.discriminatedUnion(
  "action",
  [
    z.object({
      action: z.literal("cleanup-owned-skills"),
      skill_urls: z.array(z.string()),
      storage_names: z.array(z.string()),
    }),
    z.object({
      action: z.literal("set-owned-skills-commit-sha"),
      skills: z.array(ownedSkillSchema).min(1),
      commit_sha: z.string(),
    }),
    z.object({
      action: z.literal("seed-current-skill-versions"),
      stale_commit_sha: z.string(),
      versions: z.array(skillVersionSeedSchema),
    }),
    z.object({
      action: z.literal("read-skill-by-url"),
      url: z.string(),
    }),
    z.object({
      action: z.literal("read-storage-by-name"),
      name: z.string(),
    }),
  ],
);

export const testCronSyncSkillsStateActionResponseSchema = z.object({
  ok: z.literal(true),
  skill: skillRowSchema.nullable().optional(),
  storage: storageRowSchema.nullable().optional(),
});

const testCronSyncSkillsStateSyncBodySchema = z.object({
  skill_name_prefix: z.string().regex(/^api-test-skill-[0-9a-f]{32}-$/),
  required_skill_names: z.array(z.string()).min(1),
});

const testCronSyncSkillsStateSyncResponseSchema = z.object({
  success: z.literal(true),
  commitSha: z.string(),
  synced: z.number(),
  skipped: z.number(),
  failed: z.number(),
  removed: z.number(),
  total: z.number(),
});

export const testCronSyncSkillsStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/cron-sync-skills-state/action",
    body: testCronSyncSkillsStateActionBodySchema,
    responses: {
      200: testCronSyncSkillsStateActionResponseSchema,
      400: testCronSyncSkillsStateErrorSchema,
      404: z.string(),
    },
    summary: "Mutate and read cron sync skills API test support state",
  },
  sync: {
    method: "POST",
    path: "/api/test/cron-sync-skills-state/sync",
    body: testCronSyncSkillsStateSyncBodySchema,
    responses: {
      200: testCronSyncSkillsStateSyncResponseSchema,
      400: testCronSyncSkillsStateErrorSchema,
      404: z.string(),
    },
    summary: "Sync the explicitly scoped skills fixture in API tests",
  },
});

export type TestCronSyncSkillsStateContract =
  typeof testCronSyncSkillsStateContract;
export type TestCronSyncSkillsStateActionBody = z.infer<
  typeof testCronSyncSkillsStateActionBodySchema
>;
export type TestCronSyncSkillsStateActionResponse = z.infer<
  typeof testCronSyncSkillsStateActionResponseSchema
>;
export type TestCronSyncSkillsStateSyncResponse = z.infer<
  typeof testCronSyncSkillsStateSyncResponseSchema
>;
export type TestCronSyncSkillsStateSkillVersionSeed = z.infer<
  typeof skillVersionSeedSchema
>;
