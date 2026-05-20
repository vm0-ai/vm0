import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

type TestDesktopComputerUseState = Awaited<
  ReturnType<NonNullable<Window["vm0DesktopComputerUse"]>["getState"]>
>;

function installDesktopComputerUseApi(
  api: NonNullable<Window["vm0DesktopComputerUse"]>,
): void {
  Object.defineProperty(window, "vm0DesktopComputerUse", {
    configurable: true,
    writable: true,
    value: api,
  });
}

function computerUseState(): TestDesktopComputerUseState {
  return {
    featureSwitchKey: "computerUse",
    platform: "darwin",
    supported: true,
    permissions: {
      accessibility: false,
      screenRecording: true,
    },
    host: {
      status: "online",
      hostId: "host-1",
      lastHeartbeatAt: "2026-05-20T00:00:00.000Z",
      lastCommandAt: "2026-05-20T00:01:00.000Z",
      lastError: null,
      pendingApprovals: [
        {
          commandId: "command-1",
          kind: "element.click",
          app: "Safari",
          createdAt: "2026-05-20T00:02:00.000Z",
        },
      ],
      recentAuditEvents: [
        {
          commandId: "command-1",
          kind: "element.click",
          app: "Safari",
          event: "created",
          approvalOutcome: null,
          createdAt: "2026-05-20T00:02:00.000Z",
        },
      ],
    },
  };
}

function idleComputerUseState(): TestDesktopComputerUseState {
  return {
    ...computerUseState(),
    permissions: {
      accessibility: true,
      screenRecording: false,
    },
    host: {
      status: "idle",
      hostId: null,
      lastHeartbeatAt: null,
      lastCommandAt: null,
      lastError: null,
      pendingApprovals: [],
      recentAuditEvents: [],
    },
  };
}

function buttonByText(text: string, index = 0): HTMLButtonElement {
  const button = screen.getAllByText(text)[index]?.closest("button");
  expect(button).toBeInstanceOf(HTMLButtonElement);
  return button as HTMLButtonElement;
}

afterEach(() => {
  Reflect.deleteProperty(window, "vm0DesktopComputerUse");
});

describe("zero desktop Computer Use page", () => {
  it("renders desktop permissions, runtime state, and approval actions", async () => {
    const user = userEvent.setup();
    const state = computerUseState();
    const decideCommand = vi.fn(() => {
      return Promise.resolve(state);
    });
    installDesktopComputerUseApi({
      getState() {
        return Promise.resolve(state);
      },
      start() {
        return Promise.resolve(state);
      },
      requestAccessibilityPermission() {
        return Promise.resolve(state);
      },
      openAccessibilitySettings() {
        return Promise.resolve();
      },
      openScreenRecordingSettings() {
        return Promise.resolve();
      },
      decideCommand,
      subscribe() {
        return () => {};
      },
    });

    await setupPage({
      context,
      path: "/computer-use",
      featureSwitches: {
        [FeatureSwitchKey.ComputerUse]: true,
      },
    });

    await expect(
      screen.findByRole("heading", { name: "Computer Use" }),
    ).resolves.toBeInTheDocument();
    expect(screen.getByText("Accessibility")).toBeInTheDocument();
    expect(screen.getByText("Screen Recording")).toBeInTheDocument();
    expect(screen.getByText("missing")).toBeInTheDocument();
    expect(screen.getByText("granted")).toBeInTheDocument();
    expect(screen.getByText("host-1")).toBeInTheDocument();
    expect(screen.getAllByText("element.click")[0]).toBeInTheDocument();
    expect(screen.getAllByText("Safari")[0]).toBeInTheDocument();

    const approveButton = screen.getByText("Approve").closest("button");
    expect(approveButton).toBeInstanceOf(HTMLButtonElement);
    await user.click(approveButton as HTMLButtonElement);

    await waitFor(() => {
      expect(decideCommand).toHaveBeenCalledWith({
        commandId: "command-1",
        decision: "approve",
      });
    });
  });

  it("runs native permission onboarding actions", async () => {
    const user = userEvent.setup();
    const state = computerUseState();
    const requestAccessibilityPermission = vi.fn(() => {
      return Promise.resolve(state);
    });
    const openAccessibilitySettings = vi.fn(() => {
      return Promise.resolve();
    });
    const openScreenRecordingSettings = vi.fn(() => {
      return Promise.resolve();
    });
    installDesktopComputerUseApi({
      getState() {
        return Promise.resolve(state);
      },
      start() {
        return Promise.resolve(state);
      },
      requestAccessibilityPermission,
      openAccessibilitySettings,
      openScreenRecordingSettings,
      decideCommand() {
        return Promise.resolve(state);
      },
      subscribe() {
        return () => {};
      },
    });

    await setupPage({
      context,
      path: "/computer-use",
      featureSwitches: {
        [FeatureSwitchKey.ComputerUse]: true,
      },
    });

    await screen.findByRole("heading", { name: "Computer Use" });

    await user.click(buttonByText("Request access"));
    await waitFor(() => {
      expect(requestAccessibilityPermission).toHaveBeenCalledOnce();
    });

    await waitFor(() => {
      expect(buttonByText("Open settings")).toBeEnabled();
    });
    await user.click(buttonByText("Open settings"));

    await waitFor(() => {
      expect(openAccessibilitySettings).toHaveBeenCalledOnce();
    });

    await waitFor(() => {
      expect(buttonByText("Open settings", 1)).toBeEnabled();
    });
    await user.click(buttonByText("Open settings", 1));

    await waitFor(() => {
      expect(openScreenRecordingSettings).toHaveBeenCalledOnce();
    });
  });

  it("starts the desktop host manually without making Refresh a start action", async () => {
    const user = userEvent.setup();
    const onlineState = computerUseState();
    let state = idleComputerUseState();
    const start = vi.fn(() => {
      state = onlineState;
      return Promise.resolve(state);
    });
    installDesktopComputerUseApi({
      getState() {
        return Promise.resolve(state);
      },
      start,
      requestAccessibilityPermission() {
        return Promise.resolve(state);
      },
      openAccessibilitySettings() {
        return Promise.resolve();
      },
      openScreenRecordingSettings() {
        return Promise.resolve();
      },
      decideCommand() {
        return Promise.resolve(state);
      },
      subscribe() {
        return () => {};
      },
    });

    await setupPage({
      context,
      path: "/computer-use",
      featureSwitches: {
        [FeatureSwitchKey.ComputerUse]: true,
      },
    });

    await screen.findByRole("heading", { name: "Computer Use" });
    expect(screen.getByText("Host is not connected.")).toBeInTheDocument();

    await user.click(buttonByText("Refresh"));
    expect(start).not.toHaveBeenCalled();

    await user.click(buttonByText("Start Computer Use"));
    await waitFor(() => {
      expect(start).toHaveBeenCalledOnce();
    });
    await expect(screen.findByText("host-1")).resolves.toBeInTheDocument();
  });

  it("shows an actionable unauthenticated state with manual retry", async () => {
    const user = userEvent.setup();
    const state = {
      ...idleComputerUseState(),
      host: {
        ...idleComputerUseState().host,
        status: "unauthenticated" as const,
        lastError:
          "Desktop host could not authenticate with the API session. Sign in and retry.",
      },
    };
    const start = vi.fn(() => {
      return Promise.resolve(state);
    });
    installDesktopComputerUseApi({
      getState() {
        return Promise.resolve(state);
      },
      start,
      requestAccessibilityPermission() {
        return Promise.resolve(state);
      },
      openAccessibilitySettings() {
        return Promise.resolve();
      },
      openScreenRecordingSettings() {
        return Promise.resolve();
      },
      decideCommand() {
        return Promise.resolve(state);
      },
      subscribe() {
        return () => {};
      },
    });

    await setupPage({
      context,
      path: "/computer-use",
      featureSwitches: {
        [FeatureSwitchKey.ComputerUse]: true,
      },
    });

    await expect(
      screen.findByText(
        "Desktop host could not authenticate with the API session. Sign in to Zero Desktop, then retry.",
      ),
    ).resolves.toBeInTheDocument();

    await user.click(buttonByText("Retry connection"));
    await waitFor(() => {
      expect(start).toHaveBeenCalledOnce();
    });
  });

  it("redirects when the native desktop bridge is unavailable", async () => {
    await setupPage({
      context,
      path: "/computer-use",
      featureSwitches: {
        [FeatureSwitchKey.ComputerUse]: true,
      },
    });

    await waitFor(() => {
      expect(window.location.pathname).toBe("/");
    });
  });
});
