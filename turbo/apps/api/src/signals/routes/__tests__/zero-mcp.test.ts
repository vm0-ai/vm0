import { randomUUID } from "node:crypto";

import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import {
  MCP_AGENT_GRANT_MAX_SERVERS,
  MCP_AGENT_GRANT_MAX_TOOL_NAMES,
  MCP_TOOL_NAME_MAX_LENGTH,
  type CreateMcpServerBody,
  type McpServerResponse,
  type ReplaceMcpAgentGrantsBody,
  zeroAgentMcpGrantsContract,
  zeroMcpServerByRefContract,
  zeroMcpServersContract,
} from "@vm0/api-contracts/contracts/zero-mcp";

import { createAppWithRoutes } from "../../../app-factory-core";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { zeroMcpRoutes } from "../zero-mcp";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const bdd = createBddApi(context);
const runs = createRunsApi(context);
const mocks = createZeroRouteMocks(context);

interface AuthHeaders {
  readonly authorization?: string;
}

function authenticate(actor: ApiTestUser | null): AuthHeaders {
  if (!actor) {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    return {};
  }
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}

function serversClient() {
  return setupApp({ context })(zeroMcpServersContract);
}

function serverByRefClient() {
  return setupApp({ context })(zeroMcpServerByRefContract);
}

function agentGrantsClient() {
  return setupApp({ context })(zeroAgentMcpGrantsContract);
}

function defaultServerInput(
  overrides: Partial<CreateMcpServerBody> = {},
): CreateMcpServerBody {
  const ref = overrides.ref ?? `server-${randomUUID()}`;
  return {
    ref,
    displayName: overrides.displayName ?? `Server ${ref}`,
    endpoint: overrides.endpoint ?? `https://${ref}.example.com/mcp`,
    enabled: overrides.enabled ?? true,
  };
}

async function createServer(
  actor: ApiTestUser,
  input: CreateMcpServerBody = defaultServerInput(),
): Promise<McpServerResponse> {
  const response = await accept(
    serversClient().create({
      headers: authenticate(actor),
      body: input,
    }),
    [201],
  );
  return response.body;
}

async function createAgent(actor: ApiTestUser) {
  bdd.acceptAgentStorageWrites();
  return await bdd.createAgent(actor, { displayName: "MCP Agent" });
}

function zeroTokenFor(
  actor: ApiTestUser,
  capabilities: readonly ZeroCapability[],
): string {
  if (!actor.orgId) {
    throw new Error("Expected an organization-scoped actor");
  }
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "zero",
    userId: actor.userId,
    orgId: actor.orgId,
    runId: randomUUID(),
    capabilities,
    iat: seconds,
    exp: seconds + 60,
  });
}

function sandboxTokenFor(actor: ApiTestUser): string {
  if (!actor.orgId) {
    throw new Error("Expected an organization-scoped actor");
  }
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "sandbox",
    userId: actor.userId,
    orgId: actor.orgId,
    runId: randomUUID(),
    iat: seconds,
    exp: seconds + 60,
  });
}

async function apiKeyHeaders(
  actor: ApiTestUser,
  role: "org:admin" | "org:member",
): Promise<{ readonly authorization: string }> {
  const key = await runs.createCliToken(actor);
  mockClerkMembership(context, actor, role);
  return { authorization: `Bearer ${key.token}` };
}

describe("MCP server management", () => {
  it("accepts session and PAT management auth but rejects sandbox credentials", async () => {
    const unauthenticated = await accept(
      serversClient().list({ headers: authenticate(null) }),
      [401],
    );
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const noOrg = bdd.user({ orgId: null });
    const missingOrganization = await accept(
      serversClient().list({ headers: authenticate(noOrg) }),
      [401],
    );
    expect(missingOrganization.body.error.code).toBe("UNAUTHORIZED");

    const actor = bdd.user();
    const patResponse = await accept(
      serversClient().list({
        headers: await apiKeyHeaders(actor, "org:admin"),
      }),
      [200],
    );
    expect(patResponse.body.servers).toStrictEqual([]);

    for (const token of [
      zeroTokenFor(actor, ["mcp:read", "mcp:write"]),
      sandboxTokenFor(actor),
    ]) {
      const response = await accept(
        serversClient().list({
          headers: { authorization: `Bearer ${token}` },
        }),
        [401, 403],
      );
      expect([401, 403]).toContain(response.status);
    }
  });

  it("lets members read safe organization state while only admins mutate it", async () => {
    const admin = bdd.user();
    const member = bdd.user({
      orgId: admin.orgId,
      orgRole: "org:member",
    });
    const otherAdmin = bdd.user();
    const input = defaultServerInput({
      ref: "docs",
      displayName: "  Documentation  ",
      endpoint: " HTTPS://MCP.EXAMPLE.COM.:443/mcp ",
      enabled: false,
    });

    const created = await createServer(admin, input);
    expect(created).toMatchObject({
      ref: "docs",
      displayName: "Documentation",
      endpoint: "https://mcp.example.com/mcp",
      enabled: false,
    });
    expect(created).not.toHaveProperty("id");
    expect(created).not.toHaveProperty("orgId");

    const memberList = await accept(
      serversClient().list({ headers: authenticate(member) }),
      [200],
    );
    expect(memberList.body.servers).toStrictEqual([created]);

    const otherOrgList = await accept(
      serversClient().list({ headers: authenticate(otherAdmin) }),
      [200],
    );
    expect(otherOrgList.body.servers).toStrictEqual([]);

    const memberCreate = await accept(
      serversClient().create({
        headers: authenticate(member),
        body: defaultServerInput({ ref: "member-create" }),
      }),
      [403],
    );
    expect(memberCreate.body.error.code).toBe("FORBIDDEN");

    const memberPatch = await accept(
      serverByRefClient().patch({
        params: { ref: created.ref },
        headers: authenticate(member),
        body: { enabled: true },
      }),
      [403],
    );
    expect(memberPatch.body.error.code).toBe("FORBIDDEN");

    const patched = await accept(
      serverByRefClient().patch({
        params: { ref: created.ref },
        headers: authenticate(admin),
        body: { displayName: "Docs", enabled: true },
      }),
      [200],
    );
    expect(patched.body).toMatchObject({
      ref: created.ref,
      displayName: "Docs",
      endpoint: created.endpoint,
      enabled: true,
    });

    const foreignPatch = await accept(
      serverByRefClient().patch({
        params: { ref: created.ref },
        headers: authenticate(otherAdmin),
        body: { enabled: false },
      }),
      [404],
    );
    expect(foreignPatch.body.error.code).toBe("NOT_FOUND");

    const duplicate = await accept(
      serversClient().create({
        headers: authenticate(admin),
        body: defaultServerInput({ ref: created.ref }),
      }),
      [409],
    );
    expect(duplicate.body.error.code).toBe("CONFLICT");

    const memberDelete = await accept(
      serverByRefClient().delete({
        params: { ref: created.ref },
        headers: authenticate(member),
      }),
      [403],
    );
    expect(memberDelete.body.error.code).toBe("FORBIDDEN");
  });

  it("rejects immutable patch fields at the route boundary", async () => {
    const admin = bdd.user();
    const server = await createServer(
      admin,
      defaultServerInput({ ref: "immutable" }),
    );
    const app = createAppWithRoutes({
      signal: context.signal,
      routes: zeroMcpRoutes,
    });

    const response = await app.request(`/api/zero/mcp/servers/${server.ref}`, {
      method: "PATCH",
      headers: {
        ...authenticate(admin),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        displayName: "Changed",
        endpoint: "https://replacement.example.com/mcp",
      }),
    });
    expect(response.status).toBe(400);

    const listed = await accept(
      serversClient().list({ headers: authenticate(admin) }),
      [200],
    );
    expect(listed.body.servers).toStrictEqual([server]);
  });

  it("requires an explicit initial enabled state", async () => {
    const admin = bdd.user();
    const app = createAppWithRoutes({
      signal: context.signal,
      routes: zeroMcpRoutes,
    });

    const response = await app.request("/api/zero/mcp/servers", {
      method: "POST",
      headers: {
        ...authenticate(admin),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ref: "missing-enabled",
        displayName: "Missing enabled",
        endpoint: "https://mcp.example.com/mcp",
      }),
    });
    expect(response.status).toBe(400);

    const listed = await accept(
      serversClient().list({ headers: authenticate(admin) }),
      [200],
    );
    expect(listed.body.servers).toStrictEqual([]);
  });

  it.each([
    "not a URL",
    "http://mcp.example.com/mcp",
    "file:///tmp/server",
    "https://user:password@mcp.example.com/mcp",
    "https://mcp.example.com/mcp?token=secret",
    "https://mcp.example.com/mcp?",
    "https://mcp.example.com/mcp#section",
    "https://mcp.example.com/mcp#",
    "https://localhost/mcp",
    "https://service/mcp",
    "https://10.0.0.1/mcp",
    "https://[::1]/mcp",
  ])("rejects unsupported endpoint %s", async (endpoint) => {
    const admin = bdd.user();
    const response = await accept(
      serversClient().create({
        headers: authenticate(admin),
        body: defaultServerInput({ endpoint }),
      }),
      [400],
    );
    expect(response.body.error.code).toBe("BAD_REQUEST");
  });
});

describe("MCP agent grants", () => {
  it("atomically replaces exact and wildcard grants and supports clearing", async () => {
    const owner = bdd.user();
    const agent = await createAgent(owner);
    await createServer(
      owner,
      defaultServerInput({ ref: "alpha", enabled: true }),
    );
    await createServer(
      owner,
      defaultServerInput({ ref: "beta", enabled: false }),
    );

    const empty = await accept(
      agentGrantsClient().get({
        params: { id: agent.agentId },
        headers: authenticate(owner),
      }),
      [200],
    );
    expect(empty.body.grants).toStrictEqual([]);

    const replaced = await accept(
      agentGrantsClient().replace({
        params: { id: agent.agentId },
        headers: authenticate(owner),
        body: {
          grants: [
            { serverRef: "beta", toolPolicy: { kind: "all" } },
            {
              serverRef: "alpha",
              toolPolicy: {
                kind: "exact",
                toolNames: ["Search", "search", " spaced "],
              },
            },
          ],
        },
      }),
      [200],
    );
    expect(replaced.body.grants).toStrictEqual([
      {
        serverRef: "alpha",
        toolPolicy: {
          kind: "exact",
          toolNames: ["Search", "search", " spaced "],
        },
      },
      { serverRef: "beta", toolPolicy: { kind: "all" } },
    ]);

    const exactOnly = await accept(
      agentGrantsClient().replace({
        params: { id: agent.agentId },
        headers: authenticate(owner),
        body: {
          grants: [
            {
              serverRef: "beta",
              toolPolicy: { kind: "exact", toolNames: ["lookup"] },
            },
          ],
        },
      }),
      [200],
    );
    expect(exactOnly.body.grants).toStrictEqual([
      {
        serverRef: "beta",
        toolPolicy: { kind: "exact", toolNames: ["lookup"] },
      },
    ]);

    const cleared = await accept(
      agentGrantsClient().replace({
        params: { id: agent.agentId },
        headers: authenticate(owner),
        body: { grants: [] },
      }),
      [200],
    );
    expect(cleared.body.grants).toStrictEqual([]);
  });

  it("limits grants to owned agents and same-organization servers", async () => {
    const owner = bdd.user();
    const member = bdd.user({
      orgId: owner.orgId,
      orgRole: "org:member",
    });
    const otherAdmin = bdd.user();
    const agent = await createAgent(owner);
    await createServer(
      otherAdmin,
      defaultServerInput({ ref: "other-org-server" }),
    );

    const nonOwnerRead = await accept(
      agentGrantsClient().get({
        params: { id: agent.agentId },
        headers: authenticate(member),
      }),
      [404],
    );
    expect(nonOwnerRead.body.error.code).toBe("NOT_FOUND");

    const nonOwnerWrite = await accept(
      agentGrantsClient().replace({
        params: { id: agent.agentId },
        headers: authenticate(member),
        body: { grants: [] },
      }),
      [404],
    );
    expect(nonOwnerWrite.body.error.code).toBe("NOT_FOUND");

    const missingAgentWrite = await accept(
      agentGrantsClient().replace({
        params: { id: randomUUID() },
        headers: authenticate(owner),
        body: { grants: [] },
      }),
      [404],
    );
    expect(missingAgentWrite.body.error.code).toBe("NOT_FOUND");

    const crossOrgServer = await accept(
      agentGrantsClient().replace({
        params: { id: agent.agentId },
        headers: authenticate(owner),
        body: {
          grants: [
            {
              serverRef: "other-org-server",
              toolPolicy: { kind: "all" },
            },
          ],
        },
      }),
      [400],
    );
    expect(crossOrgServer.body.error).toMatchObject({
      code: "BAD_REQUEST",
      message: "Unknown MCP server refs: other-org-server",
    });
  });

  it("leaves the previous grant set intact when replacement references an unknown server", async () => {
    const owner = bdd.user();
    const agent = await createAgent(owner);
    await createServer(owner, defaultServerInput({ ref: "known" }));

    await accept(
      agentGrantsClient().replace({
        params: { id: agent.agentId },
        headers: authenticate(owner),
        body: {
          grants: [
            {
              serverRef: "known",
              toolPolicy: { kind: "exact", toolNames: ["search"] },
            },
          ],
        },
      }),
      [200],
    );

    await accept(
      agentGrantsClient().replace({
        params: { id: agent.agentId },
        headers: authenticate(owner),
        body: {
          grants: [
            {
              serverRef: "missing",
              toolPolicy: { kind: "all" },
            },
          ],
        },
      }),
      [400],
    );

    const current = await accept(
      agentGrantsClient().get({
        params: { id: agent.agentId },
        headers: authenticate(owner),
      }),
      [200],
    );
    expect(current.body.grants).toStrictEqual([
      {
        serverRef: "known",
        toolPolicy: { kind: "exact", toolNames: ["search"] },
      },
    ]);
  });

  it("rejects duplicate, empty, count, and encoded-size policy violations", async () => {
    const owner = bdd.user();
    const agent = await createAgent(owner);
    await createServer(owner, defaultServerInput({ ref: "validation" }));
    for (let index = 0; index < MCP_AGENT_GRANT_MAX_SERVERS; index += 1) {
      await createServer(owner, defaultServerInput({ ref: `large-${index}` }));
    }

    const invalidBodies: readonly ReplaceMcpAgentGrantsBody[] = [
      {
        grants: [
          {
            serverRef: "validation",
            toolPolicy: { kind: "exact", toolNames: ["same", "same"] },
          },
        ],
      },
      {
        grants: [
          {
            serverRef: "validation",
            toolPolicy: { kind: "exact", toolNames: ["   "] },
          },
        ],
      },
      {
        grants: [
          {
            serverRef: "validation",
            toolPolicy: {
              kind: "exact",
              toolNames: ["x".repeat(MCP_TOOL_NAME_MAX_LENGTH + 1)],
            },
          },
        ],
      },
      {
        grants: [
          { serverRef: "validation", toolPolicy: { kind: "all" } },
          { serverRef: "validation", toolPolicy: { kind: "all" } },
        ],
      },
      {
        grants: Array.from(
          { length: MCP_AGENT_GRANT_MAX_SERVERS + 1 },
          (_, index) => {
            return {
              serverRef: `server-${index}`,
              toolPolicy: { kind: "all" as const },
            };
          },
        ),
      },
      {
        grants: [
          {
            serverRef: "validation",
            toolPolicy: {
              kind: "exact",
              toolNames: Array.from(
                { length: MCP_AGENT_GRANT_MAX_TOOL_NAMES + 1 },
                (_, index) => {
                  return `tool-${index}`;
                },
              ),
            },
          },
        ],
      },
      {
        grants: Array.from(
          { length: MCP_AGENT_GRANT_MAX_SERVERS },
          (_, serverIndex) => {
            return {
              serverRef: `large-${serverIndex}`,
              toolPolicy: {
                kind: "exact" as const,
                toolNames: Array.from(
                  { length: MCP_AGENT_GRANT_MAX_TOOL_NAMES },
                  (_, toolIndex) => {
                    const prefix = `${serverIndex}-${toolIndex}-`;
                    return `${prefix}${"x".repeat(
                      MCP_TOOL_NAME_MAX_LENGTH - prefix.length,
                    )}`;
                  },
                ),
              },
            };
          },
        ),
      },
    ];

    for (const body of invalidBodies) {
      const response = await accept(
        agentGrantsClient().replace({
          params: { id: agent.agentId },
          headers: authenticate(owner),
          body,
        }),
        [400],
      );
      expect(response.body.error.code).toBe("BAD_REQUEST");
    }
  });

  it("deleting and recreating a server ref cannot inherit an old grant", async () => {
    const owner = bdd.user();
    const agent = await createAgent(owner);
    await createServer(owner, defaultServerInput({ ref: "replaceable" }));
    await accept(
      agentGrantsClient().replace({
        params: { id: agent.agentId },
        headers: authenticate(owner),
        body: {
          grants: [{ serverRef: "replaceable", toolPolicy: { kind: "all" } }],
        },
      }),
      [200],
    );

    await accept(
      serverByRefClient().delete({
        params: { ref: "replaceable" },
        headers: authenticate(owner),
      }),
      [204],
    );
    await createServer(
      owner,
      defaultServerInput({
        ref: "replaceable",
        endpoint: "https://replacement.example.com/mcp",
      }),
    );

    const grants = await accept(
      agentGrantsClient().get({
        params: { id: agent.agentId },
        headers: authenticate(owner),
      }),
      [200],
    );
    expect(grants.body.grants).toStrictEqual([]);
  });
});
