import { randomUUID } from "node:crypto";

import { command, createStore } from "ccstate";
import {
  agentComposeApiContentSchema,
  composesMainContract,
} from "@vm0/api-contracts/contracts/composes";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import { describe, expect, it } from "vitest";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function storedContent(versionId: string): Promise<unknown> {
  const db = store.set(writeDb$);
  const [row] = await db
    .select({ content: agentComposeVersions.content })
    .from(agentComposeVersions)
    .where(eq(agentComposeVersions.id, versionId))
    .limit(1);

  if (!row) {
    throw new Error(`Expected stored compose version ${versionId}`);
  }
  return row.content;
}

function storedAgent(content: unknown, name: string): Record<string, unknown> {
  if (!isRecord(content) || !isRecord(content.agents)) {
    throw new Error("Expected compose content with agents object");
  }

  const agent = content.agents[name];
  if (!isRecord(agent)) {
    throw new Error(`Expected stored agent ${name}`);
  }
  return agent;
}

describe("POST /api/agent/composes", () => {
  it("returns 401 when unauthenticated", async () => {
    const response = await accept(
      client().create({
        body: { content: composeContent("unauth-agent") },
        headers: {},
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("creates a new compose", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    await trackOrg(orgId);
    mocks.clerk.session(userId, orgId);
    const name = agentName("create-agent");

    const response = await accept(
      client().create({
        body: { content: composeContent(name) },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [201],
    );

    expect(response.body).toMatchObject({
      name,
      action: "created",
    });
    expect(response.body.composeId).toStrictEqual(expect.any(String));
    expect(response.body.versionId).toMatch(/^[a-f0-9]{64}$/);
    expect(response.body.updatedAt).toStrictEqual(expect.any(String));
  });

  it("normalizes mixed-case agent names before persisting", async () => {
    const orgId = `org_${randomUUID()}`;
    await trackOrg(orgId);
    mocks.clerk.session(`user_${randomUUID()}`, orgId);

    const response = await accept(
      client().create({
        body: {
          content: composeContent("My-Researcher", {
            framework: "claude-code",
            instructions: "AGENTS.md",
          }),
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [201],
    );

    expect(response.body.name).toBe("my-researcher");
    const content = await storedContent(response.body.versionId);
    if (!isRecord(content) || !isRecord(content.agents)) {
      throw new Error("Expected stored compose content with agents object");
    }
    expect(content.agents["my-researcher"]).toBeDefined();
    expect(content.agents["My-Researcher"]).toBeUndefined();
  });

  it("strips deprecated and unknown agent fields from persisted content", async () => {
    const orgId = `org_${randomUUID()}`;
    await trackOrg(orgId);
    mocks.clerk.session(`user_${randomUUID()}`, orgId);
    const name = agentName("strip-fields");
    const agentWithExtraFields = {
      framework: "claude-code",
      skills: [
        "https://github.com/example/agent/tree/main/.claude/skills/slack",
      ],
      image: "custom/image:v1",
      working_dir: "/custom/path",
      apps: ["github"],
    } satisfies AgentDefinition & {
      readonly image: string;
      readonly working_dir: string;
      readonly apps: readonly string[];
    };

    const response = await accept(
      client().create({
        body: {
          content: composeContent(name, agentWithExtraFields),
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [201],
    );

    const agent = storedAgent(
      await storedContent(response.body.versionId),
      name,
    );
    expect(agent.framework).toBe("claude-code");
    expect(agent.skills).toBeUndefined();
    expect(agent.image).toBeUndefined();
    expect(agent.working_dir).toBeUndefined();
    expect(agent.apps).toBeUndefined();
  });

  it("updates an existing compose by normalized name", async () => {
    const orgId = `org_${randomUUID()}`;
    await trackOrg(orgId);
    mocks.clerk.session(`user_${randomUUID()}`, orgId);
    const name = agentName("update-agent");

    const first = await accept(
      client().create({
        body: {
          content: composeContent(name, {
            framework: "claude-code",
            description: "Initial description",
          }),
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [201],
    );

    const second = await accept(
      client().create({
        body: {
          content: composeContent(name, {
            framework: "claude-code",
            description: "Updated description",
          }),
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(second.body.composeId).toBe(first.body.composeId);
    expect(second.body.versionId).not.toBe(first.body.versionId);
    expect(second.body.action).toBe("created");
    const agent = storedAgent(await storedContent(second.body.versionId), name);
    expect(agent.description).toBe("Updated description");
  });

  it("reuses an existing version for identical normalized content", async () => {
    const orgId = `org_${randomUUID()}`;
    await trackOrg(orgId);
    mocks.clerk.session(`user_${randomUUID()}`, orgId);
    const name = agentName("existing-version");

    const first = await accept(
      client().create({
        body: { content: composeContent(name) },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [201],
    );
    const second = await accept(
      client().create({
        body: { content: composeContent(name) },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(second.body.composeId).toBe(first.body.composeId);
    expect(second.body.versionId).toBe(first.body.versionId);
    expect(second.body.action).toBe("existing");
  });

  it("allows the same compose name in different orgs", async () => {
    const firstOrgId = `org_${randomUUID()}`;
    const secondOrgId = `org_${randomUUID()}`;
    await trackOrg(firstOrgId);
    await trackOrg(secondOrgId);
    const name = agentName("shared-name");

    mocks.clerk.session(`user_${randomUUID()}`, firstOrgId);
    const first = await accept(
      client().create({
        body: { content: composeContent(name) },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [201],
    );

    mocks.clerk.session(`user_${randomUUID()}`, secondOrgId);
    const second = await accept(
      client().create({
        body: { content: composeContent(name) },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [201],
    );

    expect(second.body.composeId).not.toBe(first.body.composeId);
    expect(second.body.versionId).toBe(first.body.versionId);
  });

  it("rejects empty, multiple, and invalid agent names", async () => {
    const orgId = `org_${randomUUID()}`;
    await trackOrg(orgId);
    mocks.clerk.session(`user_${randomUUID()}`, orgId);

    const empty = await accept(
      client().create({
        body: { content: { version: "1.0", agents: {} } },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    expect(empty.body.error.message).toBe(
      "agents must have at least one agent defined",
    );

    const multiple = await accept(
      client().create({
        body: {
          content: {
            version: "1.0",
            agents: {
              "agent-one": { framework: "claude-code" },
              "agent-two": { framework: "claude-code" },
            },
          },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    expect(multiple.body.error.message).toBe(
      "Multiple agents not supported yet. Only one agent allowed.",
    );

    const invalid = await accept(
      client().create({
        body: { content: composeContent("ab") },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    expect(invalid.body.error.message).toContain("Invalid agent name format");
  });

  it("rejects array agents during request validation", async () => {
    const orgId = `org_${randomUUID()}`;
    await trackOrg(orgId);
    mocks.clerk.session(`user_${randomUUID()}`, orgId);
    const app = createApp({ signal: context.signal });

    const response = await app.request("/api/agent/composes", {
      method: "POST",
      headers: {
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        content: {
          version: "1.0",
          agents: [{ framework: "claude-code" }],
        },
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      readonly error: { readonly message: string; readonly code: string };
    };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("content.agents");
    expect(body.error.message).toContain("expected record");
  });

  it("accepts claude-code and codex frameworks", async () => {
    const orgId = `org_${randomUUID()}`;
    await trackOrg(orgId);
    mocks.clerk.session(`user_${randomUUID()}`, orgId);

    const claudeCode = await accept(
      client().create({
        body: { content: composeContent(agentName("claude-code-agent")) },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [201],
    );
    const codex = await accept(
      client().create({
        body: {
          content: composeContent(agentName("codex-agent"), {
            framework: "codex",
          }),
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [201],
    );

    expect(claudeCode.body.action).toBe("created");
    expect(codex.body.action).toBe("created");
  });

  it("rejects unsupported frameworks through request validation", async () => {
    const orgId = `org_${randomUUID()}`;
    await trackOrg(orgId);
    mocks.clerk.session(`user_${randomUUID()}`, orgId);
    const app = createApp({ signal: context.signal });

    const response = await app.request("/api/agent/composes", {
      method: "POST",
      headers: {
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
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

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      readonly error: { readonly message: string; readonly code: string };
    };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("Invalid option");
  });

  it("accepts sandbox tokens", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    await trackOrg(orgId);
    const name = agentName("sandbox-agent");

    const response = await accept(
      client().create({
        body: { content: composeContent(name) },
        headers: {
          authorization: `Bearer ${sandboxToken({ userId, orgId })}`,
        },
      }),
      [201],
    );

    expect(response.body.name).toBe(name);
    expect(response.body.action).toBe("created");
  });
});
