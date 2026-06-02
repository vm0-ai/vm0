/**
 * Tests for zero connector connect command
 *
 * Tests command-level behavior via parseAsync():
 * - Entry point: command.parseAsync()
 * - Mock external API with MSW
 * - Exercise real parsing, API client, and output formatting
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import chalk from "chalk";

import { server } from "../../../../mocks/server";
import { connectCommand } from "../connect";

function connectorResponse(type: string) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    type,
    authMethod: "api-token",
    externalId: null,
    externalUsername: null,
    externalEmail: null,
    oauthScopes: null,
    needsReconnect: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("zero connector connect command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  it("connects a connector with repeated value flags", async () => {
    let receivedBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/zero/connectors/:type/manual-grant",
        async ({ params, request }) => {
          receivedBody = await request.json();
          return HttpResponse.json(connectorResponse(String(params.type)));
        },
      ),
    );

    await connectCommand.parseAsync([
      "node",
      "cli",
      "zendesk",
      "--value",
      "ZENDESK_API_TOKEN=secret-token",
      "--value",
      "ZENDESK_SUBDOMAIN=example",
      "--value",
      "ZENDESK_EMAIL=support@example.com",
    ]);

    expect(receivedBody).toStrictEqual({
      authMethod: "api-token",
      values: {
        ZENDESK_API_TOKEN: "secret-token",
        ZENDESK_SUBDOMAIN: "example",
        ZENDESK_EMAIL: "support@example.com",
      },
    });
    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Zendesk connected");
    expect(output).toContain("zero connector status zendesk");
    expect(output).not.toContain("secret-token");
  });

  it("connects with an explicit manual grant auth method", async () => {
    let receivedBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/zero/connectors/:type/manual-grant",
        async ({ params, request }) => {
          receivedBody = await request.json();
          return HttpResponse.json(connectorResponse(String(params.type)));
        },
      ),
    );

    await connectCommand.parseAsync([
      "node",
      "cli",
      "stripe",
      "--auth-method",
      "api-token",
      "--value",
      "STRIPE_TOKEN=sk-test",
    ]);

    expect(receivedBody).toStrictEqual({
      authMethod: "api-token",
      values: {
        STRIPE_TOKEN: "sk-test",
      },
    });
  });

  it("prints JSON output when requested", async () => {
    server.use(
      http.post(
        "http://localhost:3000/api/zero/connectors/:type/manual-grant",
        ({ params }) => {
          return HttpResponse.json(connectorResponse(String(params.type)));
        },
      ),
    );

    await connectCommand.parseAsync([
      "node",
      "cli",
      "openai",
      "--value",
      "OPENAI_TOKEN=sk-test",
      "--json",
    ]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(JSON.parse(output)).toMatchObject({
      type: "openai",
      authMethod: "api-token",
    });
  });

  it("fails with usage guidance when no values are provided", async () => {
    await expect(
      connectCommand.parseAsync(["node", "cli", "openai"]),
    ).rejects.toThrow("process.exit called");

    const errorOutput = mockConsoleError.mock.calls.flat().join("\n");
    expect(errorOutput).toContain(
      "At least one --value NAME=VALUE is required",
    );
    expect(errorOutput).toContain("zero connector connect zendesk");
  });

  it("fails before the request for malformed values", async () => {
    let requestCalled = false;
    server.use(
      http.post(
        "http://localhost:3000/api/zero/connectors/:type/manual-grant",
        () => {
          requestCalled = true;
          return HttpResponse.json(connectorResponse("openai"));
        },
      ),
    );

    await expect(
      connectCommand.parseAsync([
        "node",
        "cli",
        "openai",
        "--value",
        "OPENAI_TOKEN",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(requestCalled).toBeFalsy();
    const errorOutput = mockConsoleError.mock.calls.flat().join("\n");
    expect(errorOutput).toContain("Invalid --value format");
    expect(errorOutput).toContain("Use --value NAME=VALUE");
  });

  it("fails before the request when the selected auth method is not configured", async () => {
    let requestCalled = false;
    server.use(
      http.post(
        "http://localhost:3000/api/zero/connectors/:type/manual-grant",
        () => {
          requestCalled = true;
          return HttpResponse.json(connectorResponse("github"));
        },
      ),
    );

    await expect(
      connectCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--auth-method",
        "api-token",
        "--value",
        "GITHUB_TOKEN=ghp-test",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(requestCalled).toBeFalsy();
    const errorOutput = mockConsoleError.mock.calls.flat().join("\n");
    expect(errorOutput).toContain(
      "github connector does not have api-token auth method",
    );
    expect(errorOutput).not.toContain("ghp-test");
  });

  it("fails before the request when the selected auth method is not a manual grant", async () => {
    let requestCalled = false;
    server.use(
      http.post(
        "http://localhost:3000/api/zero/connectors/:type/manual-grant",
        () => {
          requestCalled = true;
          return HttpResponse.json(connectorResponse("stripe"));
        },
      ),
    );

    await expect(
      connectCommand.parseAsync([
        "node",
        "cli",
        "stripe",
        "--auth-method",
        "oauth",
        "--value",
        "STRIPE_TOKEN=sk-test",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(requestCalled).toBeFalsy();
    const errorOutput = mockConsoleError.mock.calls.flat().join("\n");
    expect(errorOutput).toContain(
      "stripe oauth auth method does not use a manual grant",
    );
    expect(errorOutput).not.toContain("sk-test");
  });

  it("surfaces API validation errors without printing secret values", async () => {
    server.use(
      http.post(
        "http://localhost:3000/api/zero/connectors/:type/manual-grant",
        () => {
          return HttpResponse.json(
            {
              error: {
                message:
                  "Missing required manual grant field(s): ZENDESK_EMAIL",
                code: "BAD_REQUEST",
              },
            },
            { status: 400 },
          );
        },
      ),
    );

    await expect(
      connectCommand.parseAsync([
        "node",
        "cli",
        "zendesk",
        "--value",
        "ZENDESK_API_TOKEN=secret-token",
      ]),
    ).rejects.toThrow("process.exit called");

    const errorOutput = mockConsoleError.mock.calls.flat().join("\n");
    expect(errorOutput).toContain("Missing required manual grant field");
    expect(errorOutput).not.toContain("secret-token");
  });

  it("surfaces unavailable connector errors without printing secret values", async () => {
    server.use(
      http.post(
        "http://localhost:3000/api/zero/connectors/:type/manual-grant",
        () => {
          return HttpResponse.json(
            {
              error: {
                message: "Connector is not available",
                code: "FORBIDDEN",
              },
            },
            { status: 403 },
          );
        },
      ),
    );

    await expect(
      connectCommand.parseAsync([
        "node",
        "cli",
        "zendesk",
        "--value",
        "ZENDESK_API_TOKEN=secret-token",
      ]),
    ).rejects.toThrow("process.exit called");

    const errorOutput = mockConsoleError.mock.calls.flat().join("\n");
    expect(errorOutput).toContain("Connector is not available");
    expect(errorOutput).not.toContain("secret-token");
  });
});
