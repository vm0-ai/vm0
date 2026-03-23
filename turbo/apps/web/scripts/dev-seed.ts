#!/usr/bin/env tsx

import postgres from "postgres";

/**
 * Dev seed: populate credit_pricing and vm0_api_keys tables.
 *
 * Pricing convention: 1 USD = 1000 credits.
 * Prices are per 1M tokens, stored as integer credits per 1M tokens.
 *
 * API keys are read from environment variables:
 *   DEV_MODEL_ANTHROPIC_KEY, DEV_MODEL_MOONSHOT_KEY,
 *   DEV_MODEL_ZAI_KEY, DEV_MODEL_MINIMAX_KEY
 */

interface ModelPricing {
  model: string;
  modelProvider: string;
  inputTokenPrice: number;
  outputTokenPrice: number;
  cacheReadTokenPrice: number;
  cacheCreationTokenPrice: number;
}

interface Vm0ApiKey {
  vendor: string;
  model: string;
  apiKey: string;
  label: string;
}

/** 1 USD = 1000 credits */
const USD_TO_CREDITS = 1000;

function usd(amount: number): number {
  return Math.round(amount * USD_TO_CREDITS);
}

const MODEL_PRICING: ModelPricing[] = [
  // Anthropic
  {
    model: "claude-sonnet-4.6",
    modelProvider: "vm0",
    inputTokenPrice: usd(3),
    outputTokenPrice: usd(15),
    cacheReadTokenPrice: usd(0.3),
    cacheCreationTokenPrice: usd(3.75),
  },
  {
    model: "claude-opus-4.6",
    modelProvider: "vm0",
    inputTokenPrice: usd(15),
    outputTokenPrice: usd(75),
    cacheReadTokenPrice: usd(1.5),
    cacheCreationTokenPrice: usd(18.75),
  },
];

/**
 * Build vm0_api_keys entries from environment variables.
 * Each vendor key is shared across all models of that vendor.
 */
function buildVm0ApiKeys(): Vm0ApiKey[] {
  const vendorEnvMap: Record<string, { envVar: string; models: string[] }> = {
    anthropic: {
      envVar: "DEV_MODEL_ANTHROPIC_KEY",
      models: ["claude-sonnet-4.6", "claude-opus-4.6"],
    },
  };

  const keys: Vm0ApiKey[] = [];
  for (const [vendor, config] of Object.entries(vendorEnvMap)) {
    const apiKey = process.env[config.envVar];
    if (!apiKey) {
      console.log(`  ⚠ ${config.envVar} not set, skipping ${vendor}`);
      continue;
    }
    for (const model of config.models) {
      keys.push({ vendor, model, apiKey, label: "dev-seed" });
    }
  }
  return keys;
}

async function devSeed() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL environment variable is not set");
  }

  const sql = postgres(process.env.DATABASE_URL, { max: 1 });

  try {
    // --- credit_pricing ---
    console.log("Seeding credit_pricing...");
    for (const p of MODEL_PRICING) {
      await sql`
        INSERT INTO credit_pricing (
          model, model_provider,
          input_token_price, output_token_price,
          cache_read_token_price, cache_creation_token_price,
          updated_at
        ) VALUES (
          ${p.model}, ${p.modelProvider},
          ${p.inputTokenPrice}, ${p.outputTokenPrice},
          ${p.cacheReadTokenPrice}, ${p.cacheCreationTokenPrice},
          NOW()
        )
        ON CONFLICT (model, model_provider)
        DO UPDATE SET
          input_token_price = EXCLUDED.input_token_price,
          output_token_price = EXCLUDED.output_token_price,
          cache_read_token_price = EXCLUDED.cache_read_token_price,
          cache_creation_token_price = EXCLUDED.cache_creation_token_price,
          updated_at = NOW()
      `;
      console.log(
        `  ${p.modelProvider}/${p.model}: input=${p.inputTokenPrice} output=${p.outputTokenPrice}`,
      );
    }
    console.log(`✅ Seeded ${MODEL_PRICING.length} credit pricing entries`);

    // --- vm0_api_keys ---
    console.log("Seeding vm0_api_keys...");
    const apiKeys = buildVm0ApiKeys();
    // Replace all dev-seed keys with fresh set
    await sql`DELETE FROM vm0_api_keys WHERE label = 'dev-seed'`;
    for (const k of apiKeys) {
      await sql`
        INSERT INTO vm0_api_keys (vendor, model, api_key, label, updated_at)
        VALUES (${k.vendor}, ${k.model}, ${k.apiKey}, ${k.label}, NOW())
      `;
      console.log(`  ${k.vendor}/${k.model}`);
    }
    console.log(`✅ Seeded ${apiKeys.length} vm0 API key entries`);
  } finally {
    await sql.end();
  }
}

await devSeed();
