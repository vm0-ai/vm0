import { randomUUID } from "node:crypto";

import { command, createStore } from "ccstate";
import {
  agentComposeApiContentSchema,
  composesMainContract,
} from "@vm0/api-contracts/contracts/composes";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { eq } from "drizzle-orm";
import type { z } from "zod";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

type AgentComposeApiContent = z.infer<typeof agentComposeApiContentSchema>;
type AgentDefinition = AgentComposeApiContent["agents"][string];

// BDD migration of the legacy `agent-composes-create.test.ts`.
// The 11 legacy `it()`s collapse into 4 BDD `it()`s: (1) auth
// + create + update chain, (2) content normalization + version
// reuse chain, (3) org isolation + body validation chain, (4)
// framework acceptance + sandbox token chain. The legacy
// "stored content" assertions are read back through the
// `composesByNameContract.getByName` GET — same content, same
// hash, surfaced through the public read surface.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const deleteCreatedComposesForOrg$ = command(
  async ({ set }, orgId: string, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    await db.delete(agentComposes).where(eq(agentComposes.orgId, orgId));
    signal.throwIfAborted();
  },
);

const trackOrgFixture = createFixtureTracker<string>((orgId) => {
  return store.set(deleteCreatedComposesForOrg$, orgId, context.signal);
});

async function trackOrg(orgId: string): Promise<void> {
  await trackOrgFixture(Promise.resolve(orgId));
}

function client() {
  return setupApp({ context })(composesMainContract);
}

function agentName(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function composeContent(
  name: string,
  agent: AgentDefinition = { framework: "claude-code" },
): AgentComposeApiContent {
  return {
    version: "1.0",
    agents: {
      [name]: agent,
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

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

describe("BDD POST /api/agent/composes — auth + create/update chain", () => {
  it("gwt-wt-wt: 401 unauthenticated → 201 creates a new compose → 200 update by normalized name creates a new version", async () => {
    const c = client();

    // When + Then: 401.
    const unauth = await accept(
      c.create({
        body: { content: composeContent("unauth-agent") },
        headers: {},
      }),
      [401],
    );
    expect(unauth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: an authenticated session.
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    await trackOrg(orgId);
    mocks.clerk.session(userId, orgId);
    const name = agentName("create-agent");

    // When + Then: 201 with the name + versionId + action.
    const first = await accept(
      c.create({
        body: { content: composeContent(name) },
        headers: authHeaders(),
      }),
      [201],
    );
    expect(first.body).toMatchObject({ name, action: "created" });
    expect(first.body.composeId).toStrictEqual(expect.any(String));
    expect(first.body.versionId).toMatch(/^[a-f0-9]{64}$/);
    expect(first.body.updatedAt).toStrictEqual(expect.any(String));

    // When + Then: a second create with the same name updates
    // the same compose (same `composeId`) but creates a new
    // `versionId` because the content differs.
    const second = await accept(
      c.create({
        body: {
          content: composeContent(name, {
            framework: "claude-code",
            description: "Updated description",
          }),
        },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(second.body.composeId).toBe(first.body.composeId);
    expect(second.body.versionId).not.toBe(first.body.versionId);
    expect(second.body.action).toBe("created");

    // When + Then: reading the compose by name returns the
    // updated description (proving the new version is the
    // head).
    const readBack = await accept(
      client().getByName({
        query: { name },
        headers: authHeaders(),
      }),
      [200],
    );
    const agent = readBack.body.content?.agents[name];
    expect(agent).toMatchObject({ description: "Updated description" });
  });
});

describe("BDD POST /api/agent/composes — content normalization chain", () => {
  it("gwt-wt-wt: 201 normalizes mixed-case agent names → 201 strips unknown fields → 200 reuses existing version for identical content", async () => {
    const c = client();

    // Given: an authenticated session.
    const orgId = `org_${randomUUID()}`;
    await trackOrg(orgId);
    mocks.clerk.session(`user_${randomUUID()}`, orgId);

    // When + Then: a mixed-case name is normalized to
    // lowercase in the response name + persisted content.
    const mixedCase = await accept(
      c.create({
        body: {
          content: composeContent("My-Researcher", {
            framework: "claude-code",
            instructions: "AGENTS.md",
          }),
        },
        headers: authHeaders(),
      }),
      [201],
    );
    expect(mixedCase.body.name).toBe("my-researcher");
    const mixedCaseReadBack = await accept(
      client().getByName({
        query: { name: "my-researcher" },
        headers: authHeaders(),
      }),
      [200],
    );
    const mixedCaseAgents = mixedCaseReadBack.body.content?.agents;
    expect(mixedCaseAgents?.["my-researcher"]).toBeDefined();
    expect(mixedCaseAgents?.["My-Researcher"]).toBeUndefined();

    // Given: a fresh org; the agent body carries deprecated
    // fields (`skills`, `image`, `working_dir`, `apps`).
    const stripOrgId = `org_${randomUUID()}`;
    await trackOrg(stripOrgId);
    mocks.clerk.session(`user_${randomUUID()}`, stripOrgId);
    const stripName = agentName("strip-fields");
    const stripResponse = await accept(
      c.create({
        body: {
          content: composeContent(stripName, {
            framework: "claude-code",
            skills: [
              "https://github.com/example/agent/tree/main/.claude/skills/slack",
            ],
            image: "custom/image:v1",
            working_dir: "/custom/path",
            apps: ["github"],
          } as AgentDefinition & {
            readonly image: string;
            readonly working_dir: string;
            readonly apps: readonly string[];
          }),
        },
        headers: authHeaders(),
      }),
      [201],
    );

    // When + Then: the deprecated fields are stripped from the
    // persisted content (verified via the public read).
    const stripReadBack = await accept(
      client().getByName({
        query: { name: stripName },
        headers: authHeaders(),
      }),
      [200],
    );
    const stripAgent = stripReadBack.body.content?.agents[stripName] as
      | (Record<string, unknown> & { framework: string })
      | undefined;
    expect(stripAgent?.framework).toBe("claude-code");
    expect(stripAgent?.skills).toBeUndefined();
    expect(stripAgent?.image).toBeUndefined();
    expect(stripAgent?.working_dir).toBeUndefined();
    expect(stripAgent?.apps).toBeUndefined();
    // Silence the unused-binding lint: the stripResponse is
    // captured as the post-write contract assertion.
    expect(stripResponse.body.action).toBe("created");

    // Given: a fresh org; the same name + same content is
    // created twice.
    const reuseOrgId = `org_${randomUUID()}`;
    await trackOrg(reuseOrgId);
    mocks.clerk.session(`user_${randomUUID()}`, reuseOrgId);
    const reuseName = agentName("existing-version");
    const firstReuse = await accept(
      c.create({
        body: { content: composeContent(reuseName) },
        headers: authHeaders(),
      }),
      [201],
    );
    const secondReuse = await accept(
      c.create({
        body: { content: composeContent(reuseName) },
        headers: authHeaders(),
      }),
      [200],
    );

    // When + Then: the second create reuses the same
    // `versionId` (identical normalized content) and reports
    // `action: "existing"`.
    expect(secondReuse.body.composeId).toBe(firstReuse.body.composeId);
    expect(secondReuse.body.versionId).toBe(firstReuse.body.versionId);
    expect(secondReuse.body.action).toBe("existing");
  });
});

describe("BDD POST /api/agent/composes — org isolation + body validation chain", () => {
  it("gwt-wt-wt: 201 same name in different orgs (different compose, same versionId hash) → 400 empty agents → 400 multiple agents → 400 invalid name → 400 array agents (raw HTTP) → 400 unsupported framework (raw HTTP)", async () => {
    const c = client();
    const app = createApp({ signal: context.signal });

    // Given: two orgs that share the same agent name.
    const firstOrgId = `org_${randomUUID()}`;
    const secondOrgId = `org_${randomUUID()}`;
    await trackOrg(firstOrgId);
    await trackOrg(secondOrgId);
    const sharedName = agentName("shared-name");

    mocks.clerk.session(`user_${randomUUID()}`, firstOrgId);
    const first = await accept(
      c.create({
        body: { content: composeContent(sharedName) },
        headers: authHeaders(),
      }),
      [201],
    );

    mocks.clerk.session(`user_${randomUUID()}`, secondOrgId);

    // When + Then: the second org's compose has a different
    // `composeId` (org isolation) but reuses the same
    // `versionId` (identical content).
    const second = await accept(
      c.create({
        body: { content: composeContent(sharedName) },
        headers: authHeaders(),
      }),
      [201],
    );
    expect(second.body.composeId).not.toBe(first.body.composeId);
    expect(second.body.versionId).toBe(first.body.versionId);

    // Given: a fresh authenticated session.
    const validationOrgId = `org_${randomUUID()}`;
    await trackOrg(validationOrgId);
    mocks.clerk.session(`user_${randomUUID()}`, validationOrgId);

    // When + Then: 400 for an empty agents object.
    const empty = await accept(
      c.create({
        body: { content: { version: "1.0", agents: {} } },
        headers: authHeaders(),
      }),
      [400],
    );
    expect(empty.body.error.message).toBe(
      "agents must have at least one agent defined",
    );

    // When + Then: 400 for multiple agents.
    const multiple = await accept(
      c.create({
        body: {
          content: {
            version: "1.0",
            agents: {
              "agent-one": { framework: "claude-code" },
              "agent-two": { framework: "claude-code" },
            },
          },
        },
        headers: authHeaders(),
      }),
      [400],
    );
    expect(multiple.body.error.message).toBe(
      "Multiple agents not supported yet. Only one agent allowed.",
    );

    // When + Then: 400 for a too-short agent name.
    const invalid = await accept(
      c.create({
        body: { content: composeContent("ab") },
        headers: authHeaders(),
      }),
      [400],
    );
    expect(invalid.body.error.message).toContain("Invalid agent name format");

    // When + Then: 400 for `agents` as an array (the ts-rest
    // client would re-shape this client-side, so go through
    // the public app directly).
    const arrayAgents = await app.request("/api/agent/composes", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        content: {
          version: "1.0",
          agents: [{ framework: "claude-code" }],
        },
      }),
    });
    expect(arrayAgents.status).toBe(400);
    const arrayAgentsBody = (await arrayAgents.json()) as {
      readonly error: { readonly message: string; readonly code: string };
    };
    expect(arrayAgentsBody.error.code).toBe("BAD_REQUEST");
    expect(arrayAgentsBody.error.message).toContain("content.agents");
    expect(arrayAgentsBody.error.message).toContain("expected record");

    // When + Then: 400 for an unsupported framework (raw HTTP,
    // ts-rest client would block the enum client-side).
    const badFramework = await app.request("/api/agent/composes", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        content: {
          version: "1.0",
          agents: {
            [agentName("bad-framework")]: {
              framework: "unsupported-framework",
            },
          },
        },
      }),
    });
    expect(badFramework.status).toBe(400);
    const badFrameworkBody = (await badFramework.json()) as {
      readonly error: { readonly message: string; readonly code: string };
    };
    expect(badFrameworkBody.error.code).toBe("BAD_REQUEST");
    expect(badFrameworkBody.error.message).toContain("Invalid option");
  });
});

describe("BDD POST /api/agent/composes — framework + sandbox chain", () => {
  it("gwt-wt-wt: 201 claude-code framework → 201 codex framework → 201 sandbox token accepted", async () => {
    const c = client();

    // Given: an authenticated session.
    const orgId = `org_${randomUUID()}`;
    await trackOrg(orgId);
    mocks.clerk.session(`user_${randomUUID()}`, orgId);

    // When + Then: 201 for the claude-code framework.
    const claudeCode = await accept(
      c.create({
        body: { content: composeContent(agentName("claude-code-agent")) },
        headers: authHeaders(),
      }),
      [201],
    );
    expect(claudeCode.body.action).toBe("created");

    // When + Then: 201 for the codex framework.
    const codex = await accept(
      c.create({
        body: {
          content: composeContent(agentName("codex-agent"), {
            framework: "codex",
          }),
        },
        headers: authHeaders(),
      }),
      [201],
    );
    expect(codex.body.action).toBe("created");

    // Given: a sandbox JWT scoped to a fresh user/org.
    const sandboxOrgId = `org_${randomUUID()}`;
    const sandboxUserId = `user_${randomUUID()}`;
    await trackOrg(sandboxOrgId);
    const sandboxName = agentName("sandbox-agent");

    // When + Then: 201 for a sandbox token.
    const sandboxResponse = await accept(
      c.create({
        body: { content: composeContent(sandboxName) },
        headers: {
          authorization: `Bearer ${sandboxToken({
            userId: sandboxUserId,
            orgId: sandboxOrgId,
          })}`,
        },
      }),
      [201],
    );
    expect(sandboxResponse.body.name).toBe(sandboxName);
    expect(sandboxResponse.body.action).toBe("created");
  });
});
