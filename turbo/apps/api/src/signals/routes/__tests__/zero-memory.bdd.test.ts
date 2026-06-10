import { randomUUID } from "node:crypto";

import { zeroMemoryContract } from "@vm0/api-contracts/contracts/zero-memory";
import { MEMORY_ARTIFACT_NAME } from "@vm0/core/storage-names";
import { cliTokens } from "@vm0/db/schema/cli-tokens";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { generateCliToken } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import {
  deleteMemoryForFixture$,
  mockMemoryContent,
  type MemoryFixture,
  seedMemoryFixture$,
  seedMemoryStorage$,
} from "./helpers/zero-memory";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

// BDD migration of the legacy `zero-memory.test.ts`. The 7
// legacy `it()`s collapse into 3 BDD `it()`s: (1) auth + 200
// empty chain (401 unauth → 401 no-org → 200 no memory → 200
// empty artifact), (2) 200 populated chain (200 populated
// artifact with file listing + contents → 200 normalizes
// ./-prefixed manifest paths), (3) isolation + CLI auth
// chain (200 scopes memory to the requesting user, the
// other-user's storage is not visible → 200 accepts CLI token
// auth when reading memory).
//
// Service-Level Exception: memory storage rows are seeded
// directly via `writeDb$` because no public route creates a
// memory storage row.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

async function cliAuthHeaders(
  fixture: MemoryFixture,
): Promise<{ readonly authorization: string }> {
  const tokenId = randomUUID();
  const token = generateCliToken(fixture.userId, fixture.orgId, tokenId);
  const writeDb = store.set(writeDb$);
  await writeDb.insert(cliTokens).values({
    id: tokenId,
    token,
    userId: fixture.userId,
    name: "Test Token",
    expiresAt: new Date(now() + 60 * 60 * 1000),
  });
  await writeDb
    .insert(orgMembersCache)
    .values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      role: "member",
      cachedAt: new Date(now() + 60 * 1000),
    })
    .onConflictDoUpdate({
      target: [orgMembersCache.orgId, orgMembersCache.userId],
      set: {
        role: "member",
        cachedAt: new Date(now() + 60 * 1000),
      },
    });

  return { authorization: `Bearer ${token}` };
}

function memoryClient() {
  return setupApp({ context })(zeroMemoryContract);
}

const track = createFixtureTracker<MemoryFixture>((fixture) => {
  return store.set(deleteMemoryForFixture$, fixture, context.signal);
});

describe("BDD GET /api/zero/memory — auth + 200 empty chain", () => {
  it("gwt-wt-wt: 401 unauth → 401 no-org → 200 no memory → 200 empty artifact", async () => {
    const c = memoryClient();

    // When + Then: 401 with no auth header.
    const noAuth = await accept(c.get({ headers: {} }), [401]);
    expect(noAuth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a session with a user but no org.
    mocks.clerk.session(`user_${randomUUID()}`, null);

    // When + Then: still 401.
    const noOrg = await accept(c.get({ headers: authHeaders() }), [401]);
    expect(noOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a fresh user with no memory artifact.
    const emptyFx = await track(
      store.set(seedMemoryFixture$, undefined, context.signal),
    );
    mocks.clerk.session(emptyFx.userId, emptyFx.orgId);

    // When + Then: 200 with exists: false.
    const empty = await accept(c.get({ headers: authHeaders() }), [200]);
    expect(empty.body).toStrictEqual({
      exists: false,
      name: MEMORY_ARTIFACT_NAME,
      size: 0,
      fileCount: 0,
      updatedAt: null,
      files: [],
      fileContents: [],
    });

    // Given: a fresh user with an empty memory artifact.
    const emptyArtifactFx = await track(
      store.set(seedMemoryFixture$, undefined, context.signal),
    );
    const updatedAt = new Date("2025-03-04T05:06:07.000Z");
    await store.set(
      seedMemoryStorage$,
      {
        orgId: emptyArtifactFx.orgId,
        userId: emptyArtifactFx.userId,
        s3Key: `orgs/${emptyArtifactFx.orgId}/users/${emptyArtifactFx.userId}/memory/v1`,
        headVersionId: null,
        size: 0,
        fileCount: 0,
        updatedAt,
      },
      context.signal,
    );
    mocks.clerk.session(emptyArtifactFx.userId, emptyArtifactFx.orgId);

    // When + Then: 200 with exists: true + empty file list.
    const emptyArtifact = await accept(
      c.get({ headers: authHeaders() }),
      [200],
    );
    expect(emptyArtifact.body).toStrictEqual({
      exists: true,
      name: MEMORY_ARTIFACT_NAME,
      size: 0,
      fileCount: 0,
      updatedAt: updatedAt.toISOString(),
      files: [],
      fileContents: [],
    });
  });
});

describe("BDD GET /api/zero/memory — 200 populated chain", () => {
  it("gwt-wt-wt: 200 populated artifact with file listing + contents → 200 normalizes ./-prefixed manifest paths", async () => {
    const c = memoryClient();

    // Given: a user with a populated memory artifact.
    const populatedFx = await track(
      store.set(seedMemoryFixture$, undefined, context.signal),
    );
    const s3Key = `orgs/${populatedFx.orgId}/users/${populatedFx.userId}/memory/v1`;
    const updatedAt = new Date("2025-04-05T06:07:08.000Z");
    await store.set(
      seedMemoryStorage$,
      {
        orgId: populatedFx.orgId,
        userId: populatedFx.userId,
        s3Key,
        size: 31,
        fileCount: 2,
        updatedAt,
      },
      context.signal,
    );
    mockMemoryContent(context, {
      s3Key,
      files: [
        { path: "MEMORY.md", content: "# My Memory" },
        { path: "notes/todo.md", content: "Do the thing" },
      ],
    });
    mocks.clerk.session(populatedFx.userId, populatedFx.orgId);

    // When + Then: 200 with the file listing + contents.
    const populated = await accept(c.get({ headers: authHeaders() }), [200]);
    expect(populated.body).toStrictEqual({
      exists: true,
      name: MEMORY_ARTIFACT_NAME,
      size: 31,
      fileCount: 2,
      updatedAt: updatedAt.toISOString(),
      files: [
        { path: "MEMORY.md", size: 11 },
        { path: "notes/todo.md", size: 12 },
      ],
      fileContents: [
        { path: "MEMORY.md", content: "# My Memory" },
        { path: "notes/todo.md", content: "Do the thing" },
      ],
    });

    // Given: a user with a populated artifact whose manifest
    // uses a ./-prefixed path.
    const dotFx = await track(
      store.set(seedMemoryFixture$, undefined, context.signal),
    );
    const dotS3Key = `orgs/${dotFx.orgId}/users/${dotFx.userId}/memory/v1`;
    await store.set(
      seedMemoryStorage$,
      {
        orgId: dotFx.orgId,
        userId: dotFx.userId,
        s3Key: dotS3Key,
        size: 7,
        fileCount: 1,
      },
      context.signal,
    );
    mockMemoryContent(context, {
      s3Key: dotS3Key,
      files: [{ path: "./MEMORY.md", content: "# Memory" }],
    });
    mocks.clerk.session(dotFx.userId, dotFx.orgId);

    // When + Then: 200 with the normalized path.
    const dot = await accept(c.get({ headers: authHeaders() }), [200]);
    expect(dot.body.files).toStrictEqual([{ path: "MEMORY.md", size: 8 }]);
    expect(dot.body.fileContents).toStrictEqual([
      { path: "MEMORY.md", content: "# Memory" },
    ]);
  });
});

describe("BDD GET /api/zero/memory — isolation + CLI auth chain", () => {
  it("gwt-wt-wt: 200 scopes memory to the requesting user (other-user's storage is not visible) → 200 accepts CLI token auth when reading memory", async () => {
    const c = memoryClient();

    // Given: a user with no memory artifact; another user in
    // the same org has a memory artifact.
    const isolationFx = await track(
      store.set(seedMemoryFixture$, undefined, context.signal),
    );
    const otherUserId = `user_${randomUUID()}`;
    const otherS3Key = `orgs/${isolationFx.orgId}/users/${otherUserId}/memory/v1`;
    await store.set(
      seedMemoryStorage$,
      {
        orgId: isolationFx.orgId,
        userId: otherUserId,
        s3Key: otherS3Key,
        size: 12,
        fileCount: 1,
      },
      context.signal,
    );
    mocks.clerk.session(isolationFx.userId, isolationFx.orgId);

    // When + Then: 200 with exists: false (the other user's
    // storage is not visible).
    const isolated = await accept(c.get({ headers: authHeaders() }), [200]);
    expect(isolated.body.exists).toBeFalsy();

    // Given: a user with a populated memory artifact.
    const cliFx = await track(
      store.set(seedMemoryFixture$, undefined, context.signal),
    );
    const cliS3Key = `orgs/${cliFx.orgId}/users/${cliFx.userId}/memory/v1`;
    await store.set(
      seedMemoryStorage$,
      {
        orgId: cliFx.orgId,
        userId: cliFx.userId,
        s3Key: cliS3Key,
        size: 14,
        fileCount: 1,
      },
      context.signal,
    );
    mockMemoryContent(context, {
      s3Key: cliS3Key,
      files: [{ path: "MEMORY.md", content: "# CLI Memory" }],
    });

    // When + Then: 200 with the populated content via CLI
    // auth.
    const cli = await accept(
      c.get({ headers: await cliAuthHeaders(cliFx) }),
      [200],
    );
    expect(cli.body.exists).toBeTruthy();
    expect(cli.body.fileContents).toStrictEqual([
      { path: "MEMORY.md", content: "# CLI Memory" },
    ]);
  });
});
