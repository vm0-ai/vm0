import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { expectApiError } from "./helpers/api-bdd";
import {
  createAuthOrgAgentsBddApi,
  type ApiTestUser,
} from "./helpers/api-bdd-auth-org";
import {
  AMBIGUOUS_COMPOSE_CONTENTS,
  AMBIGUOUS_COMPOSE_NAME,
  AMBIGUOUS_VERSION_IDS,
  AMBIGUOUS_VERSION_PREFIX,
  createComposesBddApi,
} from "./helpers/api-bdd-composes";

/*
 * The legacy agent-compose routes are retired. These tests cover the compose
 * services still used by product write paths and the remaining Zero list
 * surface without constructing state through an E2E-only route.
 *
 * - Version ids are sha256 hashes of canonical compose content, so the
 *   ambiguous-prefix 400 is API-constructible from the precomputed
 *   collision pair in api-bdd-composes.ts (unlike storage versions, where
 *   the same arm is recorded as a docs exception).
 * - The following arm is unreachable through public APIs:
 *   agent-composes-read.service `agentComposeVersionResolution` no-head 400
 *   ("Agent compose has no versions...") — every public write path sets a
 *   head version.
 */

const context = testContext();
const api = createAuthOrgAgentsBddApi(context);
const composes = createComposesBddApi(context);

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
  it("rejects invalid compose payloads through service validation", async () => {
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
  });

  it("normalizes mixed-case names and accepts codex frameworks", async () => {
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
  });

  it("returns a visible service read error for a missing name", async () => {
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
  });
});

describe("COMPOSE-01 zero route errors", () => {
  it("rejects unauthenticated Zero list requests", async () => {
    const unauthenticatedBody = {
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    };
    const zeroList = await composes.requestListZeroComposes(null, [401]);
    expect(zeroList.body).toStrictEqual(unauthenticatedBody);
  });

  it("returns zero-list errors for org-less compose access", async () => {
    const noOrg = api.user({ orgId: null });
    const noOrgList = await composes.requestListZeroComposes(noOrg, [400]);
    expect(noOrgList.body).toStrictEqual({
      error: { message: "Invalid request", code: "BAD_REQUEST" },
    });
  });
});
