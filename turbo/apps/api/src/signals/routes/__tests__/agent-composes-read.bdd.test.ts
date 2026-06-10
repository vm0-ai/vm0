import { randomUUID } from "node:crypto";

import {
  composesByIdContract,
  composesInstructionsContract,
  composesListContract,
  composesMainContract,
  composesVersionsContract,
} from "@vm0/api-contracts/contracts/composes";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { storages } from "@vm0/db/schema/storage";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { command, createStore } from "ccstate";
import { eq } from "drizzle-orm";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  mockInstructionsContent,
  seedInstructionsStorage$,
} from "./helpers/zero-skills";

// BDD migration of the legacy `agent-composes-read.test.ts`. The
// 16 legacy `it()`s collapse into 5 BDD `it()`s: (1) GET-by-name
// chain (401 unauth → 400 missing name → 200 owner → 200 member +
// 404 other org → 200 sandbox), (2) GET-by-id chain (400 malformed
// → 200 owner/member/sandbox → 404 inaccessible + 404 missing), (3)
// GET-list chain (401 unauth + 400 no-org → 200 empty → 200 sorted
// with metadata + isolation → 200 sandbox), (4) GET-versions chain
// (resolve latest + full hash + prefix → 200 sandbox → 400 no-head
// + 404 missing version + 404 missing compose → 400 invalid +
// ambiguous prefix), (5) GET-instructions chain (400 malformed +
// 401 unauth + 404 missing → 200 canonical + 200 explicit filename
// → 200 storage member + 200 storage sandbox → 404 non-member).
// The legacy "list of composes" assertion is the same on the
// public list GET; sort order is verified through the response.
// The `seedAgentComposeReadFixture$` is an inlined direct-DB
// writer (Open Helper Gap) — the legacy seed wrote head version
// rows + zero-agent rows that the public API does not expose as
// "create with metadata" primitives. The legacy "is in active
// org" assertions for member lookups are surfaced through the
// 200 responses; "not in active org" returns 404 with a name
// scoped to the org, exercised by switching `mocks.clerk.session`
// to a fresh org.

interface SeedComposeRow {
  readonly name?: string;
  readonly versionId?: string | null;
  readonly content?: unknown;
  readonly displayName?: string | null;
  readonly description?: string | null;
  readonly sound?: string | null;
  readonly updatedAt?: Date;
  readonly withZeroAgent?: boolean;
  readonly extraVersionIds?: readonly string[];
}

interface SeedAgentComposeReadValues {
  readonly orgId?: string;
  readonly userId?: string;
  readonly composes?: readonly SeedComposeRow[];
}

interface SeededCompose {
  readonly id: string;
  readonly name: string;
  readonly versionId: string | null;
}

interface AgentComposeReadFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly composes: readonly SeededCompose[];
}

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const VERSION_A = `${"a".repeat(64)}`;
const VERSION_B = `${"b".repeat(64)}`;
const VERSION_C = `${"c".repeat(64)}`;
const VERSION_D = `${"d".repeat(64)}`;
const VERSION_E = `${"e".repeat(64)}`;
const AMBIGUOUS_VERSION_A = `abcdef12${"a".repeat(56)}`;
const AMBIGUOUS_VERSION_B = `abcdef12${"b".repeat(56)}`;

function composeContent(
  name: string,
  instructions?: string,
): Record<string, unknown> {
  return {
    version: "1",
    agents: {
      [name]: instructions
        ? { framework: "claude-code", instructions }
        : { framework: "claude-code" },
    },
  };
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function sandboxToken(args: {
  readonly userId: string;
  readonly orgId: string;
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "sandbox",
    userId: args.userId,
    orgId: args.orgId,
    runId: `run_${randomUUID()}`,
    iat: seconds,
    exp: seconds + 60,
  });
}

const seedAgentComposeReadFixture$ = command(
  async (
    { set },
    values: SeedAgentComposeReadValues,
    signal: AbortSignal,
  ): Promise<AgentComposeReadFixture> => {
    const orgId = values.orgId ?? `org_${randomUUID()}`;
    const userId = values.userId ?? `user_${randomUUID()}`;
    const rows = values.composes ?? [{}];
    const writeDb = set(writeDb$);
    const composes: SeededCompose[] = [];

    for (const row of rows) {
      const composeId = randomUUID();
      const name = row.name ?? `agent-${composeId.slice(0, 8)}`;
      const versionId = row.versionId === undefined ? VERSION_A : row.versionId;
      await writeDb.insert(agentComposes).values({
        id: composeId,
        userId,
        orgId,
        name,
        headVersionId: versionId,
        updatedAt: row.updatedAt,
      });
      signal.throwIfAborted();

      if (versionId) {
        await writeDb.insert(agentComposeVersions).values({
          id: versionId,
          composeId,
          content: row.content ?? composeContent(name),
          createdBy: userId,
        });
        signal.throwIfAborted();
      }

      for (const extraVersionId of row.extraVersionIds ?? []) {
        await writeDb.insert(agentComposeVersions).values({
          id: extraVersionId,
          composeId,
          content: row.content ?? composeContent(name),
          createdBy: userId,
        });
        signal.throwIfAborted();
      }

      if (row.withZeroAgent !== false) {
        await writeDb.insert(zeroAgents).values({
          id: composeId,
          orgId,
          owner: userId,
          name,
          displayName: row.displayName ?? null,
          description: row.description ?? null,
          sound: row.sound ?? null,
        });
        signal.throwIfAborted();
      }

      composes.push({ id: composeId, name, versionId });
    }

    return { orgId, userId, composes };
  },
);

const deleteAgentComposeReadFixture$ = command(
  async (
    { set },
    fixture: AgentComposeReadFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb.delete(storages).where(eq(storages.orgId, fixture.orgId));
    signal.throwIfAborted();
    await writeDb
      .delete(agentComposes)
      .where(eq(agentComposes.orgId, fixture.orgId));
    signal.throwIfAborted();
  },
);

const track = createFixtureTracker<AgentComposeReadFixture>((fixture) => {
  return store.set(deleteAgentComposeReadFixture$, fixture, context.signal);
});

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function mainClient() {
  return setupApp({ context })(composesMainContract);
}

function byIdClient() {
  return setupApp({ context })(composesByIdContract);
}

function listClient() {
  return setupApp({ context })(composesListContract);
}

function versionsClient() {
  return setupApp({ context })(composesVersionsContract);
}

function instructionsClient() {
  return setupApp({ context })(composesInstructionsContract);
}

describe("BDD GET /api/agent/composes — by-name chain", () => {
  it("gwt-wt-wt: 401 unauth → 400 missing name → 200 owner → 200 member + 404 other-org → 200 sandbox", async () => {
    // When + Then: 401 unauth.
    const unauth = await accept(
      mainClient().getByName({ query: { name: "missing" }, headers: {} }),
      [401],
    );
    expect(unauth.body.error).toStrictEqual({
      message: "Not authenticated",
      code: "UNAUTHORIZED",
    });

    // Given: an authenticated session with no seeded compose;
    // a missing-name request goes through the raw app because
    // the ts-rest client always sends the name.
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const app = createApp({ signal: context.signal });
    const noName = await app.request("/api/agent/composes", {
      method: "GET",
      headers: authHeaders(),
    });
    expect(noName.status).toBe(400);
    const noNameBody = (await noName.json()) as {
      readonly error: { readonly code: string; readonly message: string };
    };
    expect(noNameBody.error.code).toBe("BAD_REQUEST");
    expect(noNameBody.error.message).toContain("expected string");

    // Given: a seeded owner compose.
    const ownerFixture = await track(
      store.set(
        seedAgentComposeReadFixture$,
        {
          composes: [
            {
              name: "owner-agent",
              versionId: VERSION_A,
              content: composeContent("owner-agent"),
            },
          ],
        },
        context.signal,
      ),
    );
    mocks.clerk.session(ownerFixture.userId, ownerFixture.orgId);

    // When + Then: 200 + the head version content is returned.
    const owner = await accept(
      mainClient().getByName({
        query: { name: "owner-agent" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(owner.body.id).toBe(ownerFixture.composes[0]?.id);
    expect(owner.body.name).toBe("owner-agent");
    expect(owner.body.headVersionId).toBe(VERSION_A);
    expect(owner.body.content).toStrictEqual(composeContent("owner-agent"));

    // Given: a compose visible to any member of the same org.
    const sharedFixture = await track(
      store.set(
        seedAgentComposeReadFixture$,
        { composes: [{ name: "shared-agent", versionId: VERSION_B }] },
        context.signal,
      ),
    );

    // When + Then: a different user in the same org still gets
    // 200 (member of the owning org).
    mocks.clerk.session(`user_${randomUUID()}`, sharedFixture.orgId);
    const member = await accept(
      mainClient().getByName({
        query: { name: "shared-agent" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(member.body.id).toBe(sharedFixture.composes[0]?.id);

    // When + Then: a session in a different org gets 404.
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const otherOrg = await accept(
      mainClient().getByName({
        query: { name: "shared-agent" },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(otherOrg.body.error.message).toBe(
      "Agent compose not found: shared-agent",
    );

    // Given: a sandbox token for a fresh compose owner.
    const sandboxFixture = await track(
      store.set(
        seedAgentComposeReadFixture$,
        { composes: [{ name: "sandbox-agent", versionId: VERSION_C }] },
        context.signal,
      ),
    );
    const sandboxAuth = {
      authorization: `Bearer ${sandboxToken({
        userId: sandboxFixture.userId,
        orgId: sandboxFixture.orgId,
      })}`,
    };

    // When + Then: sandbox token resolves the compose.
    const sandbox = await accept(
      mainClient().getByName({
        query: { name: "sandbox-agent" },
        headers: sandboxAuth,
      }),
      [200],
    );
    expect(sandbox.body.id).toBe(sandboxFixture.composes[0]?.id);
  });
});

describe("BDD GET /api/agent/composes/:id — by-id chain", () => {
  it("gwt-wt-wt: 400 malformed id → 200 owner + 200 member + 200 sandbox → 404 inaccessible + 404 missing", async () => {
    // Given: an authenticated session; malformed id is sent
    // through the raw app (ts-rest validates client-side).
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const app = createApp({ signal: context.signal });
    const malformed = await app.request(
      "/api/agent/composes/91fc0bd84bba673393d9adfc1a0f4dec",
      { method: "GET", headers: authHeaders() },
    );
    expect(malformed.status).toBe(400);
    const malformedBody = (await malformed.json()) as {
      readonly error: { readonly code: string; readonly message: string };
    };
    expect(malformedBody.error.code).toBe("BAD_REQUEST");
    expect(malformedBody.error.message).toContain("valid UUID");

    // Given: a seeded compose.
    const fixture = await track(
      store.set(
        seedAgentComposeReadFixture$,
        { composes: [{ name: "compose-by-id", versionId: VERSION_D }] },
        context.signal,
      ),
    );
    const composeId = fixture.composes[0]?.id;
    if (!composeId) {
      throw new Error("Expected seeded compose");
    }

    // When + Then: 200 for the owner.
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const owner = await accept(
      byIdClient().getById({
        params: { id: composeId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(owner.body.name).toBe("compose-by-id");

    // When + Then: 200 for an org member.
    mocks.clerk.session(`user_${randomUUID()}`, fixture.orgId);
    const member = await accept(
      byIdClient().getById({
        params: { id: composeId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(member.body.id).toBe(composeId);

    // When + Then: 200 for a sandbox token (any org).
    const sandboxAuth = {
      authorization: `Bearer ${sandboxToken({
        userId: `user_${randomUUID()}`,
        orgId: `org_${randomUUID()}`,
      })}`,
    };
    const sandbox = await accept(
      byIdClient().getById({
        params: { id: composeId },
        headers: sandboxAuth,
      }),
      [200],
    );
    expect(sandbox.body.id).toBe(composeId);

    // When + Then: 404 for a session in a different org
    // (inaccessible compose, not just missing).
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const inaccessible = await accept(
      byIdClient().getById({
        params: { id: composeId },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(inaccessible.body.error.message).toBe("Agent compose not found");

    // When + Then: 404 for the owner asking about a missing id.
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const missing = await accept(
      byIdClient().getById({
        params: { id: randomUUID() },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(missing.body.error.message).toBe("Agent compose not found");
  });
});

describe("BDD GET /api/agent/composes/list — list chain", () => {
  it("gwt-wt-wt: 401 unauth + 400 no-org → 200 empty → 200 sorted + isolated → 200 sandbox", async () => {
    // When + Then: 401 unauth.
    const unauth = await accept(
      listClient().list({ query: {}, headers: {} }),
      [401],
    );
    expect(unauth.body.error.message).toBe("Not authenticated");

    // When + Then: 400 no-org.
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const noOrg = await accept(
      listClient().list({ query: {}, headers: authHeaders() }),
      [400],
    );
    expect(noOrg.body).toStrictEqual({
      error: { message: "Invalid request", code: "BAD_REQUEST" },
    });

    // Given: a fresh org with no composes.
    const emptyFixture = await track(
      store.set(seedAgentComposeReadFixture$, { composes: [] }, context.signal),
    );
    mocks.clerk.session(emptyFixture.userId, emptyFixture.orgId);

    // When + Then: 200 with an empty list.
    const empty = await accept(
      listClient().list({ query: {}, headers: authHeaders() }),
      [200],
    );
    expect(empty.body).toStrictEqual({ composes: [] });

    // Given: an org with two composes + a separate org that
    // should not appear in the active org's list.
    const orgId = `org_${randomUUID()}`;
    const listFixture = await track(
      store.set(
        seedAgentComposeReadFixture$,
        {
          orgId,
          composes: [
            {
              name: "older-agent",
              versionId: VERSION_A,
              displayName: "Older Agent",
              description: "old",
              sound: "ding",
              updatedAt: new Date("2025-01-01T00:00:00.000Z"),
            },
            {
              name: "newer-agent",
              versionId: VERSION_B,
              displayName: "Newer Agent",
              description: "new",
              sound: "pong",
              updatedAt: new Date("2025-01-02T00:00:00.000Z"),
            },
          ],
        },
        context.signal,
      ),
    );
    await track(
      store.set(
        seedAgentComposeReadFixture$,
        { composes: [{ name: "other-org-agent", versionId: VERSION_C }] },
        context.signal,
      ),
    );
    mocks.clerk.session(listFixture.userId, orgId);

    // When + Then: 200 with the two composes sorted by
    // `updatedAt` desc, with the metadata fields, and the
    // other-org compose is NOT in the list.
    const list = await accept(
      listClient().list({ query: {}, headers: authHeaders() }),
      [200],
    );
    expect(list.body.composes).toHaveLength(2);
    expect(
      list.body.composes.map((c) => {
        return c.name;
      }),
    ).toStrictEqual(["newer-agent", "older-agent"]);
    expect(list.body.composes[0]).toMatchObject({
      displayName: "Newer Agent",
      description: "new",
      sound: "pong",
      headVersionId: VERSION_B,
    });

    // Given: a sandbox token in a fresh org with one compose.
    const sandboxFixture = await track(
      store.set(
        seedAgentComposeReadFixture$,
        { composes: [{ name: "sandbox-list-agent", versionId: VERSION_D }] },
        context.signal,
      ),
    );
    const sandboxAuth = {
      authorization: `Bearer ${sandboxToken({
        userId: sandboxFixture.userId,
        orgId: sandboxFixture.orgId,
      })}`,
    };

    // When + Then: 200 with the single compose.
    const sandbox = await accept(
      listClient().list({ query: {}, headers: sandboxAuth }),
      [200],
    );
    expect(sandbox.body.composes).toHaveLength(1);
    expect(sandbox.body.composes[0]?.name).toBe("sandbox-list-agent");
  });
});

describe("BDD GET /api/agent/composes/versions — versions chain", () => {
  it("gwt-wt-wt: 200 latest + 200 full hash + 200 prefix → 200 sandbox → 400 no-head + 404 missing version + 404 missing compose → 400 invalid + 400 ambiguous prefix", async () => {
    // Given: a compose with the head version + one extra
    // version (so the prefix lookups have a non-head target).
    const fixture = await track(
      store.set(
        seedAgentComposeReadFixture$,
        {
          composes: [
            {
              name: "version-agent",
              versionId: VERSION_E,
              extraVersionIds: [VERSION_D],
            },
          ],
        },
        context.signal,
      ),
    );
    const composeId = fixture.composes[0]?.id;
    if (!composeId) {
      throw new Error("Expected seeded compose");
    }
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: `latest` resolves to the head version.
    const latest = await accept(
      versionsClient().resolveVersion({
        query: { composeId, version: "latest" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(latest.body).toStrictEqual({ versionId: VERSION_E, tag: "latest" });

    // When + Then: a full 64-char hash resolves exactly.
    const fullHash = await accept(
      versionsClient().resolveVersion({
        query: { composeId, version: VERSION_D },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(fullHash.body).toStrictEqual({ versionId: VERSION_D });

    // When + Then: a short prefix resolves to the matching
    // version (here VERSION_D is `d` repeated 64, so the
    // 8-char prefix `dddddddd` is unambiguous).
    const prefix = await accept(
      versionsClient().resolveVersion({
        query: { composeId, version: VERSION_D.slice(0, 8) },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(prefix.body).toStrictEqual({ versionId: VERSION_D });

    // Given: a sandbox token for the same compose.
    const sandboxAuth = {
      authorization: `Bearer ${sandboxToken({
        userId: fixture.userId,
        orgId: fixture.orgId,
      })}`,
    };

    // When + Then: sandbox token resolves `latest`.
    const sandbox = await accept(
      versionsClient().resolveVersion({
        query: { composeId, version: "latest" },
        headers: sandboxAuth,
      }),
      [200],
    );
    expect(sandbox.body).toStrictEqual({ versionId: VERSION_E, tag: "latest" });

    // Given: a fresh compose with a null head version.
    const emptyFixture = await track(
      store.set(
        seedAgentComposeReadFixture$,
        { composes: [{ name: "empty-agent", versionId: null }] },
        context.signal,
      ),
    );
    const emptyComposeId = emptyFixture.composes[0]?.id;
    if (!emptyComposeId) {
      throw new Error("Expected seeded compose");
    }
    mocks.clerk.session(emptyFixture.userId, emptyFixture.orgId);

    // When + Then: 400 — head version is null.
    const noHead = await accept(
      versionsClient().resolveVersion({
        query: { composeId: emptyComposeId, version: "latest" },
        headers: authHeaders(),
      }),
      [400],
    );
    expect(noHead.body.error.message).toBe(
      "Agent compose has no versions. Run 'vm0 build' first.",
    );

    // When + Then: 404 — `deadbeef` is a valid prefix shape
    // but not a real version for this compose.
    const missingVersion = await accept(
      versionsClient().resolveVersion({
        query: { composeId: emptyComposeId, version: "deadbeef" },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(missingVersion.body.error.message).toBe(
      "Version 'deadbeef' not found",
    );

    // When + Then: 404 — a different user in the same org
    // does not own the compose (hidden as not-found).
    mocks.clerk.session(`user_${randomUUID()}`, emptyFixture.orgId);
    const missingCompose = await accept(
      versionsClient().resolveVersion({
        query: { composeId: emptyComposeId, version: "latest" },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(missingCompose.body.error.message).toBe("Agent compose not found");

    // Given: a compose with two versions sharing an
    // `abcdef12` prefix.
    const ambiguousFixture = await track(
      store.set(
        seedAgentComposeReadFixture$,
        {
          composes: [
            {
              name: "ambiguous-version-agent",
              versionId: AMBIGUOUS_VERSION_A,
              extraVersionIds: [AMBIGUOUS_VERSION_B],
            },
          ],
        },
        context.signal,
      ),
    );
    const ambiguousComposeId = ambiguousFixture.composes[0]?.id;
    if (!ambiguousComposeId) {
      throw new Error("Expected seeded compose");
    }
    mocks.clerk.session(ambiguousFixture.userId, ambiguousFixture.orgId);

    // When + Then: 400 — the 3-char version `abc` is invalid
    // per the 8-64 hex constraint. The ts-rest client would
    // block this client-side, so go through the raw app.
    const app = createApp({ signal: context.signal });
    const invalid = await app.request(
      `/api/agent/composes/versions?composeId=${ambiguousComposeId}&version=abc`,
      { method: "GET", headers: authHeaders() },
    );
    expect(invalid.status).toBe(400);
    const invalidBody = (await invalid.json()) as {
      readonly error: { readonly message: string };
    };
    expect(invalidBody.error.message).toContain("8-64 hex characters");

    // When + Then: 400 — the 8-char prefix `abcdef12`
    // matches both versions.
    const ambiguous = await accept(
      versionsClient().resolveVersion({
        query: { composeId: ambiguousComposeId, version: "abcdef12" },
        headers: authHeaders(),
      }),
      [400],
    );
    expect(ambiguous.body.error.message).toBe(
      "Ambiguous version prefix 'abcdef12'. Please use more characters.",
    );
  });
});

describe("BDD GET /api/agent/composes/:id/instructions — instructions chain", () => {
  it("gwt-wt-wt: 400 malformed + 401 unauth + 404 missing → 200 canonical + 200 explicit → 200 storage member + 200 storage sandbox → 404 non-member", async () => {
    // Given: an authenticated session.
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const app = createApp({ signal: context.signal });

    // When + Then: 400 malformed id (raw app).
    const malformed = await app.request(
      "/api/agent/composes/91fc0bd84bba673393d9adfc1a0f4dec/instructions",
      { method: "GET", headers: authHeaders() },
    );
    expect(malformed.status).toBe(400);

    // When + Then: 401 unauth.
    const unauth = await accept(
      instructionsClient().getInstructions({
        params: { id: randomUUID() },
        headers: {},
      }),
      [401],
    );
    expect(unauth.body.error.code).toBe("UNAUTHORIZED");

    // When + Then: 404 missing compose.
    const missing = await accept(
      instructionsClient().getInstructions({
        params: { id: randomUUID() },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(missing.body.error.message).toBe("Agent compose not found");

    // Given: two composes — one with no instructions
    // (canonical filename `CLAUDE.md`) and one with an
    // explicit `AGENTS.md` filename.
    const fixture = await track(
      store.set(
        seedAgentComposeReadFixture$,
        {
          composes: [
            {
              name: "no-instructions-agent",
              versionId: VERSION_A,
              content: composeContent("no-instructions-agent"),
            },
            {
              name: "explicit-instructions-agent",
              versionId: VERSION_B,
              content: composeContent(
                "explicit-instructions-agent",
                "AGENTS.md",
              ),
            },
          ],
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const canonicalId = fixture.composes[0]?.id;
    const explicitId = fixture.composes[1]?.id;
    if (!canonicalId || !explicitId) {
      throw new Error("Expected seeded composes");
    }

    // When + Then: 200 + null content + canonical filename.
    const canonical = await accept(
      instructionsClient().getInstructions({
        params: { id: canonicalId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(canonical.body).toStrictEqual({
      content: null,
      filename: "CLAUDE.md",
    });

    // When + Then: 200 + null content + explicit filename.
    const explicit = await accept(
      instructionsClient().getInstructions({
        params: { id: explicitId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(explicit.body).toStrictEqual({
      content: null,
      filename: "AGENTS.md",
    });

    // Given: a fresh compose with a seeded instructions
    // storage row + mocked S3 content.
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", "test-bucket");
    const storageFixture = await track(
      store.set(
        seedAgentComposeReadFixture$,
        {
          composes: [
            {
              name: "instructions-agent",
              versionId: VERSION_C,
              content: composeContent("instructions-agent", "AGENTS.md"),
            },
          ],
        },
        context.signal,
      ),
    );
    const storageComposeId = storageFixture.composes[0]?.id;
    if (!storageComposeId) {
      throw new Error("Expected seeded compose");
    }
    const s3Key = `orgs/${storageFixture.orgId}/agent-instructions@instructions-agent/v1`;
    await store.set(
      seedInstructionsStorage$,
      {
        orgId: storageFixture.orgId,
        userId: storageFixture.userId,
        agentName: "instructions-agent",
        s3Key,
        headVersionId: VERSION_D,
      },
      context.signal,
    );

    // When + Then: 200 + member read returns the storage
    // content under the explicit `AGENTS.md` filename.
    mocks.clerk.session(`user_${randomUUID()}`, storageFixture.orgId);
    mockInstructionsContent(context, {
      s3Key,
      filename: "CLAUDE.md",
      manifestPath: "./CLAUDE.md",
      content: "# Shared Instructions",
    });
    const member = await accept(
      instructionsClient().getInstructions({
        params: { id: storageComposeId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(member.body).toStrictEqual({
      content: "# Shared Instructions",
      filename: "AGENTS.md",
    });

    // When + Then: 200 + sandbox token read returns the
    // storage content under the explicit filename (the
    // filename comes from the compose content, not the
    // S3 mock).
    const sandboxAuth = {
      authorization: `Bearer ${sandboxToken({
        userId: `user_${randomUUID()}`,
        orgId: `org_${randomUUID()}`,
      })}`,
    };
    mockInstructionsContent(context, {
      s3Key,
      filename: "CLAUDE.md",
      content: "# Sandbox Instructions",
    });
    const sandbox = await accept(
      instructionsClient().getInstructions({
        params: { id: storageComposeId },
        headers: sandboxAuth,
      }),
      [200],
    );
    expect(sandbox.body).toStrictEqual({
      content: "# Sandbox Instructions",
      filename: "AGENTS.md",
    });

    // Given: a session in a different org asking for the
    // original compose that the user does not own.
    const noAccessFixture = await track(
      store.set(
        seedAgentComposeReadFixture$,
        {
          composes: [
            {
              name: "no-access-agent",
              versionId: `${"f".repeat(64)}`,
            },
          ],
        },
        context.signal,
      ),
    );
    const noAccessComposeId = noAccessFixture.composes[0]?.id;
    if (!noAccessComposeId) {
      throw new Error("Expected seeded compose");
    }
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    // When + Then: 404.
    const noAccess = await accept(
      instructionsClient().getInstructions({
        params: { id: noAccessComposeId },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(noAccess.body.error.message).toBe("Agent compose not found");
  });
});
