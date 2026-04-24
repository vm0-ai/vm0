#!/usr/bin/env tsx

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, sql } from "drizzle-orm";
import { getEligibleConnectorTypes } from "@vm0/core/contracts/connector-utils";
import { VM0_MODEL_TO_PROVIDER } from "@vm0/core/contracts/model-providers";
import { schema } from "../src/db/db";
import { creditPricing } from "../src/db/schema/credit-pricing";
import { usagePricing } from "../src/db/schema/usage-pricing";
import { vm0ApiKeys } from "../src/db/schema/vm0-api-key";
import { skills } from "../src/db/schema/skill";
import { SEED_SKILLS, buildSeedSkillValues } from "../src/lib/zero/seed-skills";

/**
 * Dev seed: populate credit_pricing, vm0_api_keys, and skills tables.
 *
 * Pricing convention: 1 USD = 1000 credits.
 * Prices are per 1M tokens, stored as integer credits per 1M tokens.
 *
 * API keys are read from environment variables per vendor:
 *   DEV_MODEL_{VENDOR_UPPER}_KEY (e.g., DEV_MODEL_ANTHROPIC_KEY)
 */

/** 1 USD = 1000 credits */
const USD_TO_CREDITS = 1000;

function usd(amount: number): number {
  return Math.round(amount * USD_TO_CREDITS);
}

const MODEL_PRICING: (typeof creditPricing.$inferInsert)[] = [
  {
    model: "claude-sonnet-4-6",
    modelProvider: "vm0",
    inputTokenPrice: usd(3),
    outputTokenPrice: usd(15),
    cacheReadTokenPrice: usd(0.3),
    cacheCreationTokenPrice: usd(3.75),
  },
  {
    model: "claude-opus-4-6",
    modelProvider: "vm0",
    inputTokenPrice: usd(15),
    outputTokenPrice: usd(75),
    cacheReadTokenPrice: usd(1.5),
    cacheCreationTokenPrice: usd(18.75),
  },
  {
    model: "claude-opus-4-7",
    modelProvider: "vm0",
    inputTokenPrice: usd(5),
    outputTokenPrice: usd(25),
    cacheReadTokenPrice: usd(0.5),
    cacheCreationTokenPrice: usd(6.25),
  },
  {
    model: "claude-haiku-4-5",
    modelProvider: "vm0",
    inputTokenPrice: usd(1),
    outputTokenPrice: usd(5),
    cacheReadTokenPrice: usd(0.1),
    cacheCreationTokenPrice: usd(1.25),
  },
  {
    model: "kimi-k2.6",
    modelProvider: "vm0",
    inputTokenPrice: usd(0.6),
    outputTokenPrice: usd(3),
    cacheReadTokenPrice: usd(0.1),
    cacheCreationTokenPrice: usd(0.6),
  },
  {
    model: "kimi-k2.5",
    modelProvider: "vm0",
    inputTokenPrice: usd(0.6),
    outputTokenPrice: usd(3),
    cacheReadTokenPrice: usd(0.1),
    cacheCreationTokenPrice: usd(0.6),
  },
  {
    model: "glm-5.1",
    modelProvider: "vm0",
    inputTokenPrice: usd(1.4),
    outputTokenPrice: usd(4.4),
    cacheReadTokenPrice: usd(0.26),
    cacheCreationTokenPrice: usd(1.4),
  },
  {
    model: "MiniMax-M2.7",
    modelProvider: "vm0",
    inputTokenPrice: usd(0.3),
    outputTokenPrice: usd(1.2),
    cacheReadTokenPrice: usd(0.06),
    cacheCreationTokenPrice: usd(0.375),
  },
  {
    model: "deepseek-chat",
    modelProvider: "vm0",
    inputTokenPrice: usd(0.28),
    outputTokenPrice: usd(0.42),
    cacheReadTokenPrice: usd(0.028),
    cacheCreationTokenPrice: 0,
  },
  {
    model: "deepseek-reasoner",
    modelProvider: "vm0",
    inputTokenPrice: usd(0.28),
    outputTokenPrice: usd(0.42),
    cacheReadTokenPrice: usd(0.028),
    cacheCreationTokenPrice: 0,
  },
  {
    // Output is image tokens (~1290 tokens/image at $30/1M ≈ $0.039/image).
    // 20% margin applied on top of Google's public pricing.
    model: "gemini-2.5-flash-image",
    modelProvider: "vm0",
    inputTokenPrice: usd(0.3 * 1.2),
    outputTokenPrice: usd(30 * 1.2),
    cacheReadTokenPrice: 0,
    cacheCreationTokenPrice: 0,
  },
];

// https://docs.x.com/x-api/getting-started/pricing
const X_CONNECTOR_PRICING: Array<{
  category: string;
  unitPrice: number;
}> = [
  // reads — $/resource
  { category: "posts.read", unitPrice: usd(0.005) },
  { category: "user.read", unitPrice: usd(0.01) },
  { category: "dm_event.read", unitPrice: usd(0.01) },
  { category: "following_followers.read", unitPrice: usd(0.01) },
  { category: "list.read", unitPrice: usd(0.005) },
  { category: "space.read", unitPrice: usd(0.005) },
  { category: "community.read", unitPrice: usd(0.005) },
  { category: "note.read", unitPrice: usd(0.005) },
  { category: "media.read", unitPrice: usd(0.005) },
  { category: "analytics.read", unitPrice: usd(0.005) },
  { category: "trend.read", unitPrice: usd(0.01) },
  // writes — $/request
  { category: "content.create", unitPrice: usd(0.015) },
  { category: "content.create_with_url", unitPrice: usd(0.2) },
  { category: "dm_interaction.create", unitPrice: usd(0.015) },
  { category: "user_interaction.create", unitPrice: usd(0.015) },
  { category: "interaction.delete", unitPrice: usd(0.01) },
  { category: "content.manage", unitPrice: usd(0.005) },
  { category: "list.create", unitPrice: usd(0.01) },
  { category: "list.manage", unitPrice: usd(0.005) },
  { category: "bookmark", unitPrice: usd(0.005) },
  { category: "media_metadata", unitPrice: usd(0.005) },
  { category: "privacy.update", unitPrice: usd(0.01) },
  { category: "mute.delete", unitPrice: usd(0.005) },
  { category: "counts.recent", unitPrice: usd(0.005) },
  { category: "counts.all", unitPrice: usd(0.01) },
  // fallback — priced at the minimum bucket rate across the table
  // above, so an unknown includes key can never be billed at more
  // than X charges for the cheapest known bucket.
  { category: "__fallback__", unitPrice: usd(0.005) },
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
    // --- credit_pricing (batch upsert) ---
    console.log("Seeding credit_pricing...");
    for (const p of MODEL_PRICING) {
      await db
        .insert(creditPricing)
        .values(p)
        .onConflictDoUpdate({
          target: [creditPricing.model, creditPricing.modelProvider],
          set: {
            inputTokenPrice: sql`excluded.input_token_price`,
            outputTokenPrice: sql`excluded.output_token_price`,
            cacheReadTokenPrice: sql`excluded.cache_read_token_price`,
            cacheCreationTokenPrice: sql`excluded.cache_creation_token_price`,
            updatedAt: new Date(),
          },
        });
      console.log(
        `  ${p.modelProvider}/${p.model}: input=${p.inputTokenPrice} output=${p.outputTokenPrice}`,
      );
    }
    console.log(`✅ Seeded ${MODEL_PRICING.length} credit pricing entries`);

    // --- usage_pricing (connector / x) ---
    console.log("Seeding usage_pricing (connector/x)...");
    for (const p of X_CONNECTOR_PRICING) {
      await db
        .insert(usagePricing)
        .values({
          kind: "connector",
          provider: "x",
          category: p.category,
          unitPrice: p.unitPrice,
          unitSize: 1,
        })
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
      console.log(`  connector/x/${p.category}: ${p.unitPrice} credits/call`);
    }
    console.log(
      `✅ Seeded ${X_CONNECTOR_PRICING.length} X connector pricing entries`,
    );

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
