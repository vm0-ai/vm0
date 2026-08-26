import type { ConnectorAccountConnection } from "@okouai/api-contracts/contracts/connector-accounts";
import chalk from "chalk";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../../mocks/server";
import {
  authCodeMethod,
  catalogStatusItem,
  stubConnectorCatalogStatus,
} from "../../../__tests__/helpers/connector-catalog";
import {
  customConnector,
  stubCustomConnectors,
} from "../../../__tests__/helpers/custom-connectors";
import { listConnectorAccountsCommand } from "../list";

const FIRST_CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_CONNECTION_ID = "22222222-2222-4222-8222-222222222222";
const CUSTOM_CONNECTOR_ID = "33333333-3333-4333-8333-333333333333";

function connectorAccount(
  overrides: Partial<ConnectorAccountConnection> = {},
): ConnectorAccountConnection {
  return {
    id: FIRST_CONNECTION_ID,
    target: { kind: "builtin", connectorSlug: "github" },
    authMethod: "oauth",
    displayName: null,
    isDefault: false,
    externalId: null,
    externalUsername: null,
    externalEmail: null,
    oauthScopes: ["repo"],
    connectionStatus: "connected",
    reconnectReason: null,
    tokenExpiresAt: "2026-09-01T00:00:00.000Z",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    ...overrides,
  };
}

function stubCatalog(): ReturnType<typeof http.get> {
  return stubConnectorCatalogStatus([
    catalogStatusItem({
      connectorSlug: "github",
      label: "GitHub",
      authMethods: [authCodeMethod("oauth")],
    }),
  ]);
}

function stubAccounts(
  connections: readonly ConnectorAccountConnection[],
): ReturnType<typeof http.get> {
  return http.get(
    "http://localhost:3000/api/connector-accounts/connections",
    () => {
      return HttpResponse.json({ connections, nextCursor: null });
    },
  );
}

describe("okou connector account list command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    listConnectorAccountsCommand.setOptionValue("json", false);
    listConnectorAccountsCommand.setOptionValue("search", undefined);
    server.use(stubCatalog(), stubCustomConnectors([]));
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  it("renders safe account details with shared label fallbacks", async () => {
    server.use(
      stubAccounts([
        connectorAccount({
          displayName: "Work",
          externalEmail: "work@example.com",
          isDefault: true,
        }),
        connectorAccount({
          id: SECOND_CONNECTION_ID,
          externalUsername: "octocat",
          connectionStatus: "reconnect-required",
          reconnectReason: "authorization_expired_or_revoked",
        }),
        connectorAccount({
          id: "44444444-4444-4444-8444-444444444444",
          authMethod: "api-token",
        }),
      ]),
    );

    await listConnectorAccountsCommand.parseAsync(["node", "okou", "github"]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Available accounts for GitHub (github):");
    expect(output).toContain("ACCOUNT");
    expect(output).toContain("Work (work@example.com)");
    expect(output).toContain("@octocat");
    expect(output).toContain("Account #44444444");
    expect(output).toContain("reconnect-required");
    expect(output).toContain(FIRST_CONNECTION_ID);
    expect(output).toContain(SECOND_CONNECTION_ID);
  });

  it("resolves a custom connector slug to its connection target", async () => {
    const custom = customConnector({
      id: CUSTOM_CONNECTOR_ID,
      slug: "_acme-search",
      displayName: "Acme Search",
    });
    server.use(
      stubCustomConnectors([custom]),
      http.get(
        "http://localhost:3000/api/connector-accounts/connections",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("kind")).toBe("custom");
          expect(url.searchParams.get("customConnectorId")).toBe(
            CUSTOM_CONNECTOR_ID,
          );
          expect(url.searchParams.get("limit")).toBe("100");
          return HttpResponse.json({
            connections: [
              connectorAccount({
                target: {
                  kind: "custom",
                  customConnectorId: CUSTOM_CONNECTOR_ID,
                },
              }),
            ],
            nextCursor: null,
          });
        },
      ),
    );

    await listConnectorAccountsCommand.parseAsync([
      "node",
      "okou",
      "_acme-search",
    ]);

    expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
      "Available accounts for Acme Search (_acme-search):",
    );
  });

  it("fetches all pages sequentially and forwards search", async () => {
    const cursors: (string | null)[] = [];
    server.use(
      http.get(
        "http://localhost:3000/api/connector-accounts/connections",
        ({ request }) => {
          const url = new URL(request.url);
          const cursor = url.searchParams.get("cursor");
          cursors.push(cursor);
          expect(url.searchParams.get("kind")).toBe("builtin");
          expect(url.searchParams.get("connectorSlug")).toBe("github");
          expect(url.searchParams.get("limit")).toBe("100");
          expect(url.searchParams.get("search")).toBe("work");
          return HttpResponse.json(
            cursor
              ? {
                  connections: [connectorAccount({ id: SECOND_CONNECTION_ID })],
                  nextCursor: null,
                }
              : {
                  connections: [connectorAccount()],
                  nextCursor: "page-2",
                },
          );
        },
      ),
    );

    await listConnectorAccountsCommand.parseAsync([
      "node",
      "okou",
      "github",
      "--search",
      " work ",
    ]);

    expect(cursors).toStrictEqual([null, "page-2"]);
    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain(FIRST_CONNECTION_ID);
    expect(output).toContain(SECOND_CONNECTION_ID);
  });

  it("emits stable JSON without credentials or operational timestamps", async () => {
    server.use(
      stubAccounts([
        connectorAccount({
          externalUsername: "octocat",
          isDefault: true,
        }),
      ]),
    );

    await listConnectorAccountsCommand.parseAsync([
      "node",
      "okou",
      "github",
      "--json",
    ]);

    const output = String(mockConsoleLog.mock.calls[0]?.[0]);
    const parsed: unknown = JSON.parse(output);
    expect(parsed).toStrictEqual({
      context: "available",
      connector: {
        kind: "builtin",
        slug: "github",
        label: "GitHub",
        target: { kind: "builtin", connectorSlug: "github" },
      },
      accounts: [
        {
          connectionId: FIRST_CONNECTION_ID,
          effectiveLabel: "octocat",
          displayName: null,
          externalIdentity: "octocat",
          isDefault: true,
          authMethod: "oauth",
          connectionStatus: "connected",
          reconnectReason: null,
        },
      ],
    });
    expect(output).not.toContain("oauthScopes");
    expect(output).not.toContain("tokenExpiresAt");
    expect(output).not.toContain("createdAt");
    expect(output).not.toContain("updatedAt");
  });

  it("distinguishes an empty inventory from an empty search", async () => {
    server.use(stubAccounts([]));

    await listConnectorAccountsCommand.parseAsync(["node", "okou", "github"]);
    expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
      "Run: okou connector status github",
    );

    mockConsoleLog.mockClear();
    await listConnectorAccountsCommand.parseAsync([
      "node",
      "okou",
      "github",
      "--search",
      "personal",
    ]);
    const filteredOutput = mockConsoleLog.mock.calls.flat().join("\n");
    expect(filteredOutput).toContain('match "personal"');
    expect(filteredOutput).not.toContain("Run: okou connector status");
  });

  it("guides custom connector empty inventories to custom status", async () => {
    server.use(
      stubCustomConnectors([
        customConnector({
          id: CUSTOM_CONNECTOR_ID,
          slug: "_acme-search",
          displayName: "Acme Search",
        }),
      ]),
      stubAccounts([]),
    );

    await listConnectorAccountsCommand.parseAsync([
      "node",
      "okou",
      "_acme-search",
    ]);

    expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
      `Run: okou connector custom status ${CUSTOM_CONNECTOR_ID}`,
    );
  });

  it("rejects an empty search before making API requests", async () => {
    await expect(
      listConnectorAccountsCommand.parseAsync([
        "node",
        "okou",
        "github",
        "--search",
        "   ",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      "--search cannot be empty",
    );
  });

  it("reports unknown slugs with all available built-in and custom slugs", async () => {
    server.use(
      stubCustomConnectors([
        customConnector({
          id: CUSTOM_CONNECTOR_ID,
          slug: "_acme-search",
        }),
      ]),
    );

    await expect(
      listConnectorAccountsCommand.parseAsync(["node", "okou", "missing"]),
    ).rejects.toThrow("process.exit called");

    const error = mockConsoleError.mock.calls.flat().join("\n");
    expect(error).toContain("Unknown or unavailable connector: missing");
    expect(error).toContain("Available connectors: _acme-search, github");
  });

  it("discards partial pages when the account inventory becomes unavailable", async () => {
    server.use(
      http.get(
        "http://localhost:3000/api/connector-accounts/connections",
        ({ request }) => {
          const cursor = new URL(request.url).searchParams.get("cursor");
          return cursor
            ? HttpResponse.json(
                { error: { code: "NOT_FOUND", message: "Not found" } },
                { status: 404 },
              )
            : HttpResponse.json({
                connections: [connectorAccount()],
                nextCursor: "page-2",
              });
        },
      ),
    );

    await expect(
      listConnectorAccountsCommand.parseAsync(["node", "okou", "github"]),
    ).rejects.toThrow("process.exit called");

    expect(mockConsoleLog).not.toHaveBeenCalled();
    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      "Available account inventory is unavailable for github",
    );
  });

  it("lists available inventory inside a run without changing its meaning", async () => {
    vi.stubEnv("OKOU_AGENT_ID", "agent-123");
    server.use(
      stubAccounts([connectorAccount({ displayName: "Available account" })]),
    );

    await listConnectorAccountsCommand.parseAsync(["node", "okou", "github"]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Available accounts for GitHub");
    expect(output).toContain("Available account");
    expect(output).not.toContain("ACCOUNT USED BY THIS RUN");
  });
});
