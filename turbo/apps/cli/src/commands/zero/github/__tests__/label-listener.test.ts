import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import chalk from "chalk";
import { server } from "../../../../mocks/server";
import { labelListenerCommand } from "../label-listener";

const INSTALLATION_URL = "http://localhost:3000/api/integrations/github";
const LABEL_LISTENERS_URL =
  "http://localhost:3000/api/integrations/github/label-listeners";
const LISTENER_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";

function installationBody() {
  return {
    installation: {
      id: "inst_1",
      installationId: "123",
      status: "active",
      targetName: "vm0-ai",
      targetType: "Organization",
      isAdmin: true,
    },
    isConnected: true,
    connectedGithubUserId: "gh_1",
    connectedGithubUsername: "octocat",
    installUrl: null,
    connectUrl: "http://localhost:3000/connect",
    agent: { id: AGENT_ID, name: "Zero" },
    environment: {
      requiredSecrets: [],
      requiredVars: [],
      missingSecrets: [],
      missingVars: [],
    },
    labelListeners: [
      {
        id: LISTENER_ID,
        labelName: "zero",
        triggerMode: "anyone",
        prompt: "Handle this issue",
        enabled: true,
        canManage: true,
        agent: { id: AGENT_ID, name: "Zero" },
        createdAt: "2026-05-22T00:00:00.000Z",
        updatedAt: "2026-05-22T00:00:00.000Z",
      },
    ],
  };
}

describe("zero github label-listener command", () => {
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("ZERO_TOKEN", undefined);
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  it("lists GitHub label listeners", async () => {
    server.use(
      http.get(INSTALLATION_URL, ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        return HttpResponse.json(installationBody());
      }),
    );

    await labelListenerCommand.parseAsync(["node", "cli", "list"]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain(LISTENER_ID);
    expect(stdout).toContain("zero");
    expect(stdout).toContain("Zero");
    expect(stdout).toContain("anyone");
  });

  it("creates a GitHub label listener", async () => {
    server.use(
      http.post(LABEL_LISTENERS_URL, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        await expect(request.json()).resolves.toMatchObject({
          labelName: "zero",
          agentId: AGENT_ID,
          prompt: "Handle this issue",
          triggerMode: "created_by_me",
          enabled: false,
        });
        return HttpResponse.json(
          { listener: installationBody().labelListeners[0] },
          { status: 201 },
        );
      }),
    );

    await labelListenerCommand.parseAsync([
      "node",
      "cli",
      "create",
      "--label",
      "zero",
      "--agent-id",
      AGENT_ID,
      "--prompt",
      "Handle this issue",
      "--trigger-mode",
      "created_by_me",
      "--disabled",
    ]);

    expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
      `Created GitHub label listener ${LISTENER_ID}`,
    );
  });

  it("updates a GitHub label listener", async () => {
    server.use(
      http.patch(
        `${LABEL_LISTENERS_URL}/${LISTENER_ID}`,
        async ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-token",
          );
          await expect(request.json()).resolves.toMatchObject({
            labelName: "triage",
            enabled: false,
          });
          return HttpResponse.json({
            listener: {
              ...installationBody().labelListeners[0],
              labelName: "triage",
              enabled: false,
            },
          });
        },
      ),
    );

    await labelListenerCommand.parseAsync([
      "node",
      "cli",
      "update",
      LISTENER_ID,
      "--label",
      "triage",
      "--disable",
    ]);

    expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
      `Updated GitHub label listener ${LISTENER_ID}`,
    );
  });

  it("deletes a GitHub label listener", async () => {
    server.use(
      http.delete(`${LABEL_LISTENERS_URL}/${LISTENER_ID}`, ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        return HttpResponse.json({ ok: true });
      }),
    );

    await labelListenerCommand.parseAsync([
      "node",
      "cli",
      "delete",
      LISTENER_ID,
    ]);

    expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
      `Deleted GitHub label listener ${LISTENER_ID}`,
    );
  });
});
