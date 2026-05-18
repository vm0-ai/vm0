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
import { describe, expect, it } from "vitest";

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

describe("GET /api/agent/composes", () => {
  it("returns 401 when unauthenticated", async () => {
    const response = await accept(
      mainClient().getByName({ query: { name: "missing" }, headers: {} }),
      [401],
    );

    expect(response.body.error).toStrictEqual({
      message: "Not authenticated",
      code: "UNAUTHORIZED",
    });
  });

  it("returns 400 when the name query is missing", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const app = createApp({ signal: context.signal });

    const response = await app.request("/api/agent/composes", {
      method: "GET",
      headers: { authorization: "Bearer clerk-session" },
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      readonly error: { readonly code: string; readonly message: string };
    };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("expected string");
  });

  it("returns a compose by name for the owner active org", async () => {
    const fixture = await track(
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
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      mainClient().getByName({
        query: { name: "owner-agent" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.id).toBe(fixture.composes[0]?.id);
    expect(response.body.name).toBe("owner-agent");
    expect(response.body.headVersionId).toBe(VERSION_A);
    expect(response.body.content).toStrictEqual(composeContent("owner-agent"));
  });

  it("uses active org scope for member and non-member lookups", async () => {
    const fixture = await track(
      store.set(
        seedAgentComposeReadFixture$,
        {
          composes: [{ name: "shared-agent", versionId: VERSION_B }],
        },
        context.signal,
      ),
    );

    mocks.clerk.session(`user_${randomUUID()}`, fixture.orgId);
    const memberResponse = await accept(
      mainClient().getByName({
        query: { name: "shared-agent" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(memberResponse.body.id).toBe(fixture.composes[0]?.id);

    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const otherOrgResponse = await accept(
      mainClient().getByName({
        query: { name: "shared-agent" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(otherOrgResponse.body.error.message).toBe(
      "Agent compose not found: shared-agent",
    );
  });

  it("accepts sandbox tokens", async () => {
    const fixture = await track(
      store.set(
        seedAgentComposeReadFixture$,
        {
          composes: [{ name: "sandbox-agent", versionId: VERSION_C }],
        },
        context.signal,
      ),
    );
    const token = sandboxToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
    });

    const response = await accept(
      mainClient().getByName({
        query: { name: "sandbox-agent" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );

    expect(response.body.id).toBe(fixture.composes[0]?.id);
  });
});

describe("GET /api/agent/composes/:id", () => {
  it("returns 400 for malformed compose id", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const app = createApp({ signal: context.signal });

    const response = await app.request(
      "/api/agent/composes/91fc0bd84bba673393d9adfc1a0f4dec",
      {
        method: "GET",
        headers: { authorization: "Bearer clerk-session" },
      },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      readonly error: { readonly code: string; readonly message: string };
    };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("valid UUID");
  });

  it("returns the compose for owner, org member, and sandbox token", async () => {
    const fixture = await track(
      store.set(
        seedAgentComposeReadFixture$,
        {
          composes: [{ name: "compose-by-id", versionId: VERSION_D }],
        },
        context.signal,
      ),
    );
    const composeId = fixture.composes[0]?.id;
    if (!composeId) {
      throw new Error("Expected seeded compose");
    }

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const ownerResponse = await accept(
      byIdClient().getById({
        params: { id: composeId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(ownerResponse.body.name).toBe("compose-by-id");

    mocks.clerk.session(`user_${randomUUID()}`, fixture.orgId);
    const memberResponse = await accept(
      byIdClient().getById({
        params: { id: composeId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(memberResponse.body.id).toBe(composeId);

    const token = sandboxToken({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    });
    const sandboxResponse = await accept(
      byIdClient().getById({
        params: { id: composeId },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );
    expect(sandboxResponse.body.id).toBe(composeId);
  });

  it("returns 404 for missing or inaccessible composes", async () => {
    const fixture = await track(
      store.set(seedAgentComposeReadFixture$, {}, context.signal),
    );
    const composeId = fixture.composes[0]?.id;
    if (!composeId) {
      throw new Error("Expected seeded compose");
    }

    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const inaccessibleResponse = await accept(
      byIdClient().getById({
        params: { id: composeId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(inaccessibleResponse.body.error.message).toBe(
      "Agent compose not found",
    );

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const missingResponse = await accept(
      byIdClient().getById({
        params: { id: randomUUID() },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(missingResponse.body.error.message).toBe("Agent compose not found");
  });
});

describe("GET /api/agent/composes/list", () => {
  it("returns 401 when unauthenticated and 400 when there is no active org", async () => {
    const unauthenticated = await accept(
      listClient().list({ query: {}, headers: {} }),
      [401],
    );
    expect(unauthenticated.body.error.message).toBe("Not authenticated");

    mocks.clerk.session(`user_${randomUUID()}`, null);
    const noOrg = await accept(
      listClient().list({
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    expect(noOrg.body).toStrictEqual({
      error: { message: "Invalid request", code: "BAD_REQUEST" },
    });
  });

  it("lists composes for the active org with metadata", async () => {
    const orgId = `org_${randomUUID()}`;
    const fixture = await track(
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
        {
          composes: [{ name: "other-org-agent", versionId: VERSION_C }],
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, orgId);

    const response = await accept(
      listClient().list({
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.composes).toHaveLength(2);
    expect(
      response.body.composes.map((compose) => {
        return compose.name;
      }),
    ).toStrictEqual(["newer-agent", "older-agent"]);
    expect(response.body.composes[0]).toMatchObject({
      displayName: "Newer Agent",
      description: "new",
      sound: "pong",
      headVersionId: VERSION_B,
    });
  });

  it("accepts sandbox tokens", async () => {
    const fixture = await track(
      store.set(
        seedAgentComposeReadFixture$,
        {
          composes: [{ name: "sandbox-list-agent", versionId: VERSION_D }],
        },
        context.signal,
      ),
    );
    const token = sandboxToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
    });

    const response = await accept(
      listClient().list({
        query: {},
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );

    expect(response.body.composes).toHaveLength(1);
    expect(response.body.composes[0]?.name).toBe("sandbox-list-agent");
  });
});

describe("GET /api/agent/composes/versions", () => {
  it("resolves latest, full hashes, and prefixes", async () => {
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

    const latest = await accept(
      versionsClient().resolveVersion({
        query: { composeId, version: "latest" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(latest.body).toStrictEqual({ versionId: VERSION_E, tag: "latest" });

    const fullHash = await accept(
      versionsClient().resolveVersion({
        query: { composeId, version: VERSION_D },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(fullHash.body).toStrictEqual({ versionId: VERSION_D });

    const prefix = await accept(
      versionsClient().resolveVersion({
        query: { composeId, version: VERSION_D.slice(0, 8) },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(prefix.body).toStrictEqual({ versionId: VERSION_D });
  });

  it("accepts sandbox tokens", async () => {
    const fixture = await track(
      store.set(
        seedAgentComposeReadFixture$,
        {
          composes: [{ name: "sandbox-version-agent", versionId: VERSION_C }],
        },
        context.signal,
      ),
    );
    const composeId = fixture.composes[0]?.id;
    if (!composeId) {
      throw new Error("Expected seeded compose");
    }
    const token = sandboxToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
    });

    const response = await accept(
      versionsClient().resolveVersion({
        query: { composeId, version: "latest" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      versionId: VERSION_C,
      tag: "latest",
    });
  });

  it("returns web-compatible errors for missing compose, missing head, and version misses", async () => {
    const fixture = await track(
      store.set(
        seedAgentComposeReadFixture$,
        { composes: [{ name: "empty-agent", versionId: null }] },
        context.signal,
      ),
    );
    const composeId = fixture.composes[0]?.id;
    if (!composeId) {
      throw new Error("Expected seeded compose");
    }
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const noHead = await accept(
      versionsClient().resolveVersion({
        query: { composeId, version: "latest" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    expect(noHead.body.error.message).toBe(
      "Agent compose has no versions. Run 'vm0 build' first.",
    );

    const missingVersion = await accept(
      versionsClient().resolveVersion({
        query: { composeId, version: "deadbeef" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(missingVersion.body.error.message).toBe(
      "Version 'deadbeef' not found",
    );

    const otherUser = `user_${randomUUID()}`;
    mocks.clerk.session(otherUser, fixture.orgId);
    const missingCompose = await accept(
      versionsClient().resolveVersion({
        query: { composeId, version: "latest" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(missingCompose.body.error.message).toBe("Agent compose not found");
  });

  it("returns 400 for invalid query values and ambiguous prefixes", async () => {
    const fixture = await track(
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
    const composeId = fixture.composes[0]?.id;
    if (!composeId) {
      throw new Error("Expected seeded compose");
    }
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const app = createApp({ signal: context.signal });
    const invalid = await app.request(
      `/api/agent/composes/versions?composeId=${composeId}&version=abc`,
      {
        method: "GET",
        headers: { authorization: "Bearer clerk-session" },
      },
    );
    expect(invalid.status).toBe(400);
    const invalidBody = (await invalid.json()) as {
      readonly error: { readonly message: string };
    };
    expect(invalidBody.error.message).toContain("8-64 hex characters");

    const ambiguous = await accept(
      versionsClient().resolveVersion({
        query: { composeId, version: "abcdef12" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    expect(ambiguous.body.error.message).toBe(
      "Ambiguous version prefix 'abcdef12'. Please use more characters.",
    );
  });
});

describe("GET /api/agent/composes/:id/instructions", () => {
  it("returns validation, auth, and not-found errors", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const app = createApp({ signal: context.signal });

    const malformed = await app.request(
      "/api/agent/composes/91fc0bd84bba673393d9adfc1a0f4dec/instructions",
      {
        method: "GET",
        headers: { authorization: "Bearer clerk-session" },
      },
    );
    expect(malformed.status).toBe(400);

    const unauthenticated = await accept(
      instructionsClient().getInstructions({
        params: { id: randomUUID() },
        headers: {},
      }),
      [401],
    );
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const missing = await accept(
      instructionsClient().getInstructions({
        params: { id: randomUUID() },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(missing.body.error.message).toBe("Agent compose not found");
  });

  it("returns null content with canonical or explicit filename when storage is absent", async () => {
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

    const canonical = await accept(
      instructionsClient().getInstructions({
        params: { id: canonicalId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(canonical.body).toStrictEqual({
      content: null,
      filename: "CLAUDE.md",
    });

    const explicit = await accept(
      instructionsClient().getInstructions({
        params: { id: explicitId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(explicit.body).toStrictEqual({
      content: null,
      filename: "AGENTS.md",
    });
  });

  it("reads instructions content from storage for members and sandbox tokens", async () => {
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", "test-bucket");
    const fixture = await track(
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
    const composeId = fixture.composes[0]?.id;
    if (!composeId) {
      throw new Error("Expected seeded compose");
    }
    const s3Key = `orgs/${fixture.orgId}/agent-instructions@instructions-agent/v1`;
    await store.set(
      seedInstructionsStorage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        agentName: "instructions-agent",
        s3Key,
        headVersionId: VERSION_D,
      },
      context.signal,
    );

    mocks.clerk.session(`user_${randomUUID()}`, fixture.orgId);
    mockInstructionsContent(context, {
      s3Key,
      filename: "CLAUDE.md",
      manifestPath: "./CLAUDE.md",
      content: "# Shared Instructions",
    });
    const memberResponse = await accept(
      instructionsClient().getInstructions({
        params: { id: composeId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(memberResponse.body).toStrictEqual({
      content: "# Shared Instructions",
      filename: "AGENTS.md",
    });

    const token = sandboxToken({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    });
    mockInstructionsContent(context, {
      s3Key,
      filename: "CLAUDE.md",
      content: "# Sandbox Instructions",
    });
    const sandboxResponse = await accept(
      instructionsClient().getInstructions({
        params: { id: composeId },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );
    expect(sandboxResponse.body).toStrictEqual({
      content: "# Sandbox Instructions",
      filename: "AGENTS.md",
    });
  });

  it("returns 404 for non-members", async () => {
    const fixture = await track(
      store.set(seedAgentComposeReadFixture$, {}, context.signal),
    );
    const composeId = fixture.composes[0]?.id;
    if (!composeId) {
      throw new Error("Expected seeded compose");
    }
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const response = await accept(
      instructionsClient().getInstructions({
        params: { id: composeId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body.error.message).toBe("Agent compose not found");
  });
});
