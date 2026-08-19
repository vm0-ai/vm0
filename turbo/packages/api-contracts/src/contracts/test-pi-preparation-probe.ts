import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const piPreparationProbeProfileSchema = z.enum([
  "minimal",
  "representative",
  "session-16-mib",
  "session-64-mib",
  "assets-32-mib",
]);

export const piPreparationProbeModeSchema = z.enum(["filesystem", "memory"]);

const durationSchema = z.number().nonnegative();

const officialPreparationSchema = z.object({
  agent_session_create_ms: durationSchema,
  agents_file_count: z.int().nonnegative(),
  diagnostic_count: z.int().nonnegative(),
  discovered_skill_count: z.int().nonnegative(),
  model_runtime_create_ms: durationSchema,
  session_entry_count: z.int().nonnegative(),
  session_header_cwd: z.string().nullable(),
  session_list_ms: durationSchema,
  session_open_ms: durationSchema,
  session_persisted: z.boolean(),
  session_services_create_ms: durationSchema,
  settings_manager_create_ms: durationSchema,
  total_ms: durationSchema,
});

export const piPreparationProbeResponseSchema = z.object({
  ok: z.literal(true),
  fixture: z.object({
    agents_bytes: z.int().positive(),
    archive_bytes: z.int().nonnegative(),
    build_ms: durationSchema,
    cache_hit: z.boolean(),
    expected_skill_count: z.int().positive(),
    memory_bytes: z.int().nonnegative(),
    session_bytes: z.int().positive(),
    skill_file_count: z.int().positive(),
    skill_md_bytes: z.int().positive(),
    skill_tree_bytes: z.int().positive(),
  }),
  measurement_limits: z.array(z.string()),
  mode: piPreparationProbeModeSchema,
  network_download_measured: z.literal(false),
  profile: piPreparationProbeProfileSchema,
  runtime: z.object({
    arch: z.string(),
    instance_id: z.uuid(),
    node_version: z.string(),
    platform: z.string(),
    process_uptime_ms: durationSchema,
    region: z.string().nullable(),
    rss_bytes_after: z.int().positive(),
    rss_bytes_before: z.int().positive(),
    tmp_dir: z.string(),
  }),
  samples: z.array(
    z.object({
      archive_extract_ms: durationSchema,
      checkpoint_bytes: z.int().positive(),
      checkpoint_read_ms: durationSchema,
      cleanup_ms: durationSchema,
      lease_create_ms: durationSchema,
      official: officialPreparationSchema,
      peak_rss_bytes: z.int().positive(),
      preparation_ms: durationSchema,
      session_write_ms: durationSchema,
      total_ms: durationSchema,
    }),
  ),
});

export const testPiPreparationProbeContract = c.router({
  run: {
    method: "POST",
    path: "/api/test/pi-preparation-probe",
    body: z.object({
      profile: piPreparationProbeProfileSchema,
      mode: piPreparationProbeModeSchema.default("filesystem"),
      iterations: z.int().min(1).max(5).default(1),
      rebuild_fixture: z.boolean().default(false),
    }),
    responses: {
      200: piPreparationProbeResponseSchema,
      404: z.string(),
    },
    summary: "Measure native Pi filesystem or memory preparation in preview",
  },
});

export type PiPreparationProbeMode = z.infer<
  typeof piPreparationProbeModeSchema
>;

export type PiPreparationProbeProfile = z.infer<
  typeof piPreparationProbeProfileSchema
>;
export type PiPreparationProbeResponse = z.infer<
  typeof piPreparationProbeResponseSchema
>;
export type TestPiPreparationProbeContract =
  typeof testPiPreparationProbeContract;
