import { randomUUID } from "node:crypto";

import {
  zeroModelProviderConnectionsByIdContract,
  zeroModelProviderConnectionsMainContract,
  type CreateModelProviderConnectionRequest,
} from "@vm0/api-contracts/contracts/zero-model-provider-gateways";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function useSession(role: "org:admin" | "org:member" = "org:admin") {
  const orgId = `org_gateway_${randomUUID()}`;
  const userId = `user_gateway_${randomUUID()}`;
  mocks.clerk.session(userId, orgId, role);
  return { orgId, userId };
}

function mainClient() {
  return setupApp({ context })(zeroModelProviderConnectionsMainContract);
}

function byIdClient() {
  return setupApp({ context })(zeroModelProviderConnectionsByIdContract);
}

describe("custom model provider gateway routes", () => {
  it("requires authentication and admin access for mutations", async () => {
    const unauthenticated = await accept(
      mainClient().create({
        headers: {},
        body: {
          displayName: "Gateway",
          secret: "secret",
          surfaces: [
            {
              protocol: "anthropic-messages",
              apiBaseUrl: "https://gateway.example.com",
              authHeaderName: "Authorization",
              authHeaderTemplate: "Bearer {{secret}}",
              modelMappings: {},
            },
          ],
        },
      }),
      [401],
    );
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    useSession("org:member");
    const forbidden = await accept(
      mainClient().create({
        headers: authHeaders(),
        body: {
          displayName: "Gateway",
          secret: "secret",
          surfaces: [
            {
              protocol: "anthropic-messages",
              apiBaseUrl: "https://gateway.example.com",
              authHeaderName: "Authorization",
              authHeaderTemplate: "Bearer {{secret}}",
              modelMappings: {},
            },
          ],
        },
      }),
      [403],
    );
    expect(forbidden.body.error.code).toBe("FORBIDDEN");
    const forbiddenList = await accept(
      mainClient().list({ headers: authHeaders() }),
      [403],
    );
    expect(forbiddenList.body.error.code).toBe("FORBIDDEN");
  });

  it("creates, normalizes, updates, lists, and deletes a connection", async () => {
    useSession();
    const created = await accept(
      mainClient().create({
        headers: authHeaders(),
        body: {
          displayName: "Company Gateway",
          secret: "top-secret",
          surfaces: [
            {
              protocol: "anthropic-messages",
              apiBaseUrl: "https://gateway.example.com/anthropic/v1/messages/",
              authHeaderName: "Authorization",
              authHeaderTemplate: "Bearer {{secret}}",
              modelMappings: {
                "claude-sonnet-4-6": "company-sonnet",
              },
            },
            {
              protocol: "openai-responses",
              apiBaseUrl: "https://gateway.example.com/openai/v1/responses/",
              authHeaderName: "x-api-key",
              authHeaderTemplate: "{{secret}}",
              modelMappings: {
                "gpt-5.5": "company-codex",
              },
            },
          ],
        },
      }),
      [201],
    );

    expect(created.body).not.toHaveProperty("secret");
    expect(created.body.displayName).toBe("Company Gateway");
    expect(created.body.surfaces).toHaveLength(2);
    expect(created.body.surfaces).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          protocol: "anthropic-messages",
          apiBaseUrl: "https://gateway.example.com/anthropic",
        }),
        expect.objectContaining({
          protocol: "openai-responses",
          apiBaseUrl: "https://gateway.example.com/openai/v1",
        }),
      ]),
    );

    const messages = created.body.surfaces.find((surface) => {
      return surface.protocol === "anthropic-messages";
    });
    if (!messages) {
      throw new Error("Expected Messages surface");
    }
    const updated = await accept(
      byIdClient().update({
        headers: authHeaders(),
        params: { id: created.body.id },
        body: {
          displayName: "Renamed Gateway",
          surfaces: [
            {
              protocol: "anthropic-messages",
              apiBaseUrl: "https://gateway.example.com/new-anthropic",
              authHeaderName: "Authorization",
              authHeaderTemplate: "Bearer {{secret}}",
              modelMappings: {
                "claude-sonnet-4-6": "company-sonnet-v2",
              },
            },
          ],
        },
      }),
      [200],
    );

    expect(updated.body.displayName).toBe("Renamed Gateway");
    expect(updated.body.surfaces).toHaveLength(1);
    expect(updated.body.surfaces[0]).toMatchObject({
      id: messages.id,
      protocol: "anthropic-messages",
      apiBaseUrl: "https://gateway.example.com/new-anthropic",
    });

    const listed = await accept(
      mainClient().list({ headers: authHeaders() }),
      [200],
    );
    expect(listed.body.connections).toStrictEqual([
      expect.objectContaining({ id: created.body.id }),
    ]);

    await accept(
      byIdClient().delete({
        headers: authHeaders(),
        params: { id: created.body.id },
      }),
      [204],
    );
    const afterDelete = await accept(
      mainClient().list({ headers: authHeaders() }),
      [200],
    );
    expect(afterDelete.body.connections).toStrictEqual([]);
  });

  it.each([
    {
      name: "non-HTTPS base URL",
      surface: {
        protocol: "anthropic-messages" as const,
        apiBaseUrl: "http://gateway.example.com",
        authHeaderName: "Authorization",
        authHeaderTemplate: "Bearer {{secret}}",
        modelMappings: {} as Record<string, string>,
      },
    },
    {
      name: "protected auth header",
      surface: {
        protocol: "anthropic-messages" as const,
        apiBaseUrl: "https://gateway.example.com",
        authHeaderName: "Host",
        authHeaderTemplate: "{{secret}}",
        modelMappings: {} as Record<string, string>,
      },
    },
    {
      name: "missing secret placeholder",
      surface: {
        protocol: "anthropic-messages" as const,
        apiBaseUrl: "https://gateway.example.com",
        authHeaderName: "Authorization",
        authHeaderTemplate: "Bearer static",
        modelMappings: {} as Record<string, string>,
      },
    },
    {
      name: "incompatible model mapping",
      surface: {
        protocol: "anthropic-messages" as const,
        apiBaseUrl: "https://gateway.example.com",
        authHeaderName: "Authorization",
        authHeaderTemplate: "Bearer {{secret}}",
        modelMappings: { "gpt-5.5": "openai/gpt-5.5" },
      },
    },
  ] satisfies readonly {
    name: string;
    surface: CreateModelProviderConnectionRequest["surfaces"][number];
  }[])("rejects $name", async ({ surface }) => {
    useSession();
    const response = await accept(
      mainClient().create({
        headers: authHeaders(),
        body: {
          displayName: "Invalid Gateway",
          secret: "secret",
          surfaces: [surface],
        },
      }),
      [400],
    );
    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("compiles a mapped gateway into the runner environment and inline firewall", async () => {
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Expected an organization-scoped actor");
    }
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const runnerGroup = runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "Custom gateway runtime",
      visibility: "private",
    });
    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");

    const created = await accept(
      mainClient().create({
        headers: authHeaders(),
        body: {
          displayName: "Runtime Gateway",
          secret: "runtime-gateway-secret",
          surfaces: [
            {
              protocol: "anthropic-messages",
              apiBaseUrl: "https://gateway.example.com/anthropic",
              authHeaderName: "Authorization",
              authHeaderTemplate: "Bearer {{secret}}",
              modelMappings: {
                "claude-sonnet-4-6": "company-sonnet-production",
              },
            },
            {
              protocol: "openai-responses",
              apiBaseUrl: "https://gateway.example.com/openai/v1",
              authHeaderName: "x-api-key",
              authHeaderTemplate: "{{secret}}",
              modelMappings: {
                "gpt-5.5": "company-gpt-production",
              },
            },
          ],
        },
      }),
      [201],
    );
    const messagesSurface = created.body.surfaces.find((surface) => {
      return surface.protocol === "anthropic-messages";
    });
    const responsesSurface = created.body.surfaces.find((surface) => {
      return surface.protocol === "openai-responses";
    });
    if (!messagesSurface || !responsesSurface) {
      throw new Error("Expected both custom gateway surfaces");
    }
    await runs.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-4-6",
        isDefault: true,
        defaultProviderType: "vercel-ai-gateway",
        credentialScope: "org",
        modelProviderId: null,
        modelProviderSurfaceId: messagesSurface.id,
      },
    ]);

    const run = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "exercise the custom gateway",
    });
    await runs.heartbeatRunner(runnerGroup);
    const claim = await runs.claimRunnerJob(run.runId);

    expect(claim.cliAgentType).toBe("claude-code");
    expect(claim.environment).toMatchObject({
      ANTHROPIC_BASE_URL: "https://gateway.example.com/anthropic",
      ANTHROPIC_MODEL: "company-sonnet-production",
    });
    const firewallName = `model-provider-surface:${messagesSurface.id}`;
    const firewall = claim.firewalls?.find((entry) => {
      return entry.kind === "inline" && entry.firewall.name === firewallName;
    });
    expect(firewall).toMatchObject({
      kind: "inline",
      firewall: {
        name: firewallName,
        apis: [
          {
            base: "https://gateway.example.com/anthropic/v1/messages",
            hostPolicy: { kind: "publicDestination" },
            auth: {
              headers: {
                Authorization: `Bearer \${{ secrets.VM0_MODEL_PROVIDER_API_KEY }}`,
              },
            },
          },
        ],
      },
    });
    expect(claim.secretValues).not.toContain("runtime-gateway-secret");

    await runs.requestCancelRun(actor, run.runId, [200]);

    await runs.updateOrgModelPolicies(actor, [
      {
        model: "gpt-5.5",
        isDefault: true,
        defaultProviderType: "vercel-ai-gateway-codex",
        credentialScope: "org",
        modelProviderId: null,
        modelProviderSurfaceId: responsesSurface.id,
      },
    ]);
    const codexRun = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "exercise the custom Responses gateway",
    });
    await runs.heartbeatRunner(runnerGroup);
    const codexClaim = await runs.claimRunnerJob(codexRun.runId);

    expect(codexClaim.cliAgentType).toBe("codex");
    expect(codexClaim.environment).toMatchObject({
      OPENAI_BASE_URL: "https://gateway.example.com/openai/v1",
      OPENAI_MODEL: "company-gpt-production",
    });
    expect(codexClaim.codexRuntimeConfig).toMatchObject({
      providerId: `gateway_${responsesSurface.id.replaceAll("-", "")}`,
      baseUrl: "https://gateway.example.com/openai/v1",
      envKey: "OPENAI_API_KEY",
      httpHeaders: {
        "x-api-key": "__VM0_OPENAI_API_KEY_PLACEHOLDER__",
      },
      requiresOpenaiAuth: false,
      wireApi: "responses",
    });
    const responsesFirewallName = `model-provider-surface:${responsesSurface.id}`;
    expect(
      codexClaim.firewalls?.find((entry) => {
        return (
          entry.kind === "inline" &&
          entry.firewall.name === responsesFirewallName
        );
      }),
    ).toMatchObject({
      kind: "inline",
      firewall: {
        name: responsesFirewallName,
        apis: [
          {
            base: "https://gateway.example.com/openai/v1",
            auth: {
              headers: {
                "x-api-key": `\${{ secrets.VM0_MODEL_PROVIDER_API_KEY }}`,
              },
            },
          },
        ],
      },
    });
    expect(codexClaim.secretValues).not.toContain("runtime-gateway-secret");

    await runs.requestCancelRun(actor, codexRun.runId, [200]);
  });
});
