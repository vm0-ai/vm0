import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { setupPage } from "../../../__tests__/page-helper.ts";
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
  });
});
