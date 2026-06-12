import { randomUUID } from "node:crypto";

import { getInstructionsStorageName } from "@vm0/core/storage-names";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { mockEnv } from "../../../lib/env";
import { testContext } from "../../../__tests__/test-helpers";
import { expectApiError } from "./helpers/api-bdd";
import {
  createAuthOrgAgentsBddApi,
  type ApiTestUser,
} from "./helpers/api-bdd-auth-org";
import { storageTextFile } from "./helpers/api-bdd-chat-files";
import {
  AMBIGUOUS_COMPOSE_CONTENTS,
  AMBIGUOUS_COMPOSE_NAME,
  AMBIGUOUS_VERSION_IDS,
  AMBIGUOUS_VERSION_PREFIX,
  createComposesBddApi,
  mockComposeInstructionsDownloads,
  sandboxComposeToken,
  zeroComposeDeleteToken,
} from "./helpers/api-bdd-composes";
import { mockClerkMembership } from "./helpers/api-bdd-github";
import { createRunsSchedulesApi } from "./helpers/api-bdd-runs-schedules";
import { createStoragesBddApi } from "./helpers/api-bdd-storages";

/*
 * COMPOSE-01 round-5 expansion. The compose lifecycle chain (create, read,
 * list, metadata, delete through public APIs) lives in
 * auth-org-agents.bdd.test.ts and stays there; this file adds version
 * resolution, instructions, token scoping, zero-route errors, and delete
 * protection/sweep behavior.
 *
 * - Version ids are sha256 hashes of canonical compose content, so the
 *   ambiguous-prefix 400 is API-constructible from the precomputed
 *   collision pair in api-bdd-composes.ts (unlike storage versions, where
 *   the same arm is recorded as a docs exception).
 * - The delete-protection chain keeps its direct run pending (never
 *   claimed) and cancels it afterwards; pending runs stay visible inside
 *   the 15-minute pending-run TTL, so no mockNow is needed.
 * - Unreachable arms intentionally not exercised (see api.bdd.md):
 *   agent-composes-read.service `agentComposeVersionResolution` no-head 400
 *   ("Agent compose has no versions...") — every public write path sets a
 *   head version; and `agentComposeInstructions` safeParse-failure
 *   `{content:null, filename:null}` — stored content is contract-validated
 *   on every public write path.
 */

const context = testContext();
const api = createAuthOrgAgentsBddApi(context);
const composes = createComposesBddApi(context);
const storages = createStoragesBddApi(context);

function shortId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 10);
}

function slug(prefix: string): string {
  return `${prefix}-${shortId()}`;
}

function orgIdOf(actor: ApiTestUser): string {
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped actor");
  }
  return actor.orgId;
}

interface ComposeAgentOptions {
  readonly framework?: "claude-code" | "codex";
  readonly description?: string;
  readonly instructions?: string;
  readonly environment?: Readonly<Record<string, string>>;
}

function composeWith(name: string, agent: ComposeAgentOptions = {}) {
  return {
    version: "1.0",
    agents: {
      [name]: {
        framework: agent.framework ?? ("claude-code" as const),
        ...(agent.description === undefined
          ? {}
          : { description: agent.description }),
        ...(agent.instructions === undefined
          ? {}
          : { instructions: agent.instructions }),
        ...(agent.environment === undefined
          ? {}
          : { environment: { ...agent.environment } }),
      },
    },
  };
}

const storedComposeSchema = z.object({
  content: z.object({
    agents: z.record(z.string(), z.record(z.string(), z.unknown())),
  }),
});

/**
 * Reads an agent definition from a raw (non-contract-filtered) compose body,
 * so unknown stored keys are visible to the stripped-fields assertion.
 */
function storedComposeAgent(
  body: unknown,
  name: string,
): Record<string, unknown> {
  const agent = storedComposeSchema.parse(body).content.agents[name];
  if (!agent) {
    throw new Error(`Expected stored agent ${name}`);
  }
  return agent;
}

describe("COMPOSE-01 version resolution", () => {
  it("resolves latest tags, full hashes, and unique prefixes across compose versions", async () => {
    const admin = api.user();
    const name = slug("bdd-version");

    const v1 = await api.createCompose(
      admin,
      composeWith(name, { description: "v1" }),
    );
    expect(v1).toMatchObject({ name, action: "created" });

    const v2 = await api.createCompose(
      admin,
      composeWith(name, { description: "v2" }),
    );
    expect(v2.composeId).toBe(v1.composeId);
    expect(v2.versionId).not.toBe(v1.versionId);
    expect(v2.action).toBe("created");

    const reposted = await api.createCompose(
      admin,
      composeWith(name, { description: "v2" }),
    );
    expect(reposted).toMatchObject({
      composeId: v1.composeId,
      versionId: v2.versionId,
      action: "existing",
    });

    const latest = await composes.resolveComposeVersion(admin, {
      composeId: v1.composeId,
      version: "latest",
    });
    expect(latest).toStrictEqual({ versionId: v2.versionId, tag: "latest" });

    const fullHash = await composes.resolveComposeVersion(admin, {
      composeId: v1.composeId,
      version: v1.versionId,
    });
    expect(fullHash).toStrictEqual({ versionId: v1.versionId });

    const prefix = await composes.resolveComposeVersion(admin, {
      composeId: v1.composeId,
      version: v1.versionId.slice(0, 8),
    });
    expect(prefix).toStrictEqual({ versionId: v1.versionId });

    const missingFullHash = await composes.requestResolveComposeVersion(
      admin,
      { composeId: v1.composeId, version: "f".repeat(64) },
      [404],
    );
    expectApiError(missingFullHash.body);
    expect(missingFullHash.body.error.message).toBe(
      "Version 'ffffffff...' not found",
    );

    const missingPrefix = await composes.requestResolveComposeVersion(
      admin,
      { composeId: v1.composeId, version: "deadbeef" },
      [404],
    );
    expectApiError(missingPrefix.body);
    expect(missingPrefix.body.error.message).toBe(
      "Version 'deadbeef' not found",
    );

    const member = api.user({
      orgId: orgIdOf(admin),
      orgRole: "org:member",
    });
    const notOwner = await composes.requestResolveComposeVersion(
      member,
      { composeId: v1.composeId, version: "latest" },
      [404],
    );
    expectApiError(notOwner.body);
    expect(notOwner.body.error.message).toBe("Agent compose not found");

    const shortVersion = await composes.rawRequest(admin, {
      method: "GET",
      path: `/api/agent/composes/versions?composeId=${v1.composeId}&version=abc`,
    });
    expect(shortVersion.status).toBe(400);
    expect(shortVersion.body).toMatchObject({
      error: {
        code: "BAD_REQUEST",
        message: expect.stringContaining("8-64 hex characters"),
      },
    });
  });

  it("rejects ambiguous version prefixes built from colliding compose contents", async () => {
    const admin = api.user();
    const [firstContent, secondContent] = AMBIGUOUS_COMPOSE_CONTENTS;

    // Exact-hash asserts guard canonicalization drift in
    // computeComposeVersionId: if either fails, the collision pair in
    // api-bdd-composes.ts must be recomputed.
    const first = await api.createCompose(admin, firstContent);
    expect(first.name).toBe(AMBIGUOUS_COMPOSE_NAME);
    expect(first.versionId).toBe(AMBIGUOUS_VERSION_IDS[0]);

    const second = await api.createCompose(admin, secondContent);
    expect(second.composeId).toBe(first.composeId);
    expect(second.versionId).toBe(AMBIGUOUS_VERSION_IDS[1]);

    const ambiguous = await composes.requestResolveComposeVersion(
      admin,
      { composeId: first.composeId, version: AMBIGUOUS_VERSION_PREFIX },
      [400],
    );
    expectApiError(ambiguous.body);
    expect(ambiguous.body.error.message).toBe(
      `Ambiguous version prefix '${AMBIGUOUS_VERSION_PREFIX}'. Please use more characters.`,
    );
  });
});

describe("COMPOSE-01 create and metadata validation", () => {
  it("rejects invalid compose payloads through contract and service validation", async () => {
    const admin = api.user();

    const multipleAgents = await api.requestCreateCompose(
      admin,
      {
        version: "1.0",
        agents: {
          "agent-one": { framework: "claude-code" },
          "agent-two": { framework: "claude-code" },
        },
      },
      [400],
    );
    expectApiError(multipleAgents.body);
    expect(multipleAgents.body.error.message).toBe(
      "Multiple agents not supported yet. Only one agent allowed.",
    );

    const invalidName = await api.requestCreateCompose(
      admin,
      { version: "1.0", agents: { ab: { framework: "claude-code" } } },
      [400],
    );
    expectApiError(invalidName.body);
    expect(invalidName.body.error.message).toContain(
      "Invalid agent name format",
    );

    const arrayAgents = await composes.rawRequest(admin, {
      method: "POST",
      path: "/api/agent/composes",
      jsonBody: {
        content: { version: "1.0", agents: [{ framework: "claude-code" }] },
      },
    });
    expect(arrayAgents.status).toBe(400);
    expect(arrayAgents.body).toMatchObject({
      error: {
        code: "BAD_REQUEST",
        message: expect.stringContaining("expected record"),
      },
    });

    const badFramework = await composes.rawRequest(admin, {
      method: "POST",
      path: "/api/agent/composes",
      jsonBody: {
        content: {
          version: "1.0",
          agents: {
            [slug("bdd-bad-framework")]: { framework: "unsupported-framework" },
          },
        },
      },
    });
    expect(badFramework.status).toBe(400);
    expect(badFramework.body).toMatchObject({
      error: {
        code: "BAD_REQUEST",
        message: expect.stringContaining("Invalid option"),
      },
    });
  });

  it("normalizes mixed-case names, strips deprecated fields, and accepts codex frameworks", async () => {
    const admin = api.user();

    const mixedName = `Bdd-Mixed-${shortId()}`;
    const normalized = mixedName.toLowerCase();
    const created = await api.createCompose(admin, composeWith(mixedName));
    expect(created.name).toBe(normalized);
    const byName = await api.readComposeByName(admin, normalized);
    expect(byName.id).toBe(created.composeId);
    expect(byName.content?.agents[normalized]).toBeDefined();
    expect(byName.content?.agents[mixedName]).toBeUndefined();

    const codex = await api.createCompose(
      admin,
      composeWith(slug("bdd-codex"), { framework: "codex" }),
    );
    expect(codex.action).toBe("created");

    // versionId determinism replaces the legacy stored-content DB assert:
    // the decorated re-create normalizes to the clean content, so it reuses
    // the clean create's version instead of creating a new one.
    const strippedName = slug("bdd-strip");
    const clean = await api.createCompose(admin, composeWith(strippedName));
    const decorated = await composes.rawRequest(admin, {
      method: "POST",
      path: "/api/agent/composes",
      jsonBody: {
        content: {
          version: "1.0",
          agents: {
            [strippedName]: {
              framework: "claude-code",
              skills: [
                "https://github.com/example/agent/tree/main/.claude/skills/slack",
              ],
              image: "custom/image:v1",
              working_dir: "/custom/path",
              apps: ["github"],
            },
          },
        },
      },
    });
    expect(decorated.status).toBe(200);
    expect(decorated.body).toMatchObject({
      composeId: clean.composeId,
      versionId: clean.versionId,
      action: "existing",
    });

    const storedRaw = await composes.rawRequest(admin, {
      method: "GET",
      path: `/api/agent/composes/${clean.composeId}`,
    });
    expect(storedRaw.status).toBe(200);
    const storedAgent = storedComposeAgent(storedRaw.body, strippedName);
    expect(Object.keys(storedAgent)).toStrictEqual(["framework"]);
  });

  it("updates compose metadata through partial patches with visible list reads", async () => {
    const admin = api.user();
    const created = await api.createCompose(
      admin,
      composeWith(slug("bdd-meta")),
    );
    await api.updateComposeMetadata(admin, created.composeId, {
      displayName: "Initial Name",
      description: "Initial description",
      sound: "calm",
    });

    const invalidBody = await composes.rawRequest(admin, {
      method: "PATCH",
      path: `/api/agent/composes/${created.composeId}/metadata`,
      jsonBody: { displayName: 12_345 },
    });
    expect(invalidBody.status).toBe(400);
    expect(invalidBody.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });

    const noOrg = api.user({ orgId: null });
    const noOrgPatch = await composes.requestUpdateComposeMetadata(
      noOrg,
      created.composeId,
      { displayName: "No Org" },
      [400],
    );
    expectApiError(noOrgPatch.body);
    expect(noOrgPatch.body.error.message).toBe(
      "Explicit org context required — ensure active org in session",
    );

    const missing = await composes.requestUpdateComposeMetadata(
      admin,
      randomUUID(),
      { displayName: "Missing" },
      [404],
    );
    expectApiError(missing.body);
    expect(missing.body.error.message).toBe("Agent compose not found");

    const outsider = api.user();
    const crossOrg = await composes.requestUpdateComposeMetadata(
      outsider,
      created.composeId,
      { displayName: "Cross Org" },
      [404],
    );
    expectApiError(crossOrg.body);
    expect(crossOrg.body.error.code).toBe("NOT_FOUND");

    const member = api.user({
      orgId: orgIdOf(admin),
      orgRole: "org:member",
    });
    await composes.requestUpdateComposeMetadata(
      member,
      created.composeId,
      { displayName: "Member Updated" },
      [200],
    );
    const listed = await api.listComposes(admin);
    expect(
      listed.find((compose) => {
        return compose.id === created.composeId;
      }),
    ).toMatchObject({
      displayName: "Member Updated",
      description: "Initial description",
      sound: "calm",
    });
  });

  it("returns visible read errors for missing names, org-less lists, and invalid queries", async () => {
    const admin = api.user();
    const missingName = slug("bdd-missing");

    const notFoundByName = await composes.requestReadComposeByName(
      admin,
      missingName,
      [404],
    );
    expectApiError(notFoundByName.body);
    expect(notFoundByName.body.error.message).toBe(
      `Agent compose not found: ${missingName}`,
    );

    const noOrg = api.user({ orgId: null });
    const noOrgList = await composes.requestListComposes(noOrg, [400]);
    expect(noOrgList.body).toStrictEqual({
      error: { message: "Invalid request", code: "BAD_REQUEST" },
    });

    const missingQuery = await composes.rawRequest(admin, {
      method: "GET",
      path: "/api/agent/composes",
    });
    expect(missingQuery.status).toBe(400);
    expect(missingQuery.body).toMatchObject({
      error: {
        code: "BAD_REQUEST",
        message: expect.stringContaining("expected string"),
      },
    });
  });
});

describe("COMPOSE-01 instructions", () => {
  it("serves canonical defaults and storage-backed instructions across actors", async () => {
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", "test-bucket");
    const admin = api.user();
    storages.mockStoragePresignedUrls();
    storages.mockStorageObjectsExist();

    const plainName = slug("bdd-instr-a");
    const plain = await api.createCompose(admin, composeWith(plainName));
    const canonical = await composes.readComposeInstructions(
      admin,
      plain.composeId,
    );
    expect(canonical).toStrictEqual({ content: null, filename: "CLAUDE.md" });

    const explicitName = slug("bdd-instr-b");
    const explicit = await api.createCompose(
      admin,
      composeWith(explicitName, { instructions: "AGENTS.md" }),
    );
    const storageAbsent = await composes.readComposeInstructions(
      admin,
      explicit.composeId,
    );
    expect(storageAbsent).toStrictEqual({
      content: null,
      filename: "AGENTS.md",
    });

    // The instructions volume is created through the public storages API
    // (recipe: storages.bdd.test.ts volume prepare/commit); only the S3
    // download boundary is mocked for the read-back.
    const storageName = getInstructionsStorageName(explicitName);
    const instructionsFile = storageTextFile(
      "CLAUDE.md",
      "# Shared Instructions",
    );
    const prepared = await storages.prepareStorage(admin, {
      storageName,
      storageType: "volume",
      files: [instructionsFile],
    });
    await storages.commitStorage(admin, {
      storageName,
      storageType: "volume",
      versionId: prepared.versionId,
      files: [instructionsFile],
    });

    mockComposeInstructionsDownloads(context, {
      storageName,
      filename: "CLAUDE.md",
      manifestPath: "./CLAUDE.md",
      content: "# Shared Instructions",
    });

    const member = api.user({
      orgId: orgIdOf(admin),
      orgRole: "org:member",
    });
    const memberRead = await composes.readComposeInstructions(
      member,
      explicit.composeId,
    );
    expect(memberRead).toStrictEqual({
      content: "# Shared Instructions",
      filename: "AGENTS.md",
    });

    // Sandbox tokens minted for another org still read instructions: the
    // route resolves the org from the compose itself.
    const foreignSandbox = {
      bearer: sandboxComposeToken({
        userId: `user_${randomUUID()}`,
        orgId: `org_${randomUUID()}`,
      }),
    };
    const sandboxRead = await composes.readComposeInstructions(
      foreignSandbox,
      explicit.composeId,
    );
    expect(sandboxRead).toStrictEqual({
      content: "# Shared Instructions",
      filename: "AGENTS.md",
    });

    const outsider = api.user();
    const crossOrg = await composes.requestReadComposeInstructions(
      outsider,
      explicit.composeId,
      [404],
    );
    expectApiError(crossOrg.body);
    expect(crossOrg.body.error.message).toBe("Agent compose not found");

    const noOrg = api.user({ orgId: null });
    const noOrgRead = await composes.requestReadComposeInstructions(
      noOrg,
      explicit.composeId,
      [404],
    );
    expectApiError(noOrgRead.body);
    expect(noOrgRead.body.error.message).toBe("Agent compose not found");

    const unauthenticated = await composes.requestReadComposeInstructions(
      null,
      explicit.composeId,
      [401],
    );
    expect(unauthenticated.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    const missing = await composes.requestReadComposeInstructions(
      admin,
      randomUUID(),
      [404],
    );
    expectApiError(missing.body);
    expect(missing.body.error.message).toBe("Agent compose not found");

    const malformed = await composes.rawRequest(admin, {
      method: "GET",
      path: "/api/agent/composes/91fc0bd84bba673393d9adfc1a0f4dec/instructions",
    });
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
  });
});

describe("COMPOSE-01 token access", () => {
  it("scopes sandbox and zero tokens across compose routes", async () => {
    const admin = api.user();
    const adminOrgId = orgIdOf(admin);
    const sandbox = {
      bearer: sandboxComposeToken({
        userId: admin.userId,
        orgId: adminOrgId,
      }),
    };

    const name = slug("bdd-sandbox");
    const created = await composes.requestCreateCompose(
      sandbox,
      composeWith(name),
      [201],
    );
    expect(created.body).toMatchObject({ name, action: "created" });
    const composeId = created.body.composeId;

    const byName = await composes.requestReadComposeByName(
      sandbox,
      name,
      [200],
    );
    expect(byName.body.id).toBe(composeId);

    const listed = await composes.requestListComposes(sandbox, [200]);
    expect(
      listed.body.composes.some((compose) => {
        return compose.id === composeId;
      }),
    ).toBeTruthy();

    const resolved = await composes.requestResolveComposeVersion(
      sandbox,
      { composeId, version: "latest" },
      [200],
    );
    expect(resolved.body).toStrictEqual({
      versionId: created.body.versionId,
      tag: "latest",
    });

    await composes.requestUpdateComposeMetadata(
      sandbox,
      composeId,
      { displayName: "Sandbox Updated" },
      [200],
    );
    const adminListed = await api.listComposes(admin);
    expect(
      adminListed.find((compose) => {
        return compose.id === composeId;
      }),
    ).toMatchObject({ displayName: "Sandbox Updated" });

    const instructions = await composes.requestReadComposeInstructions(
      sandbox,
      composeId,
      [200],
    );
    expect(instructions.body).toStrictEqual({
      content: null,
      filename: "CLAUDE.md",
    });

    const sandboxDelete = await composes.requestDeleteCompose(
      sandbox,
      composeId,
      [403],
    );
    expect(sandboxDelete.body).toStrictEqual({
      error: {
        message: "Agent deletion is not available from sandbox",
        code: "FORBIDDEN",
      },
    });

    const foreignSandbox = {
      bearer: sandboxComposeToken({
        userId: `user_${randomUUID()}`,
        orgId: `org_${randomUUID()}`,
      }),
    };
    const foreignRead = await composes.requestReadComposeById(
      foreignSandbox,
      composeId,
      [200],
    );
    expect(foreignRead.body.id).toBe(composeId);

    mockClerkMembership(context, admin, "org:admin");
    const zeroToken = {
      bearer: zeroComposeDeleteToken({
        userId: admin.userId,
        orgId: adminOrgId,
      }),
    };
    const zeroDelete = await composes.requestDeleteCompose(
      zeroToken,
      composeId,
      [403],
    );
    expect(zeroDelete.body).toStrictEqual({
      error: {
        message: "Agent deletion is not available from sandbox",
        code: "FORBIDDEN",
      },
    });

    const freshSandbox = {
      bearer: sandboxComposeToken({
        userId: `user_${randomUUID()}`,
        orgId: `org_${randomUUID()}`,
      }),
    };
    const zeroList = await composes.requestListZeroComposes(
      freshSandbox,
      [200],
    );
    expect(zeroList.body).toStrictEqual({ composes: [] });
  });

  it("rejects unauthenticated requests across compose route families", async () => {
    const unauthenticatedBody = {
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    };
    const missingId = randomUUID();

    const create = await api.requestCreateCompose(
      null,
      composeWith(slug("bdd-unauth")),
      [401],
    );
    expect(create.body).toStrictEqual(unauthenticatedBody);

    const byName = await composes.requestReadComposeByName(
      null,
      "missing",
      [401],
    );
    expect(byName.body).toStrictEqual(unauthenticatedBody);

    const byId = await api.requestReadComposeById(null, missingId, [401]);
    expect(byId.body).toStrictEqual(unauthenticatedBody);

    const list = await composes.requestListComposes(null, [401]);
    expect(list.body).toStrictEqual(unauthenticatedBody);

    const versions = await composes.requestResolveComposeVersion(
      null,
      { composeId: missingId, version: "latest" },
      [401],
    );
    expect(versions.body).toStrictEqual(unauthenticatedBody);

    const instructions = await composes.requestReadComposeInstructions(
      null,
      missingId,
      [401],
    );
    expect(instructions.body).toStrictEqual(unauthenticatedBody);

    const metadata = await composes.requestUpdateComposeMetadata(
      null,
      missingId,
      { displayName: "Unauthenticated" },
      [401],
    );
    expect(metadata.body).toStrictEqual(unauthenticatedBody);

    const composeDelete = await composes.requestDeleteCompose(
      null,
      missingId,
      [401],
    );
    expect(composeDelete.body).toStrictEqual(unauthenticatedBody);

    const zeroByName = await composes.requestReadZeroComposeByName(
      null,
      "missing",
      [401],
    );
    expect(zeroByName.body).toStrictEqual(unauthenticatedBody);

    const zeroById = await api.requestReadZeroComposeById(
      null,
      missingId,
      [401],
    );
    expect(zeroById.body).toStrictEqual(unauthenticatedBody);

    const zeroList = await composes.requestListZeroComposes(null, [401]);
    expect(zeroList.body).toStrictEqual(unauthenticatedBody);

    const zeroMetadata = await composes.requestUpdateZeroComposeMetadata(
      null,
      missingId,
      { displayName: "Unauthenticated" },
      [401],
    );
    expect(zeroMetadata.body).toStrictEqual(unauthenticatedBody);

    const zeroDelete = await composes.requestDeleteZeroCompose(
      null,
      missingId,
      [401],
    );
    expect(zeroDelete.body).toStrictEqual(unauthenticatedBody);
  });
});

describe("COMPOSE-01 zero route errors", () => {
  it("returns zero-route errors for missing, org-less, and cross-org compose access", async () => {
    const admin = api.user();
    const name = slug("bdd-zero-errors");
    const created = await api.createCompose(admin, composeWith(name));
    await api.updateZeroComposeMetadata(admin, created.composeId, {
      displayName: "Zero Initial",
      description: "Zero description",
      sound: "quiet",
    });

    const missingName = slug("bdd-zero-missing");
    const byNameMiss = await composes.requestReadZeroComposeByName(
      admin,
      missingName,
      [404],
    );
    expectApiError(byNameMiss.body);
    expect(byNameMiss.body.error.message).toBe(
      `Agent compose not found: ${missingName}`,
    );

    const noOrg = api.user({ orgId: null });
    const noOrgByName = await composes.requestReadZeroComposeByName(
      noOrg,
      name,
      [401],
    );
    expect(noOrgByName.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    const noOrgList = await composes.requestListZeroComposes(noOrg, [400]);
    expect(noOrgList.body).toStrictEqual({
      error: { message: "Invalid request", code: "BAD_REQUEST" },
    });

    const missingMetadata = await composes.requestUpdateZeroComposeMetadata(
      admin,
      randomUUID(),
      { displayName: "Missing" },
      [404],
    );
    expectApiError(missingMetadata.body);
    expect(missingMetadata.body.error.message).toBe("Agent compose not found");

    const noOrgMetadata = await composes.requestUpdateZeroComposeMetadata(
      noOrg,
      created.composeId,
      { displayName: "No Org" },
      [401],
    );
    expect(noOrgMetadata.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    const outsider = api.user();
    const crossOrgMetadata = await composes.requestUpdateZeroComposeMetadata(
      outsider,
      created.composeId,
      { displayName: "Cross Org" },
      [404],
    );
    expectApiError(crossOrgMetadata.body);
    expect(crossOrgMetadata.body.error.code).toBe("NOT_FOUND");

    const missingDelete = await composes.requestDeleteZeroCompose(
      admin,
      randomUUID(),
      [404],
    );
    expectApiError(missingDelete.body);
    expect(missingDelete.body.error.message).toBe("Agent not found");

    const member = api.user({
      orgId: orgIdOf(admin),
      orgRole: "org:member",
    });
    const memberDelete = await composes.requestDeleteZeroCompose(
      member,
      created.composeId,
      [404],
    );
    expectApiError(memberDelete.body);
    expect(memberDelete.body.error.message).toBe("Agent not found");

    // Owner state stayed intact through every rejected mutation above.
    const survivors = await api.listZeroComposes(admin);
    expect(
      survivors.find((compose) => {
        return compose.id === created.composeId;
      }),
    ).toMatchObject({
      displayName: "Zero Initial",
      description: "Zero description",
      sound: "quiet",
    });
  });
});

describe("COMPOSE-01 delete protection and volume sweep", () => {
  it("blocks deletion while a run is pending and sweeps the instructions volume after", async () => {
    const runs = createRunsSchedulesApi(context);
    const actor = api.user();
    api.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", "test-bucket");

    const name = slug("bdd-protected");
    const compose = await api.createCompose(
      actor,
      composeWith(name, {
        environment: { ANTHROPIC_API_KEY: "bdd-inline-key" },
      }),
    );

    storages.mockStoragePresignedUrls();
    const instructionsName = getInstructionsStorageName(name);
    const instructionsFile = storageTextFile(
      "CLAUDE.md",
      "# Protected instructions",
    );
    const preparedInstructions = await storages.prepareStorage(actor, {
      storageName: instructionsName,
      storageType: "volume",
      files: [instructionsFile],
    });
    await storages.commitStorage(actor, {
      storageName: instructionsName,
      storageType: "volume",
      versionId: preparedInstructions.versionId,
      files: [instructionsFile],
    });

    const unrelatedName = slug("bdd-unrelated-volume");
    const unrelatedFile = storageTextFile("data/cache.bin", "unrelated volume");
    const preparedUnrelated = await storages.prepareStorage(actor, {
      storageName: unrelatedName,
      storageType: "volume",
      files: [unrelatedFile],
    });
    await storages.commitStorage(actor, {
      storageName: unrelatedName,
      storageType: "volume",
      versionId: preparedUnrelated.versionId,
      files: [unrelatedFile],
    });

    // The pending direct run is never claimed and is cancelled right after
    // the 409 asserts; it stays inside the 15-minute pending-run TTL.
    const run = await runs.createDirectRun(actor, {
      agentComposeId: compose.composeId,
      prompt: "hold the compose with a pending run",
    });

    const conflictBody = {
      error: {
        message: "Cannot delete agent: agent is currently running",
        code: "CONFLICT",
      },
    };
    const agentConflict = await composes.requestDeleteCompose(
      actor,
      compose.composeId,
      [409],
    );
    expect(agentConflict.body).toStrictEqual(conflictBody);

    const zeroConflict = await composes.requestDeleteZeroCompose(
      actor,
      compose.composeId,
      [409],
    );
    expect(zeroConflict.body).toStrictEqual(conflictBody);

    const survivor = await api.readComposeById(actor, compose.composeId);
    expect(survivor.id).toBe(compose.composeId);

    await runs.requestCancelRun(actor, run.runId, [200]);
    const cancelled = await runs.readRun(actor, run.runId);
    expect(cancelled.status).toBe("cancelled");

    const sweepPrefix = `${orgIdOf(actor)}/volume/${instructionsName}`;
    composes.mockStorageSweepObjects([
      {
        bucket: "test-bucket",
        key: `${sweepPrefix}/v1/archive.tar.gz`,
        size: 1024,
      },
      {
        bucket: "test-bucket",
        key: `${sweepPrefix}/v1/manifest.json`,
        size: 256,
      },
    ]);

    await composes.requestDeleteCompose(actor, compose.composeId, [204]);

    const deleted = await api.requestReadComposeById(
      actor,
      compose.composeId,
      [404],
    );
    expectApiError(deleted.body);
    expect(deleted.body.error.code).toBe("NOT_FOUND");

    const volumes = await storages.listStorages(actor, "volume");
    expect(
      volumes.some((volume) => {
        return volume.name === instructionsName;
      }),
    ).toBeFalsy();
    expect(
      volumes.some((volume) => {
        return volume.name === unrelatedName;
      }),
    ).toBeTruthy();

    expect(composes.s3DeletedObjectKeys()).toStrictEqual([
      `${sweepPrefix}/v1/archive.tar.gz`,
      `${sweepPrefix}/v1/manifest.json`,
    ]);
  });

  it("deletes volume-less composes cleanly and hides foreign composes from deletion", async () => {
    const owner = api.user();
    const created = await api.createCompose(
      owner,
      composeWith(slug("bdd-plain-delete")),
    );
    await composes.requestDeleteCompose(owner, created.composeId, [204]);
    const gone = await api.requestReadComposeById(
      owner,
      created.composeId,
      [404],
    );
    expectApiError(gone.body);
    expect(context.mocks.s3.send).not.toHaveBeenCalled();

    const unknown = await composes.requestDeleteCompose(
      owner,
      randomUUID(),
      [404],
    );
    expectApiError(unknown.body);
    expect(unknown.body.error.message).toBe("Agent not found");

    const kept = await api.createCompose(owner, composeWith(slug("bdd-kept")));
    const member = api.user({
      orgId: orgIdOf(owner),
      orgRole: "org:member",
    });
    const memberDelete = await composes.requestDeleteCompose(
      member,
      kept.composeId,
      [404],
    );
    expectApiError(memberDelete.body);
    expect(memberDelete.body.error.message).toBe("Agent not found");

    const listed = await api.listComposes(owner);
    expect(
      listed.some((compose) => {
        return compose.id === kept.composeId;
      }),
    ).toBeTruthy();
  });
});
