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
  s3_prefix: z.string(),
  s3_key: z.string(),
  size: z.number(),
  file_count: z.number(),
  frontmatter: z.unknown(),
});

const skillRowSchema = z.object({
  full_path: z.string(),
  commit_sha: z.string().nullable(),
  version_hash: z.string().nullable(),
  file_count: z.number(),
  frontmatter: z.unknown(),
});

const storageRowSchema = z.object({
  type: z.string(),
  head_version_id: z.string().nullable(),
});

export const testCronSyncSkillsStateActionBodySchema = z.discriminatedUnion(
  "action",
  [
    z.object({
      action: z.literal("cleanup-official-test-skills"),
      url_prefix: z.string(),
    }),
    z.object({
      action: z.literal("set-all-skills-commit-sha"),
      skill_name: z.string(),
      url: z.string(),
      full_path: z.string(),
      commit_sha: z.string(),
      frontmatter: z.unknown(),
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
});

export type TestCronSyncSkillsStateContract =
  typeof testCronSyncSkillsStateContract;
export type TestCronSyncSkillsStateActionBody = z.infer<
  typeof testCronSyncSkillsStateActionBodySchema
>;
export type TestCronSyncSkillsStateActionResponse = z.infer<
  typeof testCronSyncSkillsStateActionResponseSchema
>;
export type TestCronSyncSkillsStateSkillVersionSeed = z.infer<
  typeof skillVersionSeedSchema
>;
