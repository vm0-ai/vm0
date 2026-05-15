import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import chalk from "chalk";

import { server } from "../../../../mocks/server";
import { zeroLocalBrowserCommand } from "../index";

describe("zero local-browser command", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    vi.unstubAllEnvs();
  });

  it("lists linked local-browser hosts", async () => {
    server.use(
      http.get("http://localhost:3000/api/zero/local-browser/hosts", () => {
        return HttpResponse.json({
          hosts: [
            {
              id: "host_1",
              displayName: "Desk Chrome",
              browser: "chrome",
              extensionVersion: "0.3.0",
              supportedCapabilities: ["tabs.list", "page.click"],
              status: "online",
              lastSeenAt: "2026-05-15T06:00:00.000Z",
              createdAt: "2026-05-15T05:00:00.000Z",
            },
          ],
        });
      }),
    );

    await zeroLocalBrowserCommand.parseAsync(["node", "cli", "hosts", "list"]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("online");
    expect(output).toContain("Desk Chrome");
    expect(output).toContain("host_1");
    expect(output).toContain("tabs.list, page.click");
  });

  it("revokes a linked local-browser host", async () => {
    let revokedHostId: string | null = null;
    server.use(
      http.delete(
        "http://localhost:3000/api/zero/local-browser/hosts/:hostId",
        ({ params }) => {
          revokedHostId = String(params.hostId);
          return HttpResponse.json({ ok: true });
        },
      ),
    );

    await zeroLocalBrowserCommand.parseAsync([
      "node",
      "cli",
      "hosts",
      "revoke",
      "host_1",
    ]);

    expect(revokedHostId).toBe("host_1");
    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Local-browser host revoked");
  });

  it("lists local-browser audit events with filters", async () => {
    let requestUrl: string | null = null;
    server.use(
      http.get(
        "http://localhost:3000/api/zero/local-browser/audit-events",
        ({ request }) => {
          requestUrl = request.url;
          return HttpResponse.json({
            auditEvents: [
              {
                id: "audit_1",
                commandId: "cmd_1",
                runId: "run_1",
                hostId: "host_1",
                tabId: "tab_1",
                kind: "page.click",
                targetUrl: "https://example.com",
                event: "completed",
                approvalOutcome: null,
                redactedResult: { ok: true },
                error: null,
                createdAt: "2026-05-15T06:00:00.000Z",
              },
            ],
          });
        },
      ),
    );

    await zeroLocalBrowserCommand.parseAsync([
      "node",
      "cli",
      "audit",
      "list",
      "--host-id",
      "host_1",
      "--limit",
      "5",
    ]);

    expect(requestUrl).toContain("hostId=host_1");
    expect(requestUrl).toContain("limit=5");
    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("completed");
    expect(output).toContain("page.click");
    expect(output).toContain("command=cmd_1");
  });
});
