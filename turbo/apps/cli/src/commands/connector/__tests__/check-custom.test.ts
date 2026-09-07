import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  connectorCheckRequestBodySchema,
  type ConnectorCheckRequestBody,
  type ConnectorCheckTargetAwareDiagnosticResult,
} from "@okouai/api-contracts/contracts/connector-check";
import type { ConnectorAccountInspectionResult } from "@okouai/api-contracts/contracts/connector-accounts";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../mocks/server";
import { customConnector } from "../../__tests__/helpers/custom-connectors";
import {
  stubRunConnectorAccountInspection,
  writeRunConnectorAccountContext,
} from "../../__tests__/helpers/run-connector-accounts";
import { checkConnectorCommand } from "../check";

const ORIGIN = "http://localhost:3000";
const CUSTOM_ID = "33333333-3333-4333-8333-333333333333";
const ACCOUNT_ID = "44444444-4444-4444-8444-444444444444";
const DEFAULT_ACCOUNT_ID = "55555555-5555-4555-8555-555555555555";
const TARGET = { kind: "custom", customConnectorId: CUSTOM_ID } as const;
const REQUEST_URL = "https://api.acme.test/pinned/items";

type ResolvedUrl = Extract<
  ConnectorCheckTargetAwareDiagnosticResult,
  { outcome: "resolved"; mode: "url" }
>;
type AvailableAccount = Extract<
  ConnectorAccountInspectionResult,
  { kind: "available" }
>;

function resolvedCustom(permission?: ResolvedUrl["permission"]): ResolvedUrl {
  return {
    outcome: "resolved",
    mode: "url",
    connector: {
      target: TARGET,
      label: "Earlier display name",
      visibility: "available",
      credentialResolution: "network-boundary",
    },
    environmentNames: null,
    run: { status: "configured", bases: ["https://api.acme.test/pinned"] },
    method: "POST",
    base: "https://api.acme.test/pinned",
    relativePath: "/items",
    permission: permission ?? {
      kind: "matched",
      permissions: [
        {
          name: "items:write",
          policy: { outcome: "deny", basis: "deny-list" },
        },
      ],
    },
  };
}

function account(
  connectionStatus: AvailableAccount["connectionStatus"] = "connected",
): AvailableAccount {
  return {
    kind: "available",
    target: TARGET,
    connectionId: ACCOUNT_ID,
    authMethod: "manual",
    displayName: "Run-selected account",
    externalId: "selected-external-id",
    externalUsername: null,
    externalEmail: null,
    connectionStatus,
    reconnectReason:
      connectionStatus === "reconnect-required"
        ? "authorization_expired_or_revoked"
        : null,
  };
}

describe("custom connector URL diagnostics", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const exit = vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit called");
  });
  const requests: ConnectorCheckRequestBody[] = [];
  let directory = "";
  let contextPath = "";

  function stubDiagnostic(
    result: ConnectorCheckTargetAwareDiagnosticResult,
  ): void {
    server.use(
      http.post(
        `${ORIGIN}/api/connectors/diagnostics/check`,
        async ({ request }) => {
          requests.push(
            connectorCheckRequestBodySchema.parse(await request.json()),
          );
          return HttpResponse.json(result);
        },
      ),
    );
  }

  function output(): string {
    return log.mock.calls.flat().join("\n");
  }

  async function check(...extraArgs: string[]): Promise<void> {
    await checkConnectorCommand.parseAsync([
      "node",
      "okou",
      "--url",
      REQUEST_URL,
      "--method",
      "POST",
      ...extraArgs,
    ]);
  }

  beforeEach(() => {
    requests.length = 0;
    directory = mkdtempSync(join(tmpdir(), "okou-custom-check-"));
    contextPath = join(directory, "accounts.json");
    vi.stubEnv("OKOU_API_BACKEND_URL", ORIGIN);
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_AGENT_ID", "agent-1");
    vi.stubEnv("OKOU_CHAT_THREAD_ID", "thread-1");
    vi.stubEnv("OKOU_CONNECTOR_ACCOUNT_CONTEXT_FILE", contextPath);
    writeRunConnectorAccountContext(contextPath, [
      { ...TARGET, connectionId: ACCOUNT_ID },
    ]);
    stubDiagnostic(resolvedCustom());
    server.use(
      http.get(`${ORIGIN}/api/custom-connectors/${CUSTOM_ID}`, () => {
        return HttpResponse.json(
          customConnector({
            id: CUSTOM_ID,
            displayName: "Renamed Acme",
            slug: "_mutable-new-slug",
            prefixTemplates: ["https://api.acme.test/new-default"],
            connected: false,
          }),
        );
      }),
      stubRunConnectorAccountInspection([
        account(),
        {
          ...account(),
          connectionId: DEFAULT_ACCOUNT_ID,
          displayName: "Default sibling",
        },
      ]),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  it("selects a stable UUID and displays current metadata with the pinned account and bases", async () => {
    await check("--connector", `custom:${CUSTOM_ID}`);

    expect(requests).toStrictEqual([
      { mode: "url", method: "POST", url: REQUEST_URL, target: TARGET },
    ]);
    expect(output()).toContain(
      `Renamed Acme connector (custom UUID: ${CUSTOM_ID})`,
    );
    expect(output()).toContain(`Connection ID: ${ACCOUNT_ID}`);
    expect(output()).toContain("Run-selected account");
    expect(output()).toContain(
      "The account selected for this run is connected.",
    );
    expect(output()).toContain("https://api.acme.test/pinned");
    expect(output()).toContain("Environment names: unavailable");
    expect(output()).toContain("current intended state");
    expect(output()).toContain('"items:write" is in the deny list');
    expect(output()).toContain(
      "[Connectors](http://localhost:3000/connectors)",
    );
    expect(output()).toContain("review Permissions");
    expect(output()).toContain(`--connector 'custom:${CUSTOM_ID}'`);
    expect(output()).not.toMatch(
      /Earlier display name|Default sibling|new-default|secrets\.apiKey|Bearer|_mutable-new-slug/,
    );
    expect(output()).not.toMatch(
      /permission-request|connectorSlug=|callback-prompt|connected, active, and authorized/,
    );
  });

  it("does not substitute a healthy default for a reconnect-required run account", async () => {
    server.use(
      stubRunConnectorAccountInspection([account("reconnect-required")]),
      http.get(`${ORIGIN}/api/custom-connectors/${CUSTOM_ID}`, () => {
        return HttpResponse.json(
          customConnector({
            id: CUSTOM_ID,
            connected: true,
            missingRequiredFields: [],
          }),
        );
      }),
    );
    await check();

    expect(requests).toStrictEqual([
      {
        mode: "url",
        method: "POST",
        url: REQUEST_URL,
        includeCustomConnectors: true,
      },
    ]);
    expect(output()).toContain(`Connection ID: ${ACCOUNT_ID}`);
    expect(output()).toContain(
      "account selected for this run needs to be reconnected",
    );
    expect(output()).not.toContain(
      "account selected for this run is connected",
    );
  });

  it("retains a deleted pinned account identity without suggesting a sibling account", async () => {
    server.use(stubRunConnectorAccountInspection([]));
    await check();
    expect(output()).toContain(`Account used by this run: ${ACCOUNT_ID}`);
    expect(output()).toContain(
      "Current account metadata is unavailable or deleted",
    );
    expect(output()).not.toMatch(
      /Default sibling|\/connectors\/[^\s]+\/connect|is connected/,
    );
  });

  it("does not infer an account when run account context is missing", async () => {
    vi.stubEnv("OKOU_CONNECTOR_ACCOUNT_CONTEXT_FILE", "");
    await check();
    expect(output()).toContain("started without connector account context");
    expect(output()).not.toContain("is connected");
  });

  it("reports a definition removed after diagnosis without reusing its stale display name", async () => {
    server.use(
      http.get(`${ORIGIN}/api/custom-connectors/${CUSTOM_ID}`, () => {
        return HttpResponse.json(
          { error: { message: "Not found", code: "NOT_FOUND" } },
          { status: 404 },
        );
      }),
    );
    await check();
    expect(output()).toContain(`custom UUID: ${CUSTOM_ID}`);
    expect(output()).toContain(
      "Current custom connector metadata is unavailable or deleted",
    );
    expect(output()).not.toContain("Earlier display name");
  });

  it("propagates metadata read failures rather than reporting the connector as deleted", async () => {
    server.use(
      http.get(`${ORIGIN}/api/custom-connectors/${CUSTOM_ID}`, () => {
        return HttpResponse.json(
          { error: { message: "Metadata failed", code: "INTERNAL" } },
          { status: 500 },
        );
      }),
    );
    await expect(check()).rejects.toThrow("process.exit called");
    expect(error.mock.calls.flat().join("\n")).toContain("Metadata failed");
    expect(output()).not.toContain("unavailable or deleted");
  });

  it.each([
    { reason: "not-admitted", expected: "was not admitted to this run" },
    { reason: "connector-unavailable", expected: "is unavailable" },
    {
      reason: "permission-bundle-unavailable",
      expected: "unavailable permission metadata",
    },
    {
      reason: "runtime-configuration-unavailable",
      expected: "unavailable runtime configuration",
    },
  ] as const)(
    "explains $reason from backend authority",
    async ({ reason, expected }) => {
      stubDiagnostic({ outcome: "target-unavailable", target: TARGET, reason });
      await expect(check("--connector", `custom:${CUSTOM_ID}`)).rejects.toThrow(
        "process.exit called",
      );
      expect(error.mock.calls.flat().join("\n")).toContain(expected);
      expect(error.mock.calls.flat().join("\n")).toContain(
        `custom:${CUSTOM_ID}`,
      );
      expect(output()).toBe("");
    },
  );

  it("keeps builtin and custom overlapping owners distinct in deterministic selection commands", async () => {
    stubDiagnostic({
      outcome: "ambiguous",
      candidates: [
        { target: TARGET, label: "GitHub" },
        {
          target: { kind: "builtin", connectorSlug: "github" },
          label: "GitHub",
        },
      ],
    });
    await expect(check()).rejects.toThrow("process.exit called");
    const message = error.mock.calls.flat().join("\n");
    expect(message).toContain(`custom:${CUSTOM_ID}, github`);
    expect(message).toContain(
      `--connector 'custom:${CUSTOM_ID}' --method 'POST'`,
    );
    expect(message).toContain("--connector 'github' --method 'POST'");
    expect(message).not.toContain("connectorSlug=");
  });

  it("preserves UUID-shaped builtin selectors instead of guessing they identify custom connectors", async () => {
    stubDiagnostic({ outcome: "unknown-connector" });
    await expect(check("--connector", CUSTOM_ID)).rejects.toThrow(
      "process.exit called",
    );
    expect(requests).toStrictEqual([
      {
        mode: "url",
        method: "POST",
        url: REQUEST_URL,
        connectorSlug: CUSTOM_ID,
      },
    ]);
    expect(error.mock.calls.flat().join("\n")).toContain(
      `Unknown connector slug: ${CUSTOM_ID}`,
    );
  });

  it("rejects malformed custom identity before sending a diagnostic", async () => {
    await expect(check("--connector", "custom:not-a-uuid")).rejects.toThrow(
      "process.exit called",
    );
    expect(requests).toStrictEqual([]);
    expect(error.mock.calls.flat().join("\n")).toContain("custom:<uuid>");
  });

  it("does not treat custom unknown endpoints as a grantable builtin permission", async () => {
    stubDiagnostic(
      resolvedCustom({
        kind: "unknown-endpoint",
        policy: { outcome: "ask", basis: "unknown-policy" },
      }),
    );
    await check();
    expect(output()).toContain("unknown endpoint policy requires approval");
    expect(output()).toContain(
      "There is no custom unknown-endpoint approval control",
    );
    expect(output()).not.toMatch(
      /permission-request|connectorSlug=|review Permissions/,
    );
  });

  it("rejects a legacy identity in a target-aware response without retrying", async () => {
    server.use(
      http.post(
        `${ORIGIN}/api/connectors/diagnostics/check`,
        async ({ request }) => {
          requests.push(
            connectorCheckRequestBodySchema.parse(await request.json()),
          );
          return HttpResponse.json({
            ...resolvedCustom(),
            connector: {
              connectorSlug: "github",
              label: "GitHub",
              visibility: "available",
              credentialResolution: "network-boundary",
            },
          });
        },
      ),
    );
    await expect(check()).rejects.toThrow("process.exit called");
    expect(requests).toHaveLength(1);
    expect(output()).toBe("");
    expect(exit).toHaveBeenCalledWith(1);
  });
});
