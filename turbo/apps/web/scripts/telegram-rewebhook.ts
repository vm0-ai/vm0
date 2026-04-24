#!/usr/bin/env tsx

import { telegramInstallations } from "../src/db/schema/telegram-installation";
import { initServices } from "../src/lib/init-services";
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

  initServices();
  const { db, env, pool } = globalThis.services;
  const apiUrl = env.VM0_API_URL;
  const secretsKey = env.SECRETS_ENCRYPTION_KEY;

  if (!apiUrl) throw new Error("VM0_API_URL is required");

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
    await pool.end();
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
      console.error("fail %s → %s:", row.telegramBotId, url, err);
      failed++;
    }
  }

  console.log(`Done. succeeded=${succeeded} failed=${failed}`);
  await pool.end();

  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
