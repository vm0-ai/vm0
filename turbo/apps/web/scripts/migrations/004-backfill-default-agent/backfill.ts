#!/usr/bin/env tsx

/**
 * Backfill Clerk org publicMetadata with default agent compose IDs.
 *
 * Part of the Scope → Clerk migration: writes scopes.defaultAgentComposeId
 * to the corresponding Clerk org's publicMetadata.default_agent_compose_id.
 *
 * Usage:
 *   tsx scripts/migrations/004-backfill-default-agent/backfill.ts [--migrate]
 *
 * Environment:
 *   DATABASE_URL        — Required
 *   CLERK_SECRET_KEY    — Required (for --migrate)
 */

import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import { isNotNull, asc } from "drizzle-orm";
import postgres from "postgres";

import { createClerkClient } from "@clerk/backend";
import { scopes } from "@vm0/db/schema/scope";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ClerkOrganizationsApi {
  updateOrganizationMetadata: (
    orgId: string,
    params: { publicMetadata: Record<string, unknown> },
  ) => Promise<unknown>;
}

interface ClerkClient {
  organizations: ClerkOrganizationsApi;
}

interface Stats {
  total: number;
  success: number;
  failed: number;
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    migrate: { type: "boolean", default: false },
  },
  strict: true,
});

const DRY_RUN = !args.migrate;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const THROTTLE_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getStatus(err: unknown): number | undefined {
  if (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    typeof (err as Record<string, unknown>).status === "number"
  ) {
    return (err as Record<string, unknown>).status as number;
  }
  return undefined;
}

function isTransientError(err: unknown): boolean {
  const status = getStatus(err);
  return status === 429 || (status !== undefined && status >= 500);
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (isTransientError(err) && attempt < MAX_ATTEMPTS) {
        const backoff = Math.pow(2, attempt) * 1000;
        console.warn(
          `  Transient error (status ${getStatus(err)}), retrying in ${backoff}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS})`,
        );
        await sleep(backoff);
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Failed after ${MAX_ATTEMPTS} attempts`);
}

// ---------------------------------------------------------------------------
// Backfill: Default agent compose IDs
// ---------------------------------------------------------------------------

async function backfillDefaultAgents(
  db: ReturnType<typeof drizzle>,
  client: ClerkClient | null,
): Promise<Stats> {
  console.log("\n--- Backfilling default agent compose IDs ---\n");

  const scopesWithDefault = await db
    .select({
      id: scopes.id,
      slug: scopes.slug,
      orgId: scopes.orgId,
      defaultAgentComposeId: scopes.defaultAgentComposeId,
    })
    .from(scopes)
    .where(isNotNull(scopes.defaultAgentComposeId))
    .orderBy(asc(scopes.createdAt));

  const total = scopesWithDefault.length;
  console.log(`Found ${total} scope(s) with a default agent\n`);

  const stats: Stats = { total, success: 0, failed: 0 };

  for (let i = 0; i < scopesWithDefault.length; i++) {
    const scope = scopesWithDefault[i]!;
    const idx = `[${i + 1}/${total}]`;

    if (DRY_RUN) {
      console.log(
        `${idx} (dry-run) scope "${scope.slug}" — would write default_agent_compose_id="${scope.defaultAgentComposeId}" to Clerk org ${scope.orgId}`,
      );
      stats.success++;
      continue;
    }

    try {
      await withRetry(() =>
        client!.organizations.updateOrganizationMetadata(scope.orgId, {
          publicMetadata: {
            default_agent_compose_id: scope.defaultAgentComposeId,
          },
        }),
      );
      await sleep(THROTTLE_MS);
      console.log(
        `${idx} ✓ scope "${scope.slug}" → default_agent_compose_id="${scope.defaultAgentComposeId}"`,
      );
      stats.success++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`${idx} ✗ scope "${scope.slug}" — ${message}`);
      stats.failed++;
    }
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  console.log("=== Backfill Default Agent to Clerk Metadata ===");
  console.log(
    `Mode: ${DRY_RUN ? "dry-run (pass --migrate to execute)" : "MIGRATE"}`,
  );
  console.log();

  let client: ClerkClient | null = null;

  if (!DRY_RUN) {
    const clerkSecretKey = process.env.CLERK_SECRET_KEY;
    if (!clerkSecretKey) {
      throw new Error("CLERK_SECRET_KEY is required for --migrate");
    }
    client = createClerkClient({ secretKey: clerkSecretKey });
  }

  const pg = postgres(databaseUrl, { max: 1 });
  const db = drizzle(pg);

  try {
    const stats = await backfillDefaultAgents(db, client);

    console.log("\n=== Summary ===");
    console.log(
      `Default agents:   ${stats.success} ok, ${stats.failed} failed (${stats.total} total)`,
    );

    if (DRY_RUN) {
      console.log("\n⚠ Dry run — no changes were made.");
    }

    if (stats.failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await pg.end();
  }
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
