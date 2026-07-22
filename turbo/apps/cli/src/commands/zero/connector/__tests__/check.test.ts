import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import type {
  ConnectorCheckDiagnosticResult,
  ConnectorCheckPolicy,
  ConnectorCheckRequest,
} from "@vm0/api-contracts/contracts/zero-connector-check";
import chalk from "chalk";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../../mocks/server";
import { checkConnectorCommand } from "../check";

const API_BASE_URL = "https://app.vm0.ai";
const AGENT_ID = "00000000-0000-4000-8000-000000000001";

type ResolvedDiagnostic = Extract<
  ConnectorCheckDiagnosticResult,
  { readonly outcome: "resolved" }
>;
type ResolvedUrlDiagnostic = Extract<
  ResolvedDiagnostic,
  { readonly mode: "url" }
>;
type ResolvedEnvironmentDiagnostic = Extract<
  ResolvedDiagnostic,
  { readonly mode: "environment" }
>;
type ConnectorIdentity = ResolvedDiagnostic["connector"];
type ConnectorRun = ResolvedDiagnostic["run"];

function buildZeroToken(
  overrides: Partial<{
    readonly userId: string;
    readonly runId: string;
    readonly orgId: string;
    readonly scope: string;
    readonly capabilities: string[];
  }> = {},
): string {
  const payload = {
    userId: "user-1",
    runId: "run-abc-123",
    orgId: "org-1",
    scope: "zero",
    capabilities: ["connector:read", "agent-run:read"],
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `vm0_sandbox_${header}.${body}.test-signature`;
}

function connectorIdentity(
  overrides: Partial<ConnectorIdentity> = {},
): ConnectorIdentity {
  return {
    connectorRef: "github",
    label: "GitHub",
    visibility: "available",
    credentialResolution: "network-boundary",
    ...overrides,
  };
}

function resolvedEnvironment(
  options: {
    readonly connector?: ConnectorIdentity;
    readonly environmentName?: string;
    readonly run?: ConnectorRun;
    readonly permission?: ConnectorCheckPolicy | null;
  } = {},
): ResolvedEnvironmentDiagnostic {
  return {
    outcome: "resolved",
    mode: "environment",
    connector: options.connector ?? connectorIdentity(),
    environmentName: options.environmentName ?? "GH_TOKEN",
    run: options.run ?? {
      status: "configured",
      bases: ["https://api.github.com", "https://uploads.github.com"],
    },
    permission: options.permission ?? null,
  };
}

function resolvedUrl(
  options: {
    readonly connector?: ConnectorIdentity;
    readonly environmentNames?: string[] | null;
    readonly run?: ConnectorRun;
    readonly method?: string;
    readonly base?: string;
    readonly relativePath?: string;
    readonly permission?: ResolvedUrlDiagnostic["permission"];
  } = {},
): ResolvedUrlDiagnostic {
  return {
    outcome: "resolved",
    mode: "url",
    connector: options.connector ?? connectorIdentity(),
    environmentNames:
      options.environmentNames === undefined
        ? ["GITHUB_TOKEN"]
        : options.environmentNames,
    run: options.run ?? {
      status: "configured",
      bases: ["https://api.github.com", "https://uploads.github.com"],
    },
    method: options.method ?? "GET",
    base: options.base ?? "https://api.github.com",
    relativePath: options.relativePath ?? "/repos/vm0-ai/vm0",
    permission: options.permission ?? {
      kind: "matched",
      permissions: [
        {
          name: "contents:read",
          policy: { outcome: "allow", basis: "allow-list" },
        },
      ],
    },
  };
}

function connectorResponse(
  connectorRef: string,
  connectionStatus: ConnectorResponse["connectionStatus"] = "connected",
): ConnectorResponse {
  return {
    id: "00000000-0000-4000-8000-000000000002",
    type: connectorRef,
    authMethod: "oauth",
    externalId: "external-1",
    externalUsername: "user",
    externalEmail: "user@example.com",
    oauthScopes: ["repo"],
    connectionStatus,
    reconnectReason:
      connectionStatus === "reconnect-required"
        ? "authorization_expired_or_revoked"
        : null,
    tokenExpiresAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function diagnosticEndpoint(baseUrl = API_BASE_URL): string {
  return `${baseUrl}/api/zero/connectors/diagnostics/check`;
}

function stubDiagnostic(
  result: ConnectorCheckDiagnosticResult,
  onRequest?: (body: unknown) => void,
  baseUrl = API_BASE_URL,
): void {
  server.use(
    http.post(diagnosticEndpoint(baseUrl), async ({ request }) => {
      const body: unknown = await request.json();
      onRequest?.(body);
      return HttpResponse.json(result);
    }),
  );
}

function stubConnector(
  connectorRef: string,
  response: ConnectorResponse | null = connectorResponse(connectorRef),
  onRequest?: () => void,
  baseUrl = API_BASE_URL,
): void {
  server.use(
    http.get(`${baseUrl}/api/zero/connectors/${connectorRef}`, () => {
      onRequest?.();
      if (response === null) {
        return HttpResponse.json(
          { error: { message: "Not found", code: "NOT_FOUND" } },
          { status: 404 },
        );
      }
      return HttpResponse.json(response);
    }),
  );
}

function stubAgentConnectors(
  enabledTypes: string[],
  onRequest?: () => void,
  baseUrl = API_BASE_URL,
): void {
  server.use(
    http.get(`${baseUrl}/api/zero/agents/${AGENT_ID}/user-connectors`, () => {
      onRequest?.();
      return HttpResponse.json({ enabledTypes });
    }),
  );
}

function stubResolvedDependencies(
  connectorRef = "github",
  options: {
    readonly connector?: ConnectorResponse | null;
    readonly enabledTypes?: string[];
    readonly baseUrl?: string;
  } = {},
): void {
  const baseUrl = options.baseUrl ?? API_BASE_URL;
  stubConnector(
    connectorRef,
    options.connector === undefined
      ? connectorResponse(connectorRef)
      : options.connector,
    undefined,
    baseUrl,
  );
  stubAgentConnectors(
    options.enabledTypes ?? [connectorRef],
    undefined,
    baseUrl,
  );
}

describe("zero connector check command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    chalk.level = 0;
    vi.stubEnv("VM0_API_BACKEND_URL", API_BASE_URL);
    vi.stubEnv("ZERO_TOKEN", buildZeroToken());
    vi.stubEnv("ZERO_AGENT_ID", AGENT_ID);
    vi.stubEnv("ZERO_CHAT_THREAD_ID", "");
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
  });

  function getOutput(): string {
    return mockConsoleLog.mock.calls.flat().join("\n");
  }

  function getErrorOutput(): string {
    return mockConsoleError.mock.calls.flat().join("\n");
  }

  async function expectCommandFailure(args: string[]): Promise<void> {
    await expect(
      checkConnectorCommand.parseAsync(["node", "cli", ...args]),
    ).rejects.toThrow("process.exit called");
    expect(mockExit).toHaveBeenCalledWith(1);
  }

  describe("request construction and local validation", () => {
    it("sends a sanitized URL request and preserves every selector in the re-diagnosis hint", async () => {
      let capturedBody: unknown;
      stubDiagnostic(
        resolvedUrl({
          connector: connectorIdentity({
            connectorRef: "server-only",
            label: "Server Only",
          }),
          environmentNames: ["SERVER_ONLY_TOKEN"],
          method: "POST",
          base: "https://service.example.com/api",
          relativePath: "/items",
        }),
        (body) => {
          capturedBody = body;
        },
      );
      stubResolvedDependencies("server-only");

      await checkConnectorCommand.parseAsync([
        "node",
        "cli",
        "--url",
        "https://service.example.com/api/items?access_token=secret#private",
        "--connector",
        "server-only",
        "--env-name",
        "SERVER_ONLY_TOKEN",
        "--method",
        "post",
      ]);

      expect(capturedBody).toStrictEqual({
        mode: "url",
        method: "POST",
        url: "https://service.example.com/api/items",
        connectorRef: "server-only",
        environmentName: "SERVER_ONLY_TOKEN",
      } satisfies ConnectorCheckRequest);
      expect(getOutput()).toContain(
        "URL https://service.example.com/api/items matches the Server Only connector",
      );
      expect(getOutput()).toContain(
        "zero connector check --url 'https://service.example.com/api/items' --connector 'server-only' --env-name 'SERVER_ONLY_TOKEN' --method 'POST'",
      );
      expect(getOutput()).not.toContain("access_token=secret");
      expect(getOutput()).not.toContain("#private");
      expect(getErrorOutput()).not.toContain("access_token=secret");
    });

    it("rejects URL userinfo before transport or output", async () => {
      let diagnosticRequested = false;
      server.use(
        http.post(diagnosticEndpoint(), () => {
          diagnosticRequested = true;
          return HttpResponse.json(resolvedUrl());
        }),
      );

      await expectCommandFailure([
        "--url",
        "https://sensitive-user:sensitive-password@api.github.com/repos/vm0-ai/vm0",
      ]);

      expect(diagnosticRequested).toBe(false);
      expect(getErrorOutput()).toContain(
        "requires --url to be a valid absolute http or https URL",
      );
      expect(getOutput()).not.toContain("sensitive-user");
      expect(getOutput()).not.toContain("sensitive-password");
      expect(getErrorOutput()).not.toContain("sensitive-user");
      expect(getErrorOutput()).not.toContain("sensitive-password");
    });

    it("sends an environment request with the explicit permission", async () => {
      let capturedBody: unknown;
      stubDiagnostic(
        resolvedEnvironment({
          permission: { outcome: "deny", basis: "deny-list" },
        }),
        (body) => {
          capturedBody = body;
        },
      );
      stubResolvedDependencies();

      await checkConnectorCommand.parseAsync([
        "node",
        "cli",
        "--env-name",
        "GH_TOKEN",
        "--check-permission",
        "contents:write",
      ]);

      expect(capturedBody).toStrictEqual({
        mode: "environment",
        environmentName: "GH_TOKEN",
        permission: "contents:write",
      } satisfies ConnectorCheckRequest);
      expect(getOutput()).toContain(
        'Checking permission: "contents:write" for the GitHub connector.',
      );
      expect(getOutput()).toContain(
        'Result: "contents:write" is in the deny list — denied.',
      );
      expect(getOutput()).toContain(
        "zero connector permission-request github --permission contents:write",
      );
      expect(getOutput()).not.toContain("--callback-prompt");
    });

    it("prints a callback permission command example in the current web chat", async () => {
      vi.stubEnv("ZERO_AGENT_ID", AGENT_ID);
      vi.stubEnv("ZERO_CHAT_THREAD_ID", "thread-abc-123");
      stubDiagnostic(
        resolvedEnvironment({
          permission: { outcome: "ask", basis: "ask-list" },
        }),
      );
      stubResolvedDependencies();

      await checkConnectorCommand.parseAsync([
        "node",
        "cli",
        "--env-name",
        "GH_TOKEN",
        "--check-permission",
        "contents:write",
      ]);

      expect(getOutput()).toContain(
        'zero connector permission-request github --permission contents:write --callback-prompt "SOMETHING_AGENT_WANT_TO_BE_CALLBACK"',
      );
      expect(getOutput()).toContain("automatically start the next round");
    });

    it.each([
      {
        name: "Computer Use URL",
        args: ["--url", "https://api.vm0.ai/computer-use/commands"],
      },
      {
        name: "Computer Use permission",
        args: [
          "--env-name",
          "COMPUTER_USE_HOST",
          "--check-permission",
          "computer-use:write",
        ],
      },
    ])("handles a $name locally", async ({ args }) => {
      await checkConnectorCommand.parseAsync(["node", "cli", ...args]);

      expect(getOutput()).toContain(
        "Computer Use access is not managed as a connector permission.",
      );
      expect(getOutput()).toContain("selected for the chat or thread");
      expect(getOutput()).not.toContain("Step 1");
    });

    it.each([
      {
        name: "requires one input mode",
        args: [],
        expected: "Either --env-name or --url is required",
      },
      {
        name: "rejects connector without URL",
        args: ["--env-name", "GH_TOKEN", "--connector", "github"],
        expected: "--connector can only be used with --url",
      },
      {
        name: "rejects permission with URL",
        args: [
          "--url",
          "https://api.github.com/repos/vm0-ai/vm0",
          "--check-permission",
          "contents:read",
        ],
        expected: "--check-permission cannot be used with --url",
      },
      {
        name: "rejects an empty permission",
        args: ["--env-name", "GH_TOKEN", "--check-permission", ""],
        expected: "--check-permission requires a non-empty permission name",
      },
      {
        name: "rejects method without URL",
        args: ["--env-name", "GH_TOKEN", "--method", "POST"],
        expected: "--method can only be used with --url",
      },
    ])("$name", async ({ args, expected }) => {
      await expectCommandFailure(args);
      expect(getErrorOutput()).toContain(expected);
      expect(getOutput()).not.toContain("Step 1");
    });
  });

  describe("resolved identities and local responsibilities", () => {
    it("uses a server-only connector ref for local presence, connection, and authorization checks", async () => {
      const serverOnlyIdentity = connectorIdentity({
        connectorRef: "server-only",
        label: "Server Only Connector",
      });
      let connectorCalls = 0;
      let authorizationCalls = 0;
      vi.stubEnv("SERVER_ONLY_TOKEN", "placeholder-not-a-secret");
      stubDiagnostic(
        resolvedEnvironment({
          connector: serverOnlyIdentity,
          environmentName: "SERVER_ONLY_TOKEN",
          run: {
            status: "configured",
            bases: [
              "https://one.server-only.example.com",
              "https://two.server-only.example.com",
            ],
          },
        }),
      );
      stubConnector("server-only", connectorResponse("server-only"), () => {
        connectorCalls += 1;
      });
      stubAgentConnectors(["server-only"], () => {
        authorizationCalls += 1;
      });

      await checkConnectorCommand.parseAsync([
        "node",
        "cli",
        "--env-name",
        "SERVER_ONLY_TOKEN",
      ]);

      const output = getOutput();
      expect(output).toContain(
        "SERVER_ONLY_TOKEN is managed by the Server Only Connector connector (type: server-only).",
      );
      expect(output).toContain(
        "Checking process.env.SERVER_ONLY_TOKEN: present",
      );
      expect(output).toContain(
        "The Server Only Connector connector is connected and active.",
      );
      expect(output).toContain(
        "The Server Only Connector connector is authorized for this agent.",
      );
      expect(output).toContain("  - https://one.server-only.example.com");
      expect(output).toContain("  - https://two.server-only.example.com");
      expect(output).toContain(
        "Credentials are resolved at the network boundary for requests matching these registered base URLs.",
      );
      expect(output).not.toContain("Credentials resolved from:");
      expect(connectorCalls).toBe(1);
      expect(authorizationCalls).toBe(1);
    });

    it("reports a missing local environment value without reading a bundled binding", async () => {
      stubDiagnostic(resolvedEnvironment());
      stubResolvedDependencies();

      await checkConnectorCommand.parseAsync([
        "node",
        "cli",
        "--env-name",
        "GH_TOKEN",
      ]);

      expect(getOutput()).toContain(
        "Checking process.env.GH_TOKEN: not present",
      );
      expect(getOutput()).toContain(
        "No value found for these environment names",
      );
    });

    it.each([
      {
        name: "unavailable",
        identity: connectorIdentity({ visibility: "unavailable" }),
        connector: null,
        enabledTypes: [] as string[],
        expected: "not available for this account",
      },
      {
        name: "disconnected but authorized",
        identity: connectorIdentity(),
        connector: null,
        enabledTypes: ["github"],
        expected: "authorized for this agent, but it is not connected",
      },
      {
        name: "expired",
        identity: connectorIdentity(),
        connector: connectorResponse("github", "reconnect-required"),
        enabledTypes: ["github"],
        expected: "needs to be reconnected",
      },
      {
        name: "connected but unauthorized",
        identity: connectorIdentity(),
        connector: connectorResponse("github"),
        enabledTypes: [] as string[],
        expected: "not authorized for this agent",
      },
    ])(
      "renders $name connector state",
      async ({ identity, connector, enabledTypes, expected }) => {
        stubDiagnostic(resolvedEnvironment({ connector: identity }));
        stubResolvedDependencies("github", { connector, enabledTypes });

        await checkConnectorCommand.parseAsync([
          "node",
          "cli",
          "--env-name",
          "GH_TOKEN",
        ]);

        expect(getOutput()).toContain(expected);
      },
    );

    it.each([
      {
        name: "production API",
        baseUrl: "https://api.vm0.ai",
        platformOrigin: "https://app.vm0.ai",
      },
      {
        name: "legacy production web",
        baseUrl: "https://www.vm0.ai",
        platformOrigin: "https://app.vm0.ai",
      },
      {
        name: "legacy production platform",
        baseUrl: "https://platform.vm0.ai",
        platformOrigin: "https://app.vm0.ai",
      },
      {
        name: "canonical production app",
        baseUrl: "https://app.vm0.ai",
        platformOrigin: "https://app.vm0.ai",
      },
      {
        name: "staging API",
        baseUrl: "https://staging-api.vm6.ai",
        platformOrigin: "https://staging-app.omby.ai",
      },
      {
        name: "staging web",
        baseUrl: "https://staging-www.omby.ai",
        platformOrigin: "https://staging-app.omby.ai",
      },
      {
        name: "Cloudflare staging app",
        baseUrl: "https://staging-app.omby.ai",
        platformOrigin: "https://staging-app.omby.ai",
      },
      {
        name: "preview API",
        baseUrl: "https://pr-123-api.vm6.ai",
        platformOrigin: "https://pr-123-app.omby.ai",
      },
      {
        name: "preview web",
        baseUrl: "https://pr-123-www.omby.ai",
        platformOrigin: "https://pr-123-app.omby.ai",
      },
      {
        name: "Cloudflare preview app",
        baseUrl: "https://pr-123-app.omby.ai",
        platformOrigin: "https://pr-123-app.omby.ai",
      },
      {
        name: "tunnel API",
        baseUrl: "https://tunnel-user-host-api.vm7.ai",
        platformOrigin: "https://tunnel-user-host-app.vm7.ai",
      },
      {
        name: "localhost with a port",
        baseUrl: "http://localhost:4310",
        platformOrigin: "http://localhost:4310",
      },
      {
        name: "custom host",
        baseUrl: "https://custom.example.com",
        platformOrigin: "https://app.custom.example.com",
      },
    ])(
      "maps $name links to the platform origin",
      async ({ baseUrl, platformOrigin }) => {
        vi.stubEnv("VM0_API_BACKEND_URL", baseUrl);
        stubDiagnostic(resolvedEnvironment(), undefined, baseUrl);
        stubResolvedDependencies("github", {
          connector: null,
          enabledTypes: [],
          baseUrl,
        });

        await checkConnectorCommand.parseAsync([
          "node",
          "cli",
          "--env-name",
          "GH_TOKEN",
        ]);

        expect(getOutput()).toContain(
          `[Authorize GitHub](${platformOrigin}/connectors/github/authorize?agentId=${AGENT_ID})`,
        );
      },
    );

    it.each([
      {
        name: "unavailable environment metadata",
        environmentNames: null,
        expected: "Environment metadata is unavailable",
      },
      {
        name: "a route without environment names",
        environmentNames: [] as string[],
        expected: "does not use a sandbox environment name",
      },
    ])("renders $name", async ({ environmentNames, expected }) => {
      stubDiagnostic(resolvedUrl({ environmentNames }));
      stubResolvedDependencies();

      await checkConnectorCommand.parseAsync([
        "node",
        "cli",
        "--url",
        "https://api.github.com/repos/vm0-ai/vm0",
      ]);

      expect(getOutput()).toContain(expected);
      expect(getOutput()).not.toContain("Checking process.env.GITHUB_TOKEN");
    });
  });

  describe("run and credential behavior", () => {
    it.each([
      {
        name: "not configured",
        run: { status: "not-configured" as const },
        expected: "No configuration found for the GitHub connector in this run",
      },
      {
        name: "not scoped",
        run: { status: "not-scoped" as const },
        expected: "This diagnostic is not scoped to a run",
      },
    ])("renders a $name run", async ({ run, expected }) => {
      stubDiagnostic(resolvedEnvironment({ run }));
      stubResolvedDependencies();

      await checkConnectorCommand.parseAsync([
        "node",
        "cli",
        "--env-name",
        "GH_TOKEN",
      ]);

      expect(getOutput()).toContain(expected);
    });

    it("does not claim credential resolution when the server returns none", async () => {
      stubDiagnostic(
        resolvedEnvironment({
          connector: connectorIdentity({ credentialResolution: "none" }),
        }),
      );
      stubResolvedDependencies();

      await checkConnectorCommand.parseAsync([
        "node",
        "cli",
        "--env-name",
        "GH_TOKEN",
      ]);

      expect(getOutput()).not.toContain(
        "Credentials are resolved at the network boundary for requests matching these registered base URLs.",
      );
    });

    it("does not use a local dynamic-base value when the server reports it unresolved", async () => {
      vi.stubEnv("REAP_API_BASE_URL", "https://local-only.example.com/v1");
      stubDiagnostic({
        outcome: "unresolved-dynamic-base",
        connector: connectorIdentity({
          connectorRef: "reap",
          label: "Reap",
        }),
      });

      await expectCommandFailure([
        "--url",
        "https://local-only.example.com/v1/users",
        "--connector",
        "reap",
      ]);

      expect(getErrorOutput()).toContain(
        "No authoritative Reap base URL is available",
      );
      expect(getOutput()).not.toContain("Step 1");
      expect(getOutput()).not.toContain("configured for this run");
    });
  });

  describe("final policy rendering", () => {
    interface NamedPolicyCase {
      readonly name: string;
      readonly policy: ConnectorCheckPolicy;
      readonly expected: string;
    }

    const namedPolicyCases = [
      {
        name: "allow list",
        policy: { outcome: "allow", basis: "allow-list" },
        expected: '"contents:read" is in the allow list — allowed',
      },
      {
        name: "not blocked",
        policy: { outcome: "allow", basis: "not-blocked" },
        expected: '"contents:read" is not blocked by the deny or ask list',
      },
      {
        name: "no policy",
        policy: { outcome: "allow", basis: "no-policy" },
        expected: "No policy entry exists for this connector",
      },
      {
        name: "unknown policy allow",
        policy: { outcome: "allow", basis: "unknown-policy" },
        expected: "server policy allows",
      },
      {
        name: "deny list",
        policy: { outcome: "deny", basis: "deny-list" },
        expected: '"contents:read" is in the deny list — denied',
      },
      {
        name: "unknown policy deny",
        policy: { outcome: "deny", basis: "unknown-policy" },
        expected: "unknown-endpoint policy denies",
      },
      {
        name: "ask list",
        policy: { outcome: "ask", basis: "ask-list" },
        expected: '"contents:read" is in the ask list — blocked until approval',
      },
      {
        name: "unknown policy ask",
        policy: { outcome: "ask", basis: "unknown-policy" },
        expected: "unknown-endpoint policy blocks",
      },
      {
        name: "not run scoped",
        policy: { outcome: "unavailable", basis: "not-run-scoped" },
        expected: "not scoped to a run",
      },
      {
        name: "policies unavailable",
        policy: { outcome: "unavailable", basis: "policies-unavailable" },
        expected: "Network policies are unavailable",
      },
      {
        name: "connector not configured",
        policy: {
          outcome: "unavailable",
          basis: "connector-not-configured",
        },
        expected: "connector is not configured for this run",
      },
    ] satisfies readonly NamedPolicyCase[];

    it.each(namedPolicyCases)(
      "renders the $name named-permission result without full policy lists",
      async ({ policy, expected }) => {
        stubDiagnostic(
          resolvedEnvironment({
            permission: policy,
          }),
        );
        stubResolvedDependencies();

        await checkConnectorCommand.parseAsync([
          "node",
          "cli",
          "--env-name",
          "GH_TOKEN",
          "--check-permission",
          "contents:read",
        ]);

        expect(getOutput()).toContain(expected);
        expect(getOutput()).not.toContain("allow list: [");
        expect(getOutput()).not.toContain("deny list:  [");
        expect(getOutput()).not.toContain("ask list:   [");
        const requestCommand =
          "zero connector permission-request github --permission contents:read";
        if (policy.outcome === "deny" || policy.outcome === "ask") {
          expect(getOutput()).toContain(requestCommand);
        } else {
          expect(getOutput()).not.toContain(requestCommand);
        }
      },
    );

    it("renders multiple matched URL permissions from final server outcomes", async () => {
      stubDiagnostic(
        resolvedUrl({
          permission: {
            kind: "matched",
            permissions: [
              {
                name: "contents:read",
                policy: { outcome: "allow", basis: "allow-list" },
              },
              {
                name: "metadata:read",
                policy: { outcome: "ask", basis: "ask-list" },
              },
            ],
          },
        }),
      );
      stubResolvedDependencies();

      await checkConnectorCommand.parseAsync([
        "node",
        "cli",
        "--url",
        "https://api.github.com/repos/vm0-ai/vm0",
      ]);

      expect(getOutput()).toContain(
        "Matched permissions: [contents:read, metadata:read]",
      );
      expect(getOutput()).toContain('"contents:read" is in the allow list');
      expect(getOutput()).toContain('"metadata:read" is in the ask list');
      expect(getOutput()).not.toContain("--permission contents:read");
      expect(getOutput()).toContain(
        "zero connector permission-request github --permission metadata:read",
      );
    });

    interface UnknownPolicyCase {
      readonly name: string;
      readonly policy: ConnectorCheckPolicy;
      readonly expected: string;
      readonly expectsGuidance: boolean;
    }

    const unknownPolicyCases = [
      {
        name: "allow",
        policy: { outcome: "allow", basis: "unknown-policy" },
        expected: "unknown endpoint policy allows this request",
        expectsGuidance: false,
      },
      {
        name: "no policy",
        policy: { outcome: "allow", basis: "no-policy" },
        expected: "No policy entry exists for this connector",
        expectsGuidance: false,
      },
      {
        name: "deny",
        policy: { outcome: "deny", basis: "unknown-policy" },
        expected: "unknown endpoint policy denies this request",
        expectsGuidance: true,
      },
      {
        name: "ask",
        policy: { outcome: "ask", basis: "unknown-policy" },
        expected: "unknown endpoint policy requires approval",
        expectsGuidance: true,
      },
      {
        name: "unavailable",
        policy: { outcome: "unavailable", basis: "policies-unavailable" },
        expected: "Network policies are unavailable",
        expectsGuidance: false,
      },
    ] satisfies readonly UnknownPolicyCase[];

    it.each(unknownPolicyCases)(
      "renders the $name unknown-endpoint result",
      async ({ policy, expected, expectsGuidance }) => {
        stubDiagnostic(
          resolvedUrl({
            permission: { kind: "unknown-endpoint", policy },
          }),
        );
        stubResolvedDependencies();

        await checkConnectorCommand.parseAsync([
          "node",
          "cli",
          "--url",
          "https://api.github.com/not-a-known-endpoint",
        ]);

        expect(getOutput()).toContain("No named permission matches");
        expect(getOutput()).toContain(expected);
        if (expectsGuidance) {
          expect(getOutput()).toContain(
            "zero connector permission-request github --permission __unknown__",
          );
        } else {
          expect(getOutput()).not.toContain("--permission __unknown__");
        }
      },
    );
  });

  describe("explicit diagnostic outcomes", () => {
    interface OutcomeCase {
      readonly name: string;
      readonly args: string[];
      readonly result: ConnectorCheckDiagnosticResult;
      readonly expected: string;
    }

    const outcomeCases = [
      {
        name: "invalid method",
        args: [
          "--url",
          "https://api.github.com/repos/vm0-ai/vm0",
          "--method",
          "TRACE",
        ],
        result: { outcome: "unsafe-input", reason: "invalid-method" },
        expected: "requires --method to be a supported HTTP method",
      },
      {
        name: "invalid URL",
        args: ["--url", "not-a-url"],
        result: { outcome: "unsafe-input", reason: "invalid-url" },
        expected: "requires --url to be a valid absolute http or https URL",
      },
      {
        name: "unsafe path",
        args: ["--url", "https://api.github.com/%2e%2e/private"],
        result: { outcome: "unsafe-input", reason: "unsafe-path" },
        expected: "cannot diagnose unsafe URL paths",
      },
      {
        name: "unknown connector",
        args: [
          "--url",
          "https://service.example.com/path",
          "--connector",
          "missing-connector",
        ],
        result: { outcome: "unknown-connector" },
        expected: "Unknown connector type: missing-connector",
      },
      {
        name: "unknown environment",
        args: ["--env-name", "UNKNOWN_CONNECTOR_VALUE"],
        result: { outcome: "unknown-environment" },
        expected: "Unknown environment name: UNKNOWN_CONNECTOR_VALUE",
      },
      {
        name: "catalog no match",
        args: ["--url", "https://unknown.example.com/path"],
        result: { outcome: "no-match", scope: "catalog" },
        expected: "no registered connector base URL matches this URL",
      },
      {
        name: "run no match",
        args: ["--url", "https://unknown.example.com/path"],
        result: { outcome: "no-match", scope: "run" },
        expected:
          "no connector configured for the current run matches this URL",
      },
      {
        name: "connector mismatch",
        args: [
          "--url",
          "https://api.github.com/repos/vm0-ai/vm0",
          "--connector",
          "slack",
        ],
        result: {
          outcome: "connector-mismatch",
          connector: connectorIdentity(),
        },
        expected: "the matching connector is github",
      },
      {
        name: "environment not owned",
        args: [
          "--url",
          "https://api.github.com/repos/vm0-ai/vm0",
          "--env-name",
          "SLACK_TOKEN",
        ],
        result: {
          outcome: "environment-not-owned",
          connector: connectorIdentity(),
        },
        expected:
          "SLACK_TOKEN is not an environment name for the GitHub connector",
      },
      {
        name: "environment not used",
        args: [
          "--url",
          "https://api.github.com/repos/vm0-ai/vm0",
          "--env-name",
          "GH_TOKEN",
        ],
        result: {
          outcome: "environment-not-used",
          connector: connectorIdentity(),
          environmentNames: ["GITHUB_TOKEN"],
        },
        expected: "Expected one of: GITHUB_TOKEN",
      },
      {
        name: "unresolved dynamic base",
        args: [
          "--url",
          "https://tenant.example.com/path",
          "--connector",
          "reap",
        ],
        result: {
          outcome: "unresolved-dynamic-base",
          connector: connectorIdentity({
            connectorRef: "reap",
            label: "Reap",
          }),
        },
        expected: "No authoritative Reap base URL is available",
      },
      {
        name: "run context unavailable",
        args: ["--env-name", "GH_TOKEN"],
        result: { outcome: "run-context-unavailable" },
        expected: "current run context is unavailable",
      },
    ] satisfies readonly OutcomeCase[];

    it.each(outcomeCases)(
      "renders the $name outcome without starting resolved checks",
      async ({ args, result, expected }) => {
        stubDiagnostic(result);

        await expectCommandFailure(args);

        expect(getErrorOutput()).toContain(expected);
        expect(getOutput()).not.toContain("Step 1");
        expect(getOutput()).not.toContain("Step 2");
      },
    );

    it("sorts ambiguous candidates and prints sanitized selection commands", async () => {
      stubDiagnostic({
        outcome: "ambiguous",
        candidates: [
          { connectorRef: "zeta", label: "Zeta" },
          { connectorRef: "alpha", label: "Alpha" },
        ],
      });

      await expectCommandFailure([
        "--url",
        "https://shared.example.com/path?secret=value#private",
        "--method",
        "post",
      ]);

      const error = getErrorOutput();
      expect(error).toContain("alpha, zeta");
      expect(error).toContain(
        "--url 'https://shared.example.com/path' --connector 'alpha' --method 'POST'",
      );
      expect(error).toContain(
        "--url 'https://shared.example.com/path' --connector 'zeta' --method 'POST'",
      );
      expect(error).not.toContain("secret=value");
      expect(error).not.toContain("#private");
    });
  });

  describe("endpoint and contract failures", () => {
    it.each([
      {
        name: "missing endpoint",
        status: 404,
        body: { error: { message: "Route not found", code: "NOT_FOUND" } },
        expected: "Route not found",
      },
      {
        name: "authentication failure",
        status: 401,
        body: { error: { message: "Unauthorized", code: "UNAUTHORIZED" } },
        expected: "Authentication failed",
      },
      {
        name: "authorization failure",
        status: 403,
        body: { error: { message: "Forbidden", code: "FORBIDDEN" } },
        expected: "403: Forbidden",
      },
      {
        name: "server failure",
        status: 500,
        body: { error: { message: "Server failed", code: "INTERNAL" } },
        expected: "500: Server failed",
      },
    ])(
      "surfaces $name with no fallback",
      async ({ status, body, expected }) => {
        let secondaryCalls = 0;
        server.use(
          http.post(diagnosticEndpoint(), () => {
            return HttpResponse.json(body, { status });
          }),
        );
        stubConnector("github", connectorResponse("github"), () => {
          secondaryCalls += 1;
        });
        stubAgentConnectors(["github"], () => {
          secondaryCalls += 1;
        });

        await expectCommandFailure(["--env-name", "GH_TOKEN"]);

        expect(getErrorOutput()).toContain(expected);
        expect(getOutput()).not.toContain("Step 1");
        expect(secondaryCalls).toBe(0);
      },
    );

    it("surfaces a network failure with no fallback", async () => {
      server.use(
        http.post(diagnosticEndpoint(), () => {
          return HttpResponse.error();
        }),
      );

      await expectCommandFailure(["--env-name", "GH_TOKEN"]);

      expect(getErrorOutput()).not.toBe("");
      expect(getOutput()).not.toContain("Step 1");
    });

    it("rejects a malformed successful response at runtime", async () => {
      server.use(
        http.post(diagnosticEndpoint(), () => {
          return HttpResponse.json({ outcome: "future-unsupported-outcome" });
        }),
      );

      await expectCommandFailure(["--env-name", "GH_TOKEN"]);

      expect(getErrorOutput()).not.toBe("");
      expect(getOutput()).not.toContain("Step 1");
      expect(getOutput()).not.toContain("configured for this run");
    });
  });
});
