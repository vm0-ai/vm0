#!/usr/bin/env tsx

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { telegramInstallations } from "../src/db/schema/telegram-installation";
import { decryptSecretValue } from "../src/lib/shared/crypto/secrets-encryption";
import { setWebhook } from "../src/lib/zero/telegram/client";
import { buildTelegramWebhookUrl } from "../src/lib/zero/telegram/webhook-url";

/**
 * One-shot operational script: re-point every existing Telegram bot's webhook
 * URL at the new path segment (`[telegramBotId]`) after the schema migration
 * that dropped the uuid `id` primary key.
 *
 * Telegram stores the webhook URL server-side, so without running this after
 * deploy, existing bots will keep POSTing to `/api/telegram/webhook/<uuid>`
 * which no longer resolves.
 *
 * Usage:
 *   pnpm -F @vm0/web exec tsx scripts/telegram-rewebhook.ts [--dry-run]
 *
 * Requires DATABASE_URL, SECRETS_ENCRYPTION_KEY, VM0_API_URL in env.
 */

interface Args {
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  return { dryRun: argv.includes("--dry-run") };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const databaseUrl = process.env.DATABASE_URL;
  const secretsKey = process.env.SECRETS_ENCRYPTION_KEY;
  const apiUrl = process.env.VM0_API_URL;

  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (!secretsKey) throw new Error("SECRETS_ENCRYPTION_KEY is required");
  if (!apiUrl) throw new Error("VM0_API_URL is required");

  const sql = postgres(databaseUrl, { max: 1 });
  const db = drizzle(sql);

  const rows = await db
    .select({
      telegramBotId: telegramInstallations.telegramBotId,
      encryptedBotToken: telegramInstallations.encryptedBotToken,
      webhookSecret: telegramInstallations.webhookSecret,
    })
    .from(telegramInstallations);

  console.log(`Found ${rows.length} installation(s).`);
  if (args.dryRun) {
    for (const row of rows) {
      const url = buildTelegramWebhookUrl(apiUrl, row.telegramBotId);
      console.log(`[dry-run] would setWebhook ${row.telegramBotId} → ${url}`);
    }
    await sql.end();
    return;
  }

  let succeeded = 0;
  let failed = 0;
  for (const row of rows) {
    const url = buildTelegramWebhookUrl(apiUrl, row.telegramBotId);
    try {
      const botToken = decryptSecretValue(row.encryptedBotToken, secretsKey);
      await setWebhook(botToken, url, row.webhookSecret);
      console.log(`ok   ${row.telegramBotId} → ${url}`);
      succeeded++;
    } catch (err) {
      console.error(`fail ${row.telegramBotId} → ${url}:`, err);
      failed++;
    }
  }

  console.log(`Done. succeeded=${succeeded} failed=${failed}`);
  await sql.end();

  if (failed > 0) process.exitCode = 1;
}

void main();
