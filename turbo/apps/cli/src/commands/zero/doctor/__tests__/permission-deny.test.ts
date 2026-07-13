/**
 * Tests for zero doctor permission-deny command.
 *
 * Tests command-level behavior via parseAsync():
 * - Entry point: command.parseAsync()
 * - Mock (external): vm0 API via MSW
 * - Real (internal): CLI validation, request construction, output, and errors
 */

import type { ConnectorPermissionDenyDiagnosticResult } from "@vm0/api-contracts/contracts/zero-connector-permission-deny";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpResponse, http } from "msw";
import { server } from "../../../../mocks/server";
import { permissionDenyCommand } from "../permission-deny";

const API_BASE_URL = "http://localhost:3000";
const DIAGNOSTIC_ENDPOINT = `${API_BASE_URL}/api/zero/connectors/:connectorRef/diagnostics/permission-deny`;

interface CapturedDiagnosticRequest {
  readonly connectorRef: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

describe("zero doctor permission-deny command", () => {
  let requestCount = 0;

  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  function stubDiagnostic(
    result: ConnectorPermissionDenyDiagnosticResult,
    capture?: (request: CapturedDiagnosticRequest) => void,
  ) {
    return http.post(DIAGNOSTIC_ENDPOINT, async ({ request, params }) => {
      requestCount++;
      capture?.({
        connectorRef: String(params.connectorRef),
        authorization: request.headers.get("authorization"),
        body: await request.json(),
      });
      return HttpResponse.json(result);
    });
  }

  async function runDiagnostic(
    connectorRef: string,
    method: string,
    url: string,
  ): Promise<void> {
    await permissionDenyCommand.parseAsync([
      "node",
      "cli",
      connectorRef,
      "--method",
      method,
      "--url",
      url,
    ]);
  }

  async function expectCommandFailure(args: readonly string[]): Promise<void> {
    await expect(permissionDenyCommand.parseAsync([...args])).rejects.toThrow(
      "process.exit called",
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  }

  beforeEach(() => {
    requestCount = 0;
    vi.stubEnv("VM0_API_BACKEND_URL", API_BASE_URL);
    vi.stubEnv("VM0_TOKEN", "test-token");
    vi.stubEnv("ZERO_TOKEN", "");

    server.use(
      http.post(DIAGNOSTIC_ENDPOINT, () => {
        requestCount++;
        return HttpResponse.json(
          {
            error: {
              message: "Unexpected diagnostic request",
              code: "UNEXPECTED_DIAGNOSTIC_REQUEST",
            },
          },
          { status: 500 },
        );
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  it("uses a server-only ref and removes query and fragment before transport", async () => {
    let captured: CapturedDiagnosticRequest | undefined;
    server.use(
      stubDiagnostic(
        {
          outcome: "matched",
          label: "Remote Only",
          base: "https://remote.example/v1",
          relativePath: "/%7Eraw/accounts",
          permissions: ["accounts.read"],
        },
        (request) => {
          captured = request;
        },
      ),
    );
    vi.stubEnv("ZERO_AGENT_ID", "agent-1");

    await runDiagnostic(
      "remote-only",
      "get",
      "https://remote.example/v1/%7Eraw/accounts?token=query-sentinel#fragment-sentinel",
    );

    expect(captured).toStrictEqual({
      connectorRef: "remote-only",
      authorization: "Bearer test-token",
      body: {
        method: "GET",
        url: "https://remote.example/v1/%7Eraw/accounts",
      },
    });
    expect(requestCount).toBe(1);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain(
      "Remote Only permission filtered GET /%7Eraw/accounts relative to base URL https://remote.example/v1",
    );
    expect(output).toContain('covered by the "accounts.read" permission');
    expect(output).toContain(
      "zero doctor permission-change remote-only --permission accounts.read --enable --duration 1h",
    );
    expect(output).not.toContain("query-sentinel");
    expect(output).not.toContain("fragment-sentinel");
    expect(output).not.toContain("token=");
    expect(output).not.toContain("[Manage");
    expect(output).not.toContain("[Request");
  });

  it("sorts multiple returned permissions for deterministic guidance", async () => {
    server.use(
      stubDiagnostic({
        outcome: "matched",
        label: "Slack",
        base: "https://slack.com/api",
        relativePath: "/chat.postMessage",
        permissions: ["zeta.write", "alpha.write"],
      }),
    );

    await runDiagnostic(
      "slack",
      "POST",
      "https://slack.com/api/chat.postMessage",
    );

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain(
      "This is covered by these permissions: alpha.write, zeta.write.",
    );
    expect(output.indexOf("To allow alpha.write")).toBeLessThan(
      output.indexOf("To allow zeta.write"),
    );
    expect(output).toContain(
      "zero doctor permission-change slack --permission alpha.write --enable --duration 1h",
    );
    expect(output).toContain(
      "zero doctor permission-change slack --permission zeta.write --enable --duration 1h",
    );
  });

  it("renders unknown endpoint policy guidance from the server result", async () => {
    server.use(
      stubDiagnostic({
        outcome: "unknown-endpoint",
        label: "Slack",
        base: "https://slack.com/api",
        relativePath: "/not.real",
      }),
    );

    await runDiagnostic("slack", "DELETE", "https://slack.com/api/not.real");

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain(
      "Slack permission filtered DELETE /not.real relative to base URL https://slack.com/api",
    );
    expect(output).toContain("No named permission was found");
    expect(output).toContain(
      "This request is governed by the unknown endpoint policy.",
    );
    expect(output).toContain(
      "zero doctor permission-change slack --permission __unknown__ --enable --duration 1h",
    );
  });

  const semanticErrorCases: readonly {
    readonly name: string;
    readonly connectorRef: string;
    readonly result: ConnectorPermissionDenyDiagnosticResult;
    readonly expectedMessage: string;
  }[] = [
    {
      name: "unknown connector",
      connectorRef: "missing-connector",
      result: { outcome: "unknown-connector" },
      expectedMessage: "Unknown connector type: missing-connector",
    },
    {
      name: "no matching base",
      connectorRef: "slack",
      result: { outcome: "no-matching-base", label: "Slack" },
      expectedMessage: "No registered Slack base URL matches the provided URL.",
    },
    {
      name: "unresolved dynamic base",
      connectorRef: "reap",
      result: { outcome: "unresolved-dynamic-base", label: "Reap" },
      expectedMessage:
        "No authoritative Reap base URL is available for this diagnostic.",
    },
    {
      name: "server-invalid method",
      connectorRef: "slack",
      result: { outcome: "unsafe-input", reason: "invalid-method" },
      expectedMessage:
        "permission-deny requires --method to be one of GET, POST, PUT, PATCH, DELETE, HEAD, or OPTIONS.",
    },
    {
      name: "server-invalid url",
      connectorRef: "slack",
      result: { outcome: "unsafe-input", reason: "invalid-url" },
      expectedMessage:
        "permission-deny requires --url to be a valid absolute http or https URL.",
    },
    {
      name: "server-unsafe path",
      connectorRef: "slack",
      result: { outcome: "unsafe-input", reason: "unsafe-path" },
      expectedMessage:
        "permission-deny cannot diagnose unsafe URL paths because they are blocked before permission policy evaluation.",
    },
  ];

  it.each(semanticErrorCases)(
    "exits for the $name semantic outcome without fallback",
    async ({ connectorRef, result, expectedMessage }) => {
      server.use(stubDiagnostic(result));

      await expectCommandFailure([
        "node",
        "cli",
        connectorRef,
        "--method",
        "GET",
        "--url",
        "https://example.com/path",
      ]);

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(expectedMessage),
      );
      expect(requestCount).toBe(1);
      expect(mockConsoleLog).not.toHaveBeenCalled();
    },
  );

  it("does not read or send a local dynamic-base environment value", async () => {
    let capturedBody: unknown;
    vi.stubEnv(
      "REAP_API_BASE_URL",
      "https://local-value-must-not-be-used.example/v1",
    );
    server.use(
      stubDiagnostic(
        { outcome: "unresolved-dynamic-base", label: "Reap" },
        (request) => {
          capturedBody = request.body;
        },
      ),
    );

    await expectCommandFailure([
      "node",
      "cli",
      "reap",
      "--method",
      "GET",
      "--url",
      "https://requested.example/v1/accounts",
    ]);

    expect(capturedBody).toStrictEqual({
      method: "GET",
      url: "https://requested.example/v1/accounts",
    });
    const output = [
      ...mockConsoleLog.mock.calls.flat(),
      ...mockConsoleError.mock.calls.flat(),
    ].join("\n");
    expect(output).not.toContain("local-value-must-not-be-used");
    expect(output).not.toContain("REAP_API_BASE_URL");
  });

  it("handles computer-use guidance locally without authentication or HTTP", async () => {
    vi.stubEnv("VM0_TOKEN", "");

    await runDiagnostic(
      "computer-use",
      "POST",
      "https://zero.local/computer-use/list-apps",
    );

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain(
      "Computer Use access is not managed as a connector permission.",
    );
    expect(output).toContain("Existing run tokens cannot be upgraded");
    expect(output).toContain("zero whoami");
    expect(requestCount).toBe(0);
    expect(mockConsoleError).not.toHaveBeenCalled();
  });

  it("does not treat a similar path prefix as computer-use", async () => {
    server.use(stubDiagnostic({ outcome: "unknown-connector" }));

    await expectCommandFailure([
      "node",
      "cli",
      "agent",
      "--method",
      "POST",
      "--url",
      "https://zero.local/computer-useful/list-apps",
    ]);

    expect(requestCount).toBe(1);
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Unknown connector type: agent"),
    );
    expect(mockConsoleLog).not.toHaveBeenCalledWith(
      expect.stringContaining(
        "Computer Use access is not managed as a connector permission.",
      ),
    );
  });

  const localValidationCases: readonly {
    readonly name: string;
    readonly args: readonly string[];
    readonly expectedMessage: string;
  }[] = [
    {
      name: "deprecated path-only input",
      args: [
        "node",
        "cli",
        "slack",
        "--method",
        "GET",
        "--path",
        "/api/conversations.list",
      ],
      expectedMessage: "permission-deny now requires --url",
    },
    {
      name: "missing url",
      args: ["node", "cli", "slack", "--method", "GET"],
      expectedMessage: "permission-deny now requires --url",
    },
    {
      name: "invalid method",
      args: [
        "node",
        "cli",
        "slack",
        "--method",
        "BAD METHOD",
        "--url",
        "https://slack.com/api/conversations.list",
      ],
      expectedMessage: "permission-deny requires --method",
    },
    {
      name: "malformed url",
      args: ["node", "cli", "slack", "--method", "GET", "--url", "not-a-url"],
      expectedMessage: "permission-deny requires --url to be a valid absolute",
    },
    {
      name: "non-http url",
      args: [
        "node",
        "cli",
        "slack",
        "--method",
        "GET",
        "--url",
        "mailto:user@example.com",
      ],
      expectedMessage: "permission-deny requires --url to be a valid absolute",
    },
    {
      name: "userinfo",
      args: [
        "node",
        "cli",
        "slack",
        "--method",
        "GET",
        "--url",
        "https://user:secret@slack.com/api/conversations.list",
      ],
      expectedMessage: "permission-deny requires --url to be a valid absolute",
    },
    {
      name: "authority backslash",
      args: [
        "node",
        "cli",
        "slack",
        "--method",
        "GET",
        "--url",
        "https://slack.com\\evil.example/api/conversations.list",
      ],
      expectedMessage: "permission-deny requires --url to be a valid absolute",
    },
    {
      name: "encoded authority",
      args: [
        "node",
        "cli",
        "slack",
        "--method",
        "GET",
        "--url",
        "https://slack%2ecom/api/conversations.list?token=secret",
      ],
      expectedMessage: "permission-deny requires --url to be a valid absolute",
    },
    {
      name: "unicode authority",
      args: [
        "node",
        "cli",
        "slack",
        "--method",
        "GET",
        "--url",
        "https://slack。com/api/conversations.list?token=secret",
      ],
      expectedMessage: "permission-deny requires --url to be a valid absolute",
    },
    {
      name: "empty authority",
      args: [
        "node",
        "cli",
        "slack",
        "--method",
        "GET",
        "--url",
        "https:///slack.com/api/conversations.list?token=secret",
      ],
      expectedMessage: "permission-deny requires --url to be a valid absolute",
    },
    {
      name: "encoded dot segment",
      args: [
        "node",
        "cli",
        "slack",
        "--method",
        "GET",
        "--url",
        "https://slack.com/api/%2e%2e/admin?token=secret",
      ],
      expectedMessage: "permission-deny cannot diagnose unsafe URL paths",
    },
    {
      name: "raw path backslash",
      args: [
        "node",
        "cli",
        "slack",
        "--method",
        "GET",
        "--url",
        "https://slack.com/api\\admin?token=secret",
      ],
      expectedMessage: "permission-deny cannot diagnose unsafe URL paths",
    },
  ];

  it.each(localValidationCases)(
    "rejects $name before authentication or HTTP",
    async ({ args, expectedMessage }) => {
      await expectCommandFailure(args);

      const output = [
        ...mockConsoleLog.mock.calls.flat(),
        ...mockConsoleError.mock.calls.flat(),
      ].join("\n");
      expect(output).toContain(expectedMessage);
      expect(output).not.toContain("token=secret");
      expect(requestCount).toBe(0);
    },
  );

  it("reports missing local authentication before making a request", async () => {
    vi.stubEnv("VM0_TOKEN", "");
    vi.stubEnv("HOME", "/nonexistent/vm0-permission-deny-test");

    await expectCommandFailure([
      "node",
      "cli",
      "slack",
      "--method",
      "GET",
      "--url",
      "https://slack.com/api/conversations.list",
    ]);

    const output = mockConsoleError.mock.calls.flat().join("\n");
    expect(output).toContain("Not authenticated");
    expect(output).toContain("vm0 auth login");
    expect(requestCount).toBe(0);
  });

  it("surfaces a server authentication failure without fallback", async () => {
    server.use(
      http.post(DIAGNOSTIC_ENDPOINT, () => {
        requestCount++;
        return HttpResponse.json(
          { error: { message: "Expired token", code: "UNAUTHORIZED" } },
          { status: 401 },
        );
      }),
    );

    await expectCommandFailure([
      "node",
      "cli",
      "slack",
      "--method",
      "GET",
      "--url",
      "https://slack.com/api/conversations.list",
    ]);

    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      "Not authenticated",
    );
    expect(requestCount).toBe(1);
    expect(mockConsoleLog).not.toHaveBeenCalled();
  });

  it("surfaces authorization failure without fallback", async () => {
    server.use(
      http.post(DIAGNOSTIC_ENDPOINT, () => {
        requestCount++;
        return HttpResponse.json(
          {
            error: {
              message: "Connector read denied",
              code: "DIAGNOSTIC_FORBIDDEN",
            },
          },
          { status: 403 },
        );
      }),
    );

    await expectCommandFailure([
      "node",
      "cli",
      "slack",
      "--method",
      "GET",
      "--url",
      "https://slack.com/api/conversations.list",
    ]);

    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      "403: Connector read denied",
    );
    expect(requestCount).toBe(1);
    expect(mockConsoleLog).not.toHaveBeenCalled();
  });

  it("surfaces an older server's missing endpoint without fallback", async () => {
    server.use(
      http.post(DIAGNOSTIC_ENDPOINT, () => {
        requestCount++;
        return new HttpResponse("Not Found", { status: 404 });
      }),
    );

    await expectCommandFailure([
      "node",
      "cli",
      "slack",
      "--method",
      "GET",
      "--url",
      "https://slack.com/api/conversations.list",
    ]);

    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      '404: Failed to diagnose permission denial for "slack"',
    );
    expect(requestCount).toBe(1);
    expect(mockConsoleLog).not.toHaveBeenCalled();
  });

  it("surfaces server failures without fallback", async () => {
    server.use(
      http.post(DIAGNOSTIC_ENDPOINT, () => {
        requestCount++;
        return HttpResponse.json(
          {
            error: {
              message: "Diagnostic service failed",
              code: "DIAGNOSTIC_SERVER_ERROR",
            },
          },
          { status: 500 },
        );
      }),
    );

    await expectCommandFailure([
      "node",
      "cli",
      "slack",
      "--method",
      "GET",
      "--url",
      "https://slack.com/api/conversations.list",
    ]);

    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      "500: Diagnostic service failed",
    );
    expect(requestCount).toBe(1);
    expect(mockConsoleLog).not.toHaveBeenCalled();
  });

  it("surfaces network failures without fallback", async () => {
    server.use(
      http.post(DIAGNOSTIC_ENDPOINT, () => {
        requestCount++;
        return HttpResponse.error();
      }),
    );

    await expectCommandFailure([
      "node",
      "cli",
      "slack",
      "--method",
      "GET",
      "--url",
      "https://slack.com/api/conversations.list",
    ]);

    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      "Failed to fetch",
    );
    expect(requestCount).toBe(1);
    expect(mockConsoleLog).not.toHaveBeenCalled();
  });

  it("rejects malformed declared responses through contract validation", async () => {
    server.use(
      http.post(DIAGNOSTIC_ENDPOINT, () => {
        requestCount++;
        return HttpResponse.json({
          outcome: "matched",
          label: "Slack",
        });
      }),
    );

    await expectCommandFailure([
      "node",
      "cli",
      "slack",
      "--method",
      "GET",
      "--url",
      "https://slack.com/api/conversations.list",
    ]);

    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      "Response validation failed",
    );
    expect(requestCount).toBe(1);
    expect(mockConsoleLog).not.toHaveBeenCalled();
  });
});
