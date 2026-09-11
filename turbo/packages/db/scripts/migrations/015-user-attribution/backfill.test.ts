import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import postgres from "postgres";
import { applyPendingMigrations } from "../../migration-runner";
import { runBackfill } from "./backfill";

const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
  vi.unstubAllEnvs();
});
afterAll(() => {
  server.close();
});

async function fixture() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl)
    throw new Error(
      "DATABASE_URL is required for real backfill integration tests",
    );
  const base = new URL(databaseUrl);
  base.pathname = "/postgres";
  const admin = postgres(base.toString(), { max: 1 });
  const name = `attr_${randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  base.pathname = `/${name}`;
  const db = postgres(base.toString(), { max: 1, onnotice: () => {} });
  const directory = await mkdtemp(join(tmpdir(), "attribution-backfill-"));
  const controller = new AbortController();
  onTestFinished(async () => {
    controller.abort();
    await db.end();
    await admin.unsafe(`DROP DATABASE "${name}"`);
    await admin.end();
    await rm(directory, { recursive: true });
  });
  await applyPendingMigrations(db);
  vi.stubEnv("DATABASE_URL", base.toString());
  vi.stubEnv("CLERK_SECRET_KEY", "test-clerk-secret");
  const report = join(directory, "report.json");
  const runId = randomUUID();
  return {
    report,
    run: async (...args: string[]) => {
      return runBackfill(
        [
          "--environment",
          "development",
          "--run-id",
          runId,
          "--report",
          report,
          "--delay-ms",
          "0",
          "--page-size",
          "2",
          ...args,
        ],
        controller.signal,
      );
    },
  };
}

function person(index: number, metadata: Record<string, unknown> = {}) {
  return {
    id: `user_backfill_${index}`,
    created_at: 1000 + index,
    updated_at: 2000 + index,
    private_metadata: metadata,
  };
}
function clerk(users: readonly unknown[]) {
  server.use(
    http.get("https://api.clerk.com/v1/instance", () => {
      return HttpResponse.json({ environment_type: "development" });
    }),
    http.get("https://api.clerk.com/v1/users/count", () => {
      return HttpResponse.json({ total_count: users.length });
    }),
    http.get("https://api.clerk.com/v1/users", ({ request }) => {
      const url = new URL(request.url);
      expect(url.searchParams.get("order_by")).toBe("+created_at");
      const offset = Number(url.searchParams.get("offset"));
      const limit = Number(url.searchParams.get("limit"));
      return HttpResponse.json(users.slice(offset, offset + limit));
    }),
  );
}

describe("historical attribution migration command", () => {
  it("dry-runs without writes, resumes bounded batches, verifies all users and is idempotent", async () => {
    const f = await fixture();
    clerk([
      person(0),
      person(1, {
        signup_attribution: {
          source_type: "organic_search",
          recorded_at: "2026-09-01T00:00:00Z",
        },
      }),
      person(2, {
        signup_attribution: {
          gclid: "old-click",
          vm0_campaign_id: "24220469665",
          recorded_at: "2026-09-01T00:00:00Z",
        },
        marketing_privacy_receipt: "existing-receipt",
        google_data_manager_acquisition_conversions: {
          original: {
            status: "uploaded",
            event_time: "2026-09-02T00:00:00Z",
            conversion_action_id: "original-action",
          },
          pending: { status: "pending_account" },
        },
      }),
      person(3, { signup_attribution: "malformed-but-present" }),
    ]);
    expect(await f.run()).toMatchObject({
      mode: "dry-run",
      changed: 0,
      completeInventory: true,
      verification: { missing: 4 },
    });
    await expect(f.run("--verify")).rejects.toThrow("Verification incomplete");
    expect(await f.run("--migrate", "--max-users", "2")).toMatchObject({
      processed: 2,
      nextOffset: 2,
      changed: 2,
      completeInventory: false,
    });
    expect(await f.run("--migrate", "--start-offset", "2")).toMatchObject({
      processed: 2,
      changed: 2,
      completeInventory: false,
    });
    expect(await f.run("--verify")).toMatchObject({
      processed: 4,
      verified: true,
      completeInventory: true,
      verification: { matched: 4 },
    });
    expect(await f.run("--migrate")).toMatchObject({
      changed: 0,
      states: { absent: 1, captured: 2, invalid: 1 },
    });
  });

  it("rejects a mismatched environment before scanning or writing user data", async () => {
    const f = await fixture();
    server.use(
      http.get("https://api.clerk.com/v1/instance", () => {
        return HttpResponse.json({ environment_type: "production" });
      }),
    );
    await expect(f.run("--migrate")).rejects.toThrow("does not match");
    expect(JSON.parse(await readFile(f.report, "utf8"))).toMatchObject({
      processed: 0,
      changed: 0,
      errors: 1,
      verified: false,
    });
  });

  it("honors retryable Clerk throttling without repeating committed work", async () => {
    const f = await fixture();
    clerk([person(0)]);
    server.use(
      http.get(
        "https://api.clerk.com/v1/users",
        () => {
          return new HttpResponse(null, {
            status: 429,
            headers: { "Retry-After": "0" },
          });
        },
        { once: true },
      ),
    );
    expect(await f.run("--migrate")).toMatchObject({
      processed: 1,
      changed: 1,
    });
    expect(await f.run("--verify")).toMatchObject({ verified: true });
  });

  it("does not certify unstable pagination or turn a failed snapshot into absent", async () => {
    const f = await fixture();
    clerk([person(0), person(0)]);
    await expect(f.run("--migrate")).rejects.toThrow(
      "Unstable Clerk pagination",
    );
    clerk([person(0), { id: "user_invalid", created_at: 1001 }]);
    await expect(f.run("--migrate")).rejects.toThrow("missing its version");
    expect(JSON.parse(await readFile(f.report, "utf8"))).toMatchObject({
      processed: 1,
      errors: 1,
      verified: false,
    });
  });

  it("blocks cutover when an existing first touch differs from the import", async () => {
    const f = await fixture();
    clerk([
      person(0, {
        signup_attribution: {
          gclid: "original",
          vm0_campaign_id: "24220469665",
        },
      }),
    ]);
    await f.run("--migrate");
    clerk([
      {
        ...person(0, {
          signup_attribution: {
            gclid: "replacement",
            vm0_campaign_id: "24154967178",
          },
        }),
        updated_at: 3000,
      },
    ]);
    expect(await f.run("--migrate")).toMatchObject({ states: { conflict: 1 } });
    await expect(f.run("--verify")).rejects.toThrow("Verification incomplete");
  });
});
