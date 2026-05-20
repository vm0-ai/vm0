import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { zeroLocalAgentHostsContract } from "@vm0/api-contracts/contracts/zero-local-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function installDesktopLocalAgentApi(
  api: NonNullable<Window["vm0DesktopLocalAgent"]>,
): void {
  Object.defineProperty(window, "vm0DesktopLocalAgent", {
    configurable: true,
    writable: true,
    value: api,
  });
}

afterEach(() => {
  Reflect.deleteProperty(window, "vm0DesktopLocalAgent");
});

describe("zero desktop local agent page", () => {
  it("enables the desktop bridge and renders configured agents", async () => {
    const setEnabled = vi.fn(() => {
      return Promise.resolve();
    });
    let serverHostListCalls = 0;
    server.use(
      mockApi(zeroLocalAgentHostsContract.list, ({ respond }) => {
        serverHostListCalls += 1;
        return respond(200, {
          hosts: [
            {
              id: "host-1",
              displayName: "alpha",
              supportedBackends: ["codex"],
              status: "online",
              lastSeenAt: "2026-05-19T00:00:00.000Z",
              createdAt: "2026-05-19T00:00:00.000Z",
            },
          ],
        });
      }),
    );
    installDesktopLocalAgentApi({
      setEnabled,
      list() {
        return Promise.resolve([
          {
            id: "agent-1",
            name: "alpha",
            folderPath: "/workspace/alpha",
            backend: "codex",
            permissionMode: "workspace-write",
            status: "online",
            hostId: "host-1",
            lastHeartbeatAt: "2026-05-19T00:00:00.000Z",
          },
        ]);
      },
      detectBackends() {
        return Promise.resolve([
          {
            backend: "codex",
            command: "codex",
            available: true,
            executablePath: "/opt/homebrew/bin/codex",
            version: "codex 1.0.0",
          },
        ]);
      },
      add() {
        return Promise.resolve(null);
      },
      start() {
        return Promise.reject(new Error("not used"));
      },
      stop() {
        return Promise.reject(new Error("not used"));
      },
      remove() {
        return Promise.resolve();
      },
      openFolder() {
        return Promise.resolve();
      },
      subscribe() {
        return () => {};
      },
    });

    await setupPage({
      context,
      path: "/local-agents",
      featureSwitches: {
        [FeatureSwitchKey.DesktopLocalAgent]: true,
      },
    });

    await expect(screen.findByText("alpha")).resolves.toBeInTheDocument();
    expect(screen.getByText("/workspace/alpha")).toBeInTheDocument();
    expect(screen.getByText("workspace-write")).toBeInTheDocument();
    expect(screen.getByText("online")).toBeInTheDocument();
    expect(setEnabled).toHaveBeenCalledWith(true);
    expect(serverHostListCalls).toBeGreaterThan(0);
  });

  it("surfaces backend health errors and blocks unavailable backend selection", async () => {
    installDesktopLocalAgentApi({
      setEnabled() {
        return Promise.resolve();
      },
      list() {
        return Promise.resolve([
          {
            id: "agent-1",
            name: "alpha",
            folderPath: "/workspace/alpha",
            backend: "codex",
            permissionMode: "workspace-write",
            status: "error",
            errorMessage: "Codex not found",
          },
        ]);
      },
      detectBackends() {
        return Promise.resolve([
          {
            backend: "codex",
            command: "codex",
            available: false,
            errorMessage: "Codex not found",
          },
          {
            backend: "claude-code",
            command: "claude",
            available: false,
            errorMessage: "Claude Code not found",
          },
        ]);
      },
      add() {
        return Promise.resolve(null);
      },
      start() {
        return Promise.reject(new Error("not used"));
      },
      stop() {
        return Promise.reject(new Error("not used"));
      },
      remove() {
        return Promise.resolve();
      },
      openFolder() {
        return Promise.resolve();
      },
      subscribe() {
        return () => {};
      },
    });

    await setupPage({
      context,
      path: "/local-agents",
      featureSwitches: {
        [FeatureSwitchKey.DesktopLocalAgent]: true,
      },
    });

    await expect(screen.findByText("alpha")).resolves.toBeInTheDocument();
    expect(screen.getByText("Codex not found")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByText("Add local agent"));

    await expect(screen.findAllByText("Codex not found")).resolves.toHaveLength(
      2,
    );
    const selectFolderButton = screen
      .getByText("Select folder")
      .closest("button");
    if (!selectFolderButton) {
      throw new Error("Expected Select folder button");
    }
    expect(selectFolderButton).toBeDisabled();
  });
});
