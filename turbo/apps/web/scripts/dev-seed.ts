#!/usr/bin/env tsx

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, sql } from "drizzle-orm";
import { getEligibleConnectorTypes } from "@vm0/connectors/connector-utils";
import { VM0_MODEL_TO_PROVIDER } from "@vm0/api-contracts/contracts/model-providers";
import { schema } from "@vm0/db";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { vm0ApiKeys } from "@vm0/db/schema/vm0-api-key";
import { skills } from "@vm0/db/schema/skill";
import { SEED_SKILLS, buildSeedSkillValues } from "../src/lib/zero/seed-skills";

/**
 * Dev seed: populate usage_pricing, vm0_api_keys, and skills tables.
 *
 * Pricing convention: 1 USD = 1000 credits.
 * Prices are per 1M tokens, stored as integer credits per 1M tokens.
 *
 * API keys are read from environment variables per vendor:
 *   DEV_MODEL_{VENDOR_UPPER}_KEY (e.g., DEV_MODEL_ANTHROPIC_KEY, DEV_MODEL_OPENAI_KEY)
 */

/** 1 USD = 1000 credits */
const USD_TO_CREDITS = 1000;

function usd(amount: number): number {
  return Math.round(amount * USD_TO_CREDITS);
}

type UsagePricingRow = [category: string, unitPrice: number, unitSize: number];

function usageGroup(
  kind: string,
  provider: string,
  rows: UsagePricingRow[],
): (typeof usagePricing.$inferInsert)[] {
  return rows.map(([category, unitPrice, unitSize]) => {
    return { kind, provider, category, unitPrice, unitSize };
  });
}

const USAGE_PRICING: (typeof usagePricing.$inferInsert)[] = [
  // Model usage in the unified usage_event ledger.
  ...usageGroup("model", "claude-sonnet-4-6", [
    ["tokens.input", usd(3), 1_000_000],
    ["tokens.output", usd(15), 1_000_000],
    ["tokens.cache_read", usd(0.3), 1_000_000],
    ["tokens.cache_creation", usd(3.75), 1_000_000],
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
  ...usageGroup("model", "claude-haiku-4-5", [
    ["tokens.input", usd(1), 1_000_000],
    ["tokens.output", usd(5), 1_000_000],
    ["tokens.cache_read", usd(0.1), 1_000_000],
    ["tokens.cache_creation", usd(1.25), 1_000_000],
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
  ...usageGroup("model", "glm-5.1", [
    ["tokens.input", usd(1.4), 1_000_000],
    ["tokens.output", usd(4.4), 1_000_000],
    ["tokens.cache_read", usd(0.26), 1_000_000],
    ["tokens.cache_creation", usd(1.4), 1_000_000],
  ]),
  ...usageGroup("model", "MiniMax-M2.7", [
    ["tokens.input", usd(0.3), 1_000_000],
    ["tokens.output", usd(1.2), 1_000_000],
    ["tokens.cache_read", usd(0.06), 1_000_000],
    ["tokens.cache_creation", usd(0.375), 1_000_000],
  ]),
  ...usageGroup("model", "deepseek-v4-pro", [
    ["tokens.input", usd(1.74), 1_000_000],
    ["tokens.output", usd(3.48), 1_000_000],
    ["tokens.cache_read", usd(0.145), 1_000_000],
    ["tokens.cache_creation", 0, 1_000_000],
  ]),
  ...usageGroup("model", "deepseek-v4-flash", [
    ["tokens.input", usd(0.14), 1_000_000],
    ["tokens.output", usd(0.28), 1_000_000],
    ["tokens.cache_read", usd(0.028), 1_000_000],
    ["tokens.cache_creation", 0, 1_000_000],
  ]),
  // OpenAI API pricing retrieved 2026-05-06 from:
  // https://openai.com/api/pricing/
  // https://developers.openai.com/api/docs/pricing
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
  ...usageGroup("model", "gpt-5.3-codex", [
    ["tokens.input", usd(1.75), 1_000_000],
    ["tokens.cache_read", usd(0.175), 1_000_000],
    ["tokens.output", usd(14), 1_000_000],
  ]),
  ...usageGroup("model", "gpt-5.2", [
    ["tokens.input", usd(1.75), 1_000_000],
    ["tokens.cache_read", usd(0.175), 1_000_000],
    ["tokens.output", usd(14), 1_000_000],
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

  // Gemini 2.5 Flash Image — https://cloud.google.com/vertex-ai/generative-ai/pricing
  // $30/1M output tokens × 1290 tokens per 1024×1024 image = $0.0387/image.
  ...usageGroup("image", "gemini-2.5-flash-image", [
    ["output_image", usd(0.0387), 1],
  ]),

  // OpenAI GPT Image 2 — https://platform.openai.com/docs/pricing
  // Uses the exact token usage returned by the Images API with 20% markup.
  ...usageGroup("image", "gpt-image-2", [
    ["tokens.input.text", usd(6), 1_000_000],
    ["tokens.input.image", usd(9.6), 1_000_000],
    ["tokens.output.image", usd(36), 1_000_000],
  ]),

  // OpenAI GPT-4o mini TTS — https://platform.openai.com/docs/pricing
  // $0.015/minute cost with 20% gross margin = $0.01875/minute,
  // rounded to 19 credits/minute.
  ...usageGroup("audio", "gpt-4o-mini-tts", [
    ["output_audio_seconds", usd(0.01875), 60],
  ]),
];

/**
 * Build vm0_api_keys entries from environment variables.
 * Vendor-to-model mapping is derived from VM0_MODEL_TO_PROVIDER
 * so new models are automatically picked up.
 */
function buildVm0ApiKeys(): (typeof vm0ApiKeys.$inferInsert)[] {
  // Group models by vendor from the canonical mapping
  const vendorModels = new Map<string, string[]>();
  for (const [model, { vendor }] of Object.entries(VM0_MODEL_TO_PROVIDER)) {
    const models = vendorModels.get(vendor) ?? [];
    models.push(model);
    vendorModels.set(vendor, models);
  }

  const keys: (typeof vm0ApiKeys.$inferInsert)[] = [];
  for (const [vendor, models] of vendorModels) {
    const envVar = `DEV_MODEL_${vendor.toUpperCase()}_KEY`;
    const apiKey = process.env[envVar];
    if (!apiKey) {
      console.log(`  ⚠ ${envVar} not set, skipping ${vendor}`);
      continue;
    }
    for (const model of models) {
      keys.push({ vendor, model, apiKey, label: "dev-seed" });
    }
  }
  return keys;
}

async function devSeed() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL environment variable is not set");
  }

  const client = postgres(process.env.DATABASE_URL, { max: 1 });
  const db = drizzle(client, { schema });

  try {
    // --- usage_pricing (batch upsert) ---
    console.log("Seeding usage_pricing...");
    for (const p of USAGE_PRICING) {
      await db
        .insert(usagePricing)
        .values(p)
        .onConflictDoUpdate({
          target: [
            usagePricing.kind,
            usagePricing.provider,
            usagePricing.category,
          ],
          set: {
            unitPrice: sql`excluded.unit_price`,
            unitSize: sql`excluded.unit_size`,
            updatedAt: new Date(),
          },
        });
      console.log(
        `  ${p.kind}/${p.provider}/${p.category}: ${p.unitPrice} credits per ${p.unitSize}`,
      );
    }
    console.log(`✅ Seeded ${USAGE_PRICING.length} usage pricing entries`);

    // --- vm0_api_keys (transactional replace) ---
    console.log("Seeding vm0_api_keys...");
    const apiKeys = buildVm0ApiKeys();
    await db.transaction(async (tx) => {
      await tx.delete(vm0ApiKeys).where(eq(vm0ApiKeys.label, "dev-seed"));
      if (apiKeys.length > 0) {
        await tx.insert(vm0ApiKeys).values(apiKeys);
      }
    });
    for (const k of apiKeys) {
      console.log(`  ${k.vendor}/${k.model}`);
    }
    console.log(`✅ Seeded ${apiKeys.length} vm0 API key entries`);

    // --- skills (seed skills + common connectors, batch insert) ---
    console.log("Seeding skills...");
    const eligibleConnectorTypes = getEligibleConnectorTypes();
    const skillValues = buildSeedSkillValues([
      ...new Set([...SEED_SKILLS, ...eligibleConnectorTypes]),
    ]);
    const inserted = await db
      .insert(skills)
      .values(skillValues)
      .onConflictDoNothing()
      .returning({ id: skills.id });
    const seededCount = inserted.length;
    console.log(
      `✅ Seeded skills: ${seededCount} new, ${skillValues.length - seededCount} already existed`,
    );
  } finally {
    await client.end();
  }
}

await devSeed();
