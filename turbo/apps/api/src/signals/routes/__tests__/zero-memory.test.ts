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

describe("GET /api/zero/memory", () => {
  const track = createFixtureTracker<MemoryFixture>((fixture) => {
    return store.set(deleteMemoryForFixture$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const response = await accept(memoryClient().get({ headers: {} }), [401]);
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const response = await accept(
      memoryClient().get({ headers: authHeaders() }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns exists:false when the user has no memory artifact", async () => {
    const fixture = await track(
      store.set(seedMemoryFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      memoryClient().get({ headers: authHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({
      exists: false,
      name: MEMORY_ARTIFACT_NAME,
      size: 0,
      fileCount: 0,
      updatedAt: null,
      files: [],
      fileContents: [],
    });
  });

  it("returns an empty file list when the artifact exists but is empty", async () => {
    const fixture = await track(
      store.set(seedMemoryFixture$, undefined, context.signal),
    );
    const updatedAt = new Date("2025-03-04T05:06:07.000Z");
    await store.set(
      seedMemoryStorage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        s3Key: `orgs/${fixture.orgId}/users/${fixture.userId}/memory/v1`,
        headVersionId: null,
        size: 0,
        fileCount: 0,
        updatedAt,
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      memoryClient().get({ headers: authHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({
      exists: true,
      name: MEMORY_ARTIFACT_NAME,
      size: 0,
      fileCount: 0,
      updatedAt: updatedAt.toISOString(),
      files: [],
      fileContents: [],
    });
  });

  it("returns file listing and contents for a populated memory artifact", async () => {
    const fixture = await track(
      store.set(seedMemoryFixture$, undefined, context.signal),
    );
    const s3Key = `orgs/${fixture.orgId}/users/${fixture.userId}/memory/v1`;
    const updatedAt = new Date("2025-04-05T06:07:08.000Z");
    await store.set(
      seedMemoryStorage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
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
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      memoryClient().get({ headers: authHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({
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
  });

  it("normalizes ./-prefixed manifest paths", async () => {
    const fixture = await track(
      store.set(seedMemoryFixture$, undefined, context.signal),
    );
    const s3Key = `orgs/${fixture.orgId}/users/${fixture.userId}/memory/v1`;
    await store.set(
      seedMemoryStorage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        s3Key,
        size: 7,
        fileCount: 1,
      },
      context.signal,
    );
    mockMemoryContent(context, {
      s3Key,
      files: [{ path: "./MEMORY.md", content: "# Memory" }],
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      memoryClient().get({ headers: authHeaders() }),
      [200],
    );

    expect(response.body.files).toStrictEqual([{ path: "MEMORY.md", size: 8 }]);
    expect(response.body.fileContents).toStrictEqual([
      { path: "MEMORY.md", content: "# Memory" },
    ]);
  });

  it("scopes memory to the requesting user", async () => {
    const fixture = await track(
      store.set(seedMemoryFixture$, undefined, context.signal),
    );
    const otherUserId = `user_${randomUUID()}`;
    const otherS3Key = `orgs/${fixture.orgId}/users/${otherUserId}/memory/v1`;
    await store.set(
      seedMemoryStorage$,
      {
        orgId: fixture.orgId,
        userId: otherUserId,
        s3Key: otherS3Key,
        size: 12,
        fileCount: 1,
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      memoryClient().get({ headers: authHeaders() }),
      [200],
    );

    expect(response.body.exists).toBeFalsy();
  });

  it("accepts CLI token auth when reading memory", async () => {
    const fixture = await track(
      store.set(seedMemoryFixture$, undefined, context.signal),
    );
    const s3Key = `orgs/${fixture.orgId}/users/${fixture.userId}/memory/v1`;
    await store.set(
      seedMemoryStorage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        s3Key,
        size: 14,
        fileCount: 1,
      },
      context.signal,
    );
    mockMemoryContent(context, {
      s3Key,
      files: [{ path: "MEMORY.md", content: "# CLI Memory" }],
    });

    const response = await accept(
      memoryClient().get({ headers: await cliAuthHeaders(fixture) }),
      [200],
    );

    expect(response.body.exists).toBeTruthy();
    expect(response.body.fileContents).toStrictEqual([
      { path: "MEMORY.md", content: "# CLI Memory" },
    ]);
  });
});
