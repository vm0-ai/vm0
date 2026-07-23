#!/usr/bin/env tsx

import { pathToFileURL } from "node:url";

import { and, eq, inArray, sql } from "drizzle-orm";
import { escapeLiteral } from "pg";
import { VM0_MODEL_TO_PROVIDER } from "@vm0/api-contracts/contracts/model-providers";
import { resolveSkillRef } from "@vm0/core/github-url";
import {
  getSkillStorageName,
  SYSTEM_ORG_ID,
  VOLUME_ORG_USER_ID,
} from "@vm0/core/storage-names";
import {
  getSeedSkillNames,
  GOAL_SKILL_NAME,
  SEED_SKILLS,
} from "@vm0/core/zero-seed-skills";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { vm0ApiKeys } from "@vm0/db/schema/vm0-api-key";
import { skills } from "@vm0/db/schema/skill";
import { storages } from "@vm0/db/schema/storage";

import { closeDbPool, db } from "../lib/db";
import { optionalEnv } from "../lib/env";
import { nowDate } from "../lib/time";
import { onRejection } from "../signals/utils";
import rawDevSeedSkillVolumes from "./dev-seed-skill-volumes.json";

function writeLine(message: string): void {
  process.stdout.write(`${message}\n`);
}

/**
 * Populate the development database with pricing, model keys, and skills.
 *
 * Pricing convention: 1 USD = 1000 credits.
 * Prices are per 1M tokens, stored as integer credits per 1M tokens.
 *
 * API keys are read from environment variables per vendor:
 *   DEV_MODEL_{VENDOR_UPPER}_KEY (e.g., DEV_MODEL_ANTHROPIC_KEY, DEV_MODEL_OPENAI_KEY)
 * Anthropic and OpenAI also fall back to their provider env names because
 * CI and local dev already use them for real model smoke tests.
 * DeepSeek and Moonshot also fall back to their provider env names.
 */

/** 1 USD = 1000 credits */
const USD_TO_CREDITS = 1000;

function usd(amount: number): number {
  return Math.round(amount * USD_TO_CREDITS);
}

type UsagePricingRow = readonly [
  category: string,
  unitPrice: number,
  unitSize: number,
];

interface DevSeedSkillVolume {
  readonly url: string;
  readonly name: string;
  readonly s3Key: string;
  readonly message: string;
  readonly fullPath: string;
  readonly s3Prefix: string;
  readonly commitSha: string;
  readonly skillSize: number;
  readonly storageId: string;
  readonly frontmatter: Record<string, unknown>;
  readonly storageName: string;
  readonly storageSize: number;
  readonly versionHash: string;
  readonly versionSize: number;
  readonly skillFileCount: number;
  readonly storageFileCount: number;
  readonly versionFileCount: number;
}

const DEV_SEED_SKILL_VOLUMES: readonly DevSeedSkillVolume[] =
  rawDevSeedSkillVolumes;

const PREVIEW_E2E_VOLUME_SKILL_NAMES: readonly string[] = [
  ...SEED_SKILLS,
  GOAL_SKILL_NAME,
  "github",
  "slack",
  "discord-webhook",
  "zendesk",
  "serpapi",
  "replicate",
];

function getDevSeedSkillVolumes(): readonly DevSeedSkillVolume[] {
  if (optionalEnv("ENV") !== "preview") {
    return DEV_SEED_SKILL_VOLUMES;
  }
  const previewSkillNames = new Set(PREVIEW_E2E_VOLUME_SKILL_NAMES);
  return DEV_SEED_SKILL_VOLUMES.filter((volume) => {
    return previewSkillNames.has(volume.name);
  });
}

function usageGroup(
  kind: string,
  provider: string,
  rows: readonly UsagePricingRow[],
): (typeof usagePricing.$inferInsert)[] {
  return rows.map(([category, unitPrice, unitSize]) => {
    return { kind, provider, category, unitPrice, unitSize };
  });
}

const GPT_5_6_SOL_PRICING: readonly UsagePricingRow[] = [
  ["tokens.input", usd(5), 1_000_000],
  ["tokens.cache_read", usd(0.5), 1_000_000],
  ["tokens.cache_creation", usd(6.25), 1_000_000],
  ["tokens.output", usd(30), 1_000_000],
];

const GPT_5_6_LUNA_PRICING: readonly UsagePricingRow[] = [
  ["tokens.input", usd(1), 1_000_000],
  ["tokens.cache_read", usd(0.1), 1_000_000],
  ["tokens.cache_creation", usd(1.25), 1_000_000],
  ["tokens.output", usd(6), 1_000_000],
];

function buildSeedSkillValues(
  names: readonly string[],
): (typeof skills.$inferInsert)[] {
  return names.map((name) => {
    const url = resolveSkillRef(name);
    const fullPath = url.replace("https://github.com/", "");
    return {
      url,
      name,
      fullPath,
      versionHash: null,
      frontmatter: {
        name,
        description: `${name} skill`,
      },
    };
  });
}

function buildStorageSeedSql(
  systemOrgId: string,
  volumeOrgUserId: string,
): string {
  // This fixture captured the legacy system-skill writer's encoded archive
  // length as versionSize. Preserve the historical size value while also
  // populating the final archive-size metadata for the same shared object.
  return `
  INSERT INTO storages (
    id, org_id, user_id, name, type, s3_prefix, size, file_count, updated_at
  )
  SELECT
    "storageId", ${systemOrgId}, ${volumeOrgUserId}, "storageName", 'volume',
    "s3Prefix", "storageSize", "storageFileCount", seeded_at
  FROM dev_seed_skill_volumes
  ON CONFLICT (org_id, user_id, name) DO UPDATE SET
    s3_prefix = excluded.s3_prefix,
    size = excluded.size,
    file_count = excluded.file_count,
    updated_at = seeded_at
  WHERE (storages.s3_prefix, storages.size, storages.file_count)
    IS DISTINCT FROM
    (excluded.s3_prefix, excluded.size, excluded.file_count);

  INSERT INTO storage_versions (
    id, storage_id, s3_key, size, archive_size, file_count, message, created_by
  )
  SELECT
    volume."versionHash", storage.id, volume."s3Key", volume."versionSize",
    volume."versionSize", volume."versionFileCount", volume.message, 'system'
  FROM dev_seed_skill_volumes AS volume
  JOIN storages AS storage
    ON storage.org_id = ${systemOrgId}
    AND storage.user_id = ${volumeOrgUserId}
    AND storage.name = volume."storageName"
  ON CONFLICT (id) DO UPDATE SET
    storage_id = excluded.storage_id,
    s3_key = excluded.s3_key,
    size = excluded.size,
    archive_size = excluded.archive_size,
    file_count = excluded.file_count,
    message = excluded.message,
    created_by = excluded.created_by
  WHERE (
    storage_versions.storage_id,
    storage_versions.s3_key,
    storage_versions.size,
    storage_versions.archive_size,
    storage_versions.file_count,
    storage_versions.message,
    storage_versions.created_by
  ) IS DISTINCT FROM (
    excluded.storage_id,
    excluded.s3_key,
    excluded.size,
    excluded.archive_size,
    excluded.file_count,
    excluded.message,
    excluded.created_by
  );

  UPDATE storages AS storage SET
    head_version_id = volume."versionHash",
    updated_at = seeded_at
  FROM dev_seed_skill_volumes AS volume
  WHERE storage.org_id = ${systemOrgId}
    AND storage.user_id = ${volumeOrgUserId}
    AND storage.name = volume."storageName"
    AND storage.head_version_id IS DISTINCT FROM volume."versionHash";
`;
}

function buildSkillSeedSql(
  systemOrgId: string,
  volumeOrgUserId: string,
): string {
  return `
  INSERT INTO skills (
    url, name, full_path, storage_id, version_hash, commit_sha, frontmatter,
    s3_key, size, file_count, synced_at, updated_at
  )
  SELECT
    volume.url, volume.name, volume."fullPath", storage.id,
    volume."versionHash", volume."commitSha", volume.frontmatter,
    volume."s3Key", volume."skillSize", volume."skillFileCount", seeded_at,
    seeded_at
  FROM dev_seed_skill_volumes AS volume
  JOIN storages AS storage
    ON storage.org_id = ${systemOrgId}
    AND storage.user_id = ${volumeOrgUserId}
    AND storage.name = volume."storageName"
  ON CONFLICT (url) DO UPDATE SET
    name = excluded.name,
    full_path = excluded.full_path,
    storage_id = excluded.storage_id,
    version_hash = excluded.version_hash,
    commit_sha = excluded.commit_sha,
    frontmatter = excluded.frontmatter,
    s3_key = excluded.s3_key,
    size = excluded.size,
    file_count = excluded.file_count,
    synced_at = excluded.synced_at,
    updated_at = seeded_at
  WHERE (
    skills.name,
    skills.full_path,
    skills.storage_id,
    skills.version_hash,
    skills.commit_sha,
    skills.frontmatter,
    skills.s3_key,
    skills.size,
    skills.file_count
  ) IS DISTINCT FROM (
    excluded.name,
    excluded.full_path,
    excluded.storage_id,
    excluded.version_hash,
    excluded.commit_sha,
    excluded.frontmatter,
    excluded.s3_key,
    excluded.size,
    excluded.file_count
  );
`;
}

async function seedOfficialSkillVolumes(
  database: ReturnType<typeof db>,
  seedSkillVolumes: readonly DevSeedSkillVolume[],
): Promise<number> {
  const seedVolumes = escapeLiteral(JSON.stringify(seedSkillVolumes));
  const systemOrgId = escapeLiteral(SYSTEM_ORG_ID);
  const volumeOrgUserId = escapeLiteral(VOLUME_ORG_USER_ID);
  const body = `
DECLARE
  seeded_at timestamp := CURRENT_TIMESTAMP;
  seed_volumes jsonb := ${seedVolumes}::jsonb;
BEGIN
  CREATE TEMP TABLE dev_seed_skill_volumes ON COMMIT DROP AS
  SELECT *
  FROM jsonb_to_recordset(seed_volumes) AS volume(
    url text,
    name text,
    "s3Key" text,
    message text,
    "fullPath" text,
    "s3Prefix" text,
    "commitSha" varchar(40),
    "skillSize" bigint,
    "storageId" uuid,
    frontmatter jsonb,
    "storageName" varchar(256),
    "storageSize" bigint,
    "versionHash" varchar(64),
    "versionSize" bigint,
    "skillFileCount" integer,
    "storageFileCount" integer,
    "versionFileCount" integer
  );
${buildStorageSeedSql(systemOrgId, volumeOrgUserId)}
${buildSkillSeedSql(systemOrgId, volumeOrgUserId)}
END`;
  await database.execute(sql.raw(`DO ${escapeLiteral(body)}`));

  return seedSkillVolumes.length;
}

const USAGE_PRICING: readonly (typeof usagePricing.$inferInsert)[] = [
  // Model usage in the unified usage_event ledger.
  ...usageGroup("model", "claude-sonnet-4-6", [
    ["tokens.input", usd(3), 1_000_000],
    ["tokens.output", usd(15), 1_000_000],
    ["tokens.cache_read", usd(0.3), 1_000_000],
    ["tokens.cache_creation", usd(3.75), 1_000_000],
  ]),
  ...usageGroup("model", "claude-sonnet-5", [
    ["tokens.input", usd(2), 1_000_000],
    ["tokens.output", usd(10), 1_000_000],
    ["tokens.cache_read", usd(0.2), 1_000_000],
    ["tokens.cache_creation", usd(2.5), 1_000_000],
  ]),
  ...usageGroup("model", "claude-opus-4-6", [
    ["tokens.input", usd(15), 1_000_000],
    ["tokens.output", usd(75), 1_000_000],
    ["tokens.cache_read", usd(1.5), 1_000_000],
    ["tokens.cache_creation", usd(18.75), 1_000_000],
  ]),
  ...usageGroup("model", "claude-opus-4-7", [
    ["tokens.input", usd(5), 1_000_000],
    ["tokens.output", usd(25), 1_000_000],
    ["tokens.cache_read", usd(0.5), 1_000_000],
    ["tokens.cache_creation", usd(6.25), 1_000_000],
  ]),
  ...usageGroup("model", "claude-opus-4-8", [
    ["tokens.input", usd(5), 1_000_000],
    ["tokens.output", usd(25), 1_000_000],
    ["tokens.cache_read", usd(0.5), 1_000_000],
    ["tokens.cache_creation", usd(6.25), 1_000_000],
  ]),
  ...usageGroup("model", "claude-fable-5", [
    ["tokens.input", usd(10), 1_000_000],
    ["tokens.output", usd(50), 1_000_000],
    ["tokens.cache_read", usd(1), 1_000_000],
    ["tokens.cache_creation", usd(12.5), 1_000_000],
  ]),
  ...usageGroup("model", "kimi-k2.6", [
    ["tokens.input", usd(0.6), 1_000_000],
    ["tokens.output", usd(3), 1_000_000],
    ["tokens.cache_read", usd(0.1), 1_000_000],
    ["tokens.cache_creation", usd(0.6), 1_000_000],
  ]),
  ...usageGroup("model", "kimi-k2.5", [
    ["tokens.input", usd(0.6), 1_000_000],
    ["tokens.output", usd(3), 1_000_000],
    ["tokens.cache_read", usd(0.1), 1_000_000],
    ["tokens.cache_creation", usd(0.6), 1_000_000],
  ]),
  ...usageGroup("model", "glm-5.2", [
    ["tokens.input", usd(1.4), 1_000_000],
    ["tokens.output", usd(4.4), 1_000_000],
    ["tokens.cache_read", usd(0.26), 1_000_000],
    ["tokens.cache_creation", usd(1.4), 1_000_000],
  ]),
  ...usageGroup("model", "glm-5.1", [
    ["tokens.input", usd(1.4), 1_000_000],
    ["tokens.output", usd(4.4), 1_000_000],
    ["tokens.cache_read", usd(0.26), 1_000_000],
    ["tokens.cache_creation", usd(1.4), 1_000_000],
  ]),
  ...usageGroup("model", "mimo-v2.5", [
    ["tokens.input", usd(0.14), 1_000_000],
    ["tokens.output", usd(0.28), 1_000_000],
    ["tokens.cache_read", usd(0.0028), 1_000_000],
    ["tokens.cache_creation", 0, 1_000_000],
  ]),
  ...usageGroup("model", "hy3-preview", [
    ["tokens.input", usd(0.063), 1_000_000],
    ["tokens.output", usd(0.21), 1_000_000],
    ["tokens.cache_read", usd(0.021), 1_000_000],
    ["tokens.cache_creation", 0, 1_000_000],
  ]),
  ...usageGroup("model", "MiniMax-M3", [
    ["tokens.input", usd(0.6), 1_000_000],
    ["tokens.output", usd(2.4), 1_000_000],
    ["tokens.cache_read", usd(0.12), 1_000_000],
    ["tokens.cache_creation", 0, 1_000_000],
  ]),
  ...usageGroup("model", "deepseek-v4-pro", [
    ["tokens.input", usd(1.74), 1_000_000],
    ["tokens.output", usd(3.48), 1_000_000],
    ["tokens.cache_read", usd(0.145), 1_000_000],
    ["tokens.cache_creation", 0, 1_000_000],
  ]),
  // OpenAI API pricing retrieved 2026-05-06 from:
  // https://openai.com/api/pricing/
  // https://developers.openai.com/api/docs/pricing
  // GPT-5.6 preview pricing retrieved 2026-07-09 from:
  // https://openai.com/index/previewing-gpt-5-6-sol/
  ...usageGroup("model", "gpt-5.6-sol", GPT_5_6_SOL_PRICING),
  ...usageGroup("model", "gpt-5.6-terra", [
    ["tokens.input", usd(2.5), 1_000_000],
    ["tokens.cache_read", usd(0.25), 1_000_000],
    ["tokens.cache_creation", usd(3.125), 1_000_000],
    ["tokens.output", usd(15), 1_000_000],
  ]),
  ...usageGroup("model", "gpt-5.6-luna", GPT_5_6_LUNA_PRICING),
  ...usageGroup("model", "gpt-5.5", [
    ["tokens.input", usd(5), 1_000_000],
    ["tokens.cache_read", usd(0.5), 1_000_000],
    ["tokens.output", usd(30), 1_000_000],
  ]),
  ...usageGroup("model", "gpt-5.4", [
    ["tokens.input", usd(2.5), 1_000_000],
    ["tokens.cache_read", usd(0.25), 1_000_000],
    ["tokens.output", usd(15), 1_000_000],
  ]),
  ...usageGroup("model", "gpt-5.4-mini", [
    ["tokens.input", usd(0.75), 1_000_000],
    ["tokens.cache_read", usd(0.075), 1_000_000],
    ["tokens.output", usd(4.5), 1_000_000],
  ]),
  // OpenRouter-backed edit helpers. Pricing retrieved 2026-07-10 from:
  // https://developers.openai.com/api/docs/models/gpt-4.1-mini
  // https://ai.google.dev/gemini-api/docs/pricing
  ...usageGroup("model", "openai/gpt-4.1-mini", [
    ["tokens.input", usd(0.4), 1_000_000],
    ["tokens.cache_read", usd(0.1), 1_000_000],
    ["tokens.output", usd(1.6), 1_000_000],
  ]),
  ...usageGroup("model", "google/gemini-3.5-flash", [
    ["tokens.input", usd(1.5), 1_000_000],
    ["tokens.cache_read", usd(0.15), 1_000_000],
    ["tokens.output", usd(9), 1_000_000],
  ]),

  // X connector — https://docs.x.com/x-api/getting-started/pricing
  ...usageGroup("connector", "x", [
    // Reads — $/resource
    ["posts.read", usd(0.005), 1],
    ["user.read", usd(0.01), 1],
    ["dm_event.read", usd(0.01), 1],
    ["following_followers.read", usd(0.01), 1],
    ["list.read", usd(0.005), 1],
    ["space.read", usd(0.005), 1],
    ["community.read", usd(0.005), 1],
    ["note.read", usd(0.005), 1],
    ["media.read", usd(0.005), 1],
    ["analytics.read", usd(0.005), 1],
    ["trend.read", usd(0.01), 1],
    // Writes — $/request
    ["content.create", usd(0.015), 1],
    ["content.create_with_url", usd(0.2), 1],
    ["dm_interaction.create", usd(0.015), 1],
    ["user_interaction.create", usd(0.015), 1],
    ["interaction.delete", usd(0.01), 1],
    ["content.manage", usd(0.005), 1],
    ["list.create", usd(0.01), 1],
    ["list.manage", usd(0.005), 1],
    ["bookmark", usd(0.005), 1],
    ["media_metadata", usd(0.005), 1],
    ["privacy.update", usd(0.01), 1],
    ["mute.delete", usd(0.005), 1],
    ["counts.recent", usd(0.005), 1],
    ["counts.all", usd(0.01), 1],
    // Fallback — priced at the minimum bucket rate across the table above,
    // so an unknown includes key can never be billed at more than X charges
    // for the cheapest known bucket.
    ["__fallback__", usd(0.005), 1],
  ]),

  // Firecrawl single-page scrape fixed vm0 product pricing. Requests disable
  // document parsers so provider cost stays bounded to the exposed modes.
  ...usageGroup("scrape", "firecrawl", [
    ["standard.markdown", usd(0.004), 1],
    ["standard.links", usd(0.004), 1],
    ["enhanced.markdown", usd(0.02), 1],
    ["enhanced.links", usd(0.02), 1],
  ]),

  // Perplexity Search API — https://docs.perplexity.ai/docs/getting-started/pricing
  // Raw provider cost is $5 per 1,000 requests with no token charge.
  ...usageGroup("web-search", "perplexity", [["request", usd(0.005), 1]]),
  // APIDojo Yahoo Finance — https://rapidapi.com/apidojo/api/yahoo-finance1/pricing
  // Pro is $10 per 10,000 requests, so one successful request costs 1 credit.
  ...usageGroup("finance", "apidojo", [["request", usd(0.001), 1]]),

  // Perplexity Agent API People Search fixed vm0 product pricing, reviewed
  // 2026-07-23. The $0.020 retail price covers the $0.005 tool invocation,
  // bounded gpt-5-mini input/output tokens, and operating margin.
  ...usageGroup("people-search", "perplexity", [["request", usd(0.02), 1]]),

  // Gemini 2.5 Flash Image — https://cloud.google.com/vertex-ai/generative-ai/pricing
  // $30/1M output tokens × 1290 tokens per 1024×1024 image = $0.0387/image.
  ...usageGroup("image", "gemini-2.5-flash-image", [
    ["output_image", usd(0.0387), 1],
  ]),

  // Fal-hosted GPT Image models. The endpoints return image URLs without
  // token usage, so built-in generation bills per output image tier at the
  // raw provider cost. Large tiers use the highest documented non-1024x1024
  // price.
  ...usageGroup("image", "gpt-image-2", [
    ["output_image.low.standard", usd(0.006), 1],
    ["output_image.low.large", usd(0.012), 1],
    ["output_image.medium.standard", usd(0.053), 1],
    ["output_image.medium.large", usd(0.101), 1],
    ["output_image.high.standard", usd(0.211), 1],
    ["output_image.high.large", usd(0.401), 1],
  ]),
  ...usageGroup("image", "gpt-image-1.5", [
    ["output_image.low.standard", usd(0.009), 1],
    ["output_image.low.large", usd(0.013), 1],
    ["output_image.medium.standard", usd(0.034), 1],
    ["output_image.medium.large", usd(0.051), 1],
    ["output_image.high.standard", usd(0.133), 1],
    ["output_image.high.large", usd(0.2), 1],
  ]),
  ...usageGroup("image", "gpt-image-1", [
    ["output_image.low.standard", usd(0.011), 1],
    ["output_image.low.large", usd(0.016), 1],
    ["output_image.medium.standard", usd(0.042), 1],
    ["output_image.medium.large", usd(0.063), 1],
    ["output_image.high.standard", usd(0.167), 1],
    ["output_image.high.large", usd(0.25), 1],
  ]),
  ...usageGroup("image", "gpt-image-1-mini", [
    ["output_image.low.standard", usd(0.005), 1],
    ["output_image.low.large", usd(0.006), 1],
    ["output_image.medium.standard", usd(0.011), 1],
    ["output_image.medium.large", usd(0.015), 1],
    ["output_image.high.standard", usd(0.036), 1],
    ["output_image.high.large", usd(0.052), 1],
  ]),

  // fal.ai image generation — billed by model-specific output unit at the raw
  // provider cost.
  ...usageGroup("image", "fal-ai/flux-pro/v1.1", [
    ["output_megapixel", usd(0.04), 1],
  ]),
  ...usageGroup("image", "fal-ai/flux-pro/v1.1-ultra", [
    ["output_image", usd(0.06), 1],
  ]),
  ...usageGroup("image", "fal-ai/qwen-image", [
    ["output_megapixel", usd(0.02), 1],
  ]),
  ...usageGroup("image", "fal-ai/bytedance/seedream/v4/text-to-image", [
    ["output_image", usd(0.03), 1],
  ]),
  ...usageGroup("image", "fal-ai/nano-banana-2", [
    ["output_image", usd(0.08), 1],
  ]),
  // Background removal transform (fal cost is $0).
  ...usageGroup("image", "fal-ai/birefnet/v2", [["output_image", usd(0), 1]]),
  // Upscale/HD transform, billed per output megapixel.
  ...usageGroup("image", "fal-ai/clarity-upscaler", [
    ["output_megapixel", usd(0.03), 1],
  ]),

  // BytePlus ModelArk video generation (raw provider cost).
  ...usageGroup("video", "dreamina-seedance-2-0-260128", [
    ["output_video_tokens.480p_720p.no_video", usd(7), 1_000_000],
    ["output_video_tokens.480p_720p.with_video", usd(4.3), 1_000_000],
    ["output_video_tokens.1080p.no_video", usd(7.7), 1_000_000],
    ["output_video_tokens.1080p.with_video", usd(4.7), 1_000_000],
  ]),
  ...usageGroup("video", "dreamina-seedance-2-0-fast-260128", [
    ["output_video_tokens.480p_720p.no_video", usd(5.6), 1_000_000],
    ["output_video_tokens.480p_720p.with_video", usd(3.3), 1_000_000],
  ]),
  ...usageGroup("video", "seedance-1-5-pro-251215", [
    ["output_video_tokens.audio", usd(2.4), 1_000_000],
    ["output_video_tokens.silent", usd(1.2), 1_000_000],
  ]),

  // OpenAI GPT-4o mini TTS — https://platform.openai.com/docs/pricing
  // $0.015/minute raw provider cost = 15 credits/minute.
  ...usageGroup("audio", "gpt-4o-mini-tts", [
    ["output_audio_seconds", usd(0.015), 60],
  ]),
];

function getVendorApiKeyEnvVars(vendor: string): string[] {
  const envVar = `DEV_MODEL_${vendor.toUpperCase()}_KEY`;
  if (vendor === "anthropic") {
    return [envVar, "ANTHROPIC_API_KEY"];
  }
  if (vendor === "openai") {
    return [envVar, "OPENAI_API_KEY"];
  }
  if (vendor === "deepseek") {
    return [envVar, "DEEPSEEK_API_KEY"];
  }
  if (vendor === "moonshot") {
    return [envVar, "MOONSHOT_API_KEY"];
  }
  return [envVar];
}

type OptionalEnvReader = (name: string) => string | undefined;
type LineWriter = (message: string) => void;

/**
 * Build vm0_api_keys entries from environment variables.
 * Vendor-to-model mapping is derived from VM0_MODEL_TO_PROVIDER so new models
 * are automatically picked up. Rows use upstream API model ids when configured
 * because VM0 Managed key lookup first matches vendor plus runtime model.
 */
export function buildVm0ApiKeys(
  readEnv: OptionalEnvReader = optionalEnv,
  logLine: LineWriter = writeLine,
): (typeof vm0ApiKeys.$inferInsert)[] {
  // Group runtime models by vendor from the canonical mapping.
  const vendorModels = new Map<string, string[]>();
  for (const [model, { apiModel, vendor }] of Object.entries(
    VM0_MODEL_TO_PROVIDER,
  )) {
    const models = vendorModels.get(vendor) ?? [];
    models.push(apiModel ?? model);
    vendorModels.set(vendor, models);
  }

  const keys: (typeof vm0ApiKeys.$inferInsert)[] = [];
  for (const [vendor, models] of vendorModels) {
    const envVars = getVendorApiKeyEnvVars(vendor);
    const apiKey = envVars
      .map((name) => {
        return readEnv(name);
      })
      .find((value): value is string => {
        return typeof value === "string" && value.length > 0;
      });
    if (!apiKey) {
      logLine(`Skipping ${vendor}: ${envVars.join(" or ")} is not configured`);
      continue;
    }
    for (const model of models) {
      keys.push({ vendor, model, apiKey, label: "dev-seed" });
    }
  }
  return keys;
}

async function devSeed() {
  if (!optionalEnv("DATABASE_URL")) {
    throw new Error("DATABASE_URL environment variable is not set");
  }

  const database = db();

  // --- usage_pricing (batch upsert) ---
  writeLine("Seeding usage_pricing");
  await database
    .insert(usagePricing)
    .values([...USAGE_PRICING])
    .onConflictDoUpdate({
      target: [usagePricing.kind, usagePricing.provider, usagePricing.category],
      set: {
        unitPrice: sql`excluded.unit_price`,
        unitSize: sql`excluded.unit_size`,
        updatedAt: nowDate(),
      },
    });
  writeLine(`Seeded ${USAGE_PRICING.length} usage pricing entries`);

  // --- vm0_api_keys (transactional replace) ---
  writeLine("Seeding vm0_api_keys");
  const apiKeys = buildVm0ApiKeys();
  await database.transaction(async (tx) => {
    await tx.delete(vm0ApiKeys);
    if (apiKeys.length > 0) {
      await tx.insert(vm0ApiKeys).values(apiKeys);
    }
  });
  for (const k of apiKeys) {
    writeLine(`Seeded vm0 API key entry: ${k.vendor}/${k.model}`);
  }
  writeLine(`Seeded ${apiKeys.length} vm0 API key entries`);

  // --- skills (seed skills + common connectors, including system volumes) ---
  const seedSkillVolumes = getDevSeedSkillVolumes();
  writeLine("Seeding official skill volumes");
  const seededVolumeCount = await seedOfficialSkillVolumes(
    database,
    seedSkillVolumes,
  );
  writeLine(`Seeded ${seededVolumeCount} official skill volume entries`);

  const seededVolumeStorageNames = new Set(
    seedSkillVolumes.map((volume) => {
      return volume.storageName;
    }),
  );
  const fallbackSkillValues = buildSeedSkillValues(
    getSeedSkillNames().filter((name) => {
      const fullPath = resolveSkillRef(name).replace("https://github.com/", "");
      return !seededVolumeStorageNames.has(getSkillStorageName(fullPath));
    }),
  );
  if (fallbackSkillValues.length > 0) {
    const timestamp = nowDate();
    const fallbackStorageNames = fallbackSkillValues.map((skill) => {
      return getSkillStorageName(skill.fullPath);
    });
    let insertedCount = 0;
    await database.transaction(async (tx) => {
      const inserted = await tx
        .insert(skills)
        .values(fallbackSkillValues)
        .onConflictDoUpdate({
          target: skills.url,
          set: {
            name: sql`excluded.name`,
            fullPath: sql`excluded.full_path`,
            storageId: null,
            versionHash: null,
            commitSha: null,
            frontmatter: sql`excluded.frontmatter`,
            s3Key: null,
            size: 0,
            fileCount: 0,
            syncedAt: null,
            updatedAt: timestamp,
          },
        })
        .returning({ id: skills.id });
      insertedCount = inserted.length;

      await tx
        .delete(storages)
        .where(
          and(
            eq(storages.orgId, SYSTEM_ORG_ID),
            eq(storages.userId, VOLUME_ORG_USER_ID),
            inArray(storages.name, fallbackStorageNames),
          ),
        );
    });
    writeLine(
      `Seeded ${insertedCount} metadata-only skills and cleared stale volumes`,
    );
  }
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return (
    entrypoint !== undefined &&
    import.meta.url === pathToFileURL(entrypoint).href
  );
}

async function runDevSeed(): Promise<void> {
  await onRejection(devSeed(), closeDbPool);
  await closeDbPool();
}

if (isMainModule()) {
  await runDevSeed();
}
