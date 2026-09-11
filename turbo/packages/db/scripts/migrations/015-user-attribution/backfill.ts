#!/usr/bin/env tsx
import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { asc, eq, gt } from "drizzle-orm";
import {
  clerkAttributionObservation,
  importClerkAttribution,
  verifyClerkAttributionImport,
} from "../../../src/operations/user-attribution-import";
import { users } from "../../../src/schema/user";
import { userAttributionImports } from "../../../src/schema/user-attribution";
import { BackfillInputError, clerkReader } from "./clerk-reader";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function numberOption(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw new BackfillInputError("Invalid numeric backfill option");
  return parsed;
}
function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new BackfillInputError(`${name} is required`);
  return value;
}
function userCount(value: unknown): number {
  if (
    !isRecord(value) ||
    typeof value.total_count !== "number" ||
    !Number.isSafeInteger(value.total_count) ||
    value.total_count < 0
  )
    throw new BackfillInputError("Invalid Clerk user count response");
  return value.total_count;
}

function backfillOptions(args: readonly string[]) {
  const { values } = parseArgs({
    args: [...args],
    options: {
      migrate: { type: "boolean", default: false },
      verify: { type: "boolean", default: false },
      environment: { type: "string" },
      "run-id": { type: "string" },
      report: { type: "string" },
      "page-size": { type: "string" },
      "delay-ms": { type: "string" },
      "max-users": { type: "string" },
      "start-offset": { type: "string" },
    },
    strict: true,
  });
  if (values.migrate && values.verify)
    throw new BackfillInputError("Choose --migrate or --verify");
  if (!values.report || !values["run-id"])
    throw new BackfillInputError("--report and --run-id are required");
  if (
    values.environment !== "production" &&
    values.environment !== "development"
  )
    throw new BackfillInputError(
      "--environment must be production or development",
    );
  const pageSize = numberOption(values["page-size"], 100, 1, 500);
  const delayMs = numberOption(values["delay-ms"], 1000, 0, 60_000);
  const maxUsers = numberOption(values["max-users"], 1000, 1, 1_000_000);
  const startOffset = numberOption(values["start-offset"], 0, 0, 10_000_000);
  return {
    values: { ...values, report: values.report, "run-id": values["run-id"] },
    pageSize,
    delayMs,
    maxUsers,
    startOffset,
  };
}

export async function runBackfill(
  args: readonly string[],
  signal: AbortSignal,
) {
  const { values, pageSize, delayMs, maxUsers, startOffset } =
    backfillOptions(args);
  const mode = values.migrate ? "apply" : values.verify ? "verify" : "dry-run";
  const read = clerkReader(requiredEnv("CLERK_SECRET_KEY"), delayMs, signal);
  const sql = postgres(requiredEnv("DATABASE_URL"), { max: 1 });
  const db = drizzle(sql);
  const report = {
    runId: values["run-id"],
    mode,
    environment: values.environment,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    startOffset,
    nextOffset: startOffset,
    beforeCount: 0,
    afterCount: 0,
    processed: 0,
    changed: 0,
    errors: 0,
    states: {} as Record<string, number>,
    verification: {} as Record<string, number>,
    completeInventory: false,
    verified: false,
    databaseOnlyUsers: 0,
    databaseOnlyImports: 0,
    accountedDeletedUsers: 0,
    inventoryFingerprint: "",
    phase: "environment",
    failure: null as string | null,
  };
  const seen = new Map<string, string>();
  try {
    // Verify the managed provider's environment, not a credential-string prefix.
    const instance = await read("instance");
    if (!isRecord(instance) || instance.environment_type !== values.environment)
      throw new BackfillInputError(
        "Clerk environment does not match --environment",
      );
    // Refuse to scan if the additive schema is not deployed.
    report.phase = "schema";
    await db
      .select({ userId: userAttributionImports.userId })
      .from(userAttributionImports)
      .limit(1);
    report.phase = "count";
    report.beforeCount = userCount(await read("users/count"));
    async function scanUsers() {
      let reachedEnd = false;
      let previousCreatedAt = -1;
      while (report.processed < maxUsers) {
        const limit = Math.min(pageSize, maxUsers - report.processed);
        const query = new URLSearchParams({
          limit: String(limit),
          offset: String(report.nextOffset),
          order_by: "+created_at",
        });
        report.phase = "page";
        const page = await read(`users?${query.toString()}`);
        if (!Array.isArray(page))
          throw new BackfillInputError("Invalid Clerk user list response");
        if (page.length === 0) {
          reachedEnd = true;
          break;
        }
        for (const raw of page) {
          report.phase = "user";
          const observation = clerkAttributionObservation(raw);
          if (
            !isRecord(raw) ||
            typeof raw.created_at !== "number" ||
            !Number.isSafeInteger(raw.created_at) ||
            raw.created_at < previousCreatedAt ||
            seen.has(observation.userId)
          )
            throw new BackfillInputError(
              "Unstable Clerk pagination; restart a full inventory pass",
            );
          previousCreatedAt = raw.created_at;
          seen.set(observation.userId, observation.fingerprint);
          let state: string = observation.state;
          if (values.migrate) {
            const result = await importClerkAttribution(
              db,
              observation,
              "backfill",
              signal,
              values["run-id"],
            );
            state = result.state;
            if (result.changed) report.changed++;
          }
          report.states[state] = (report.states[state] ?? 0) + 1;
          const verification = await verifyClerkAttributionImport(
            db,
            observation,
          );
          report.verification[verification] =
            (report.verification[verification] ?? 0) + 1;
          report.processed++;
          report.nextOffset++;
        }
        if (page.length < limit) {
          reachedEnd = true;
          break;
        }
      }
      return reachedEnd;
    }
    let reachedEnd = await scanUsers();
    report.phase = "inventory";
    report.inventoryFingerprint = createHash("sha256")
      .update(
        JSON.stringify(
          [...seen].sort(([a], [b]) => {
            return a < b ? -1 : a > b ? 1 : 0;
          }),
        ),
      )
      .digest("hex");
    report.afterCount = userCount(await read("users/count"));
    reachedEnd ||= report.nextOffset === report.afterCount;
    report.completeInventory =
      startOffset === 0 &&
      reachedEnd &&
      report.beforeCount === report.afterCount &&
      seen.size === report.afterCount;
    async function reconcileDatabaseInventory() {
      let lastUser: string | undefined;
      for (;;) {
        const page = await db
          .select({ id: users.id, state: userAttributionImports.state })
          .from(users)
          .leftJoin(
            userAttributionImports,
            eq(users.id, userAttributionImports.userId),
          )
          .where(lastUser === undefined ? undefined : gt(users.id, lastUser))
          .orderBy(asc(users.id))
          .limit(500);
        for (const row of page) {
          if (!seen.has(row.id)) {
            if (row.state === "deleted") report.accountedDeletedUsers++;
            else report.databaseOnlyUsers++;
          }
        }
        lastUser = page.at(-1)?.id;
        if (page.length < 500) break;
      }
      let lastImport: string | undefined;
      for (;;) {
        const page = await db
          .select({
            id: userAttributionImports.userId,
            state: userAttributionImports.state,
          })
          .from(userAttributionImports)
          .where(
            lastImport === undefined
              ? undefined
              : gt(userAttributionImports.userId, lastImport),
          )
          .orderBy(asc(userAttributionImports.userId))
          .limit(500);
        for (const row of page)
          if (!seen.has(row.id) && row.state !== "deleted")
            report.databaseOnlyImports++;
        lastImport = page.at(-1)?.id;
        if (page.length < 500) break;
      }
    }
    if (report.completeInventory) await reconcileDatabaseInventory();
    report.phase = "verification";
    report.verified =
      values.verify &&
      report.completeInventory &&
      (report.verification.matched ?? 0) === report.processed &&
      report.databaseOnlyImports === 0 &&
      report.databaseOnlyUsers === 0;
    if (values.verify && !report.verified)
      throw new BackfillInputError(
        "Verification incomplete; reconcile counts, conflicts, concurrent changes, and unavailable identities before cutover",
      );
  } catch (error) {
    report.errors++;
    // Raw SQL/provider exceptions can contain row data; publish only the class.
    report.failure =
      error instanceof BackfillInputError
        ? error.message
        : error instanceof Error
          ? error.name
          : "UnknownError";
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    await sql.end();
    await writeFile(values.report, JSON.stringify(report, null, 2) + "\n", {
      mode: 0o600,
    });
  }
  return report;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const controller = new AbortController();
  const cancel = () => {
    controller.abort();
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const report = await runBackfill(process.argv.slice(2), controller.signal);
    console.log(JSON.stringify(report));
  } catch (error) {
    console.error(
      `Attribution backfill stopped (${error instanceof BackfillInputError ? error.message : error instanceof Error ? error.name : "unknown"}); inspect the aggregate report and resume after resolving the failure.`,
    );
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    controller.abort();
  }
}
