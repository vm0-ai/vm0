import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { zeroComputerUseAuthorizationRequestsContract } from "@vm0/api-contracts/contracts/zero-computer-use";

import {
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function replaceNavigatorProperty(property: string, value: unknown): void {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, property);
  Object.defineProperty(navigator, property, {
    configurable: true,
    value,
  });
  context.signal.addEventListener(
    "abort",
    () => {
      if (descriptor) {
        Object.defineProperty(navigator, property, descriptor);
        return;
      }
      Reflect.deleteProperty(navigator, property);
    },
    { once: true },
  );
}

function mockMacUserAgentData(architecture: string): void {
  replaceNavigatorProperty("userAgentData", {
    platform: "macOS",
    getHighEntropyValues: () => {
      return Promise.resolve({ architecture, platform: "macOS" });
    },
  });
}

function linkByText(text: string): HTMLElement {
  const link = queryAllByRoleFast("link").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!link) {
    throw new Error(`${text} link not found`);
  }
  return link;
}

function queryLinkByText(text: string): HTMLElement | null {
  return (
    queryAllByRoleFast("link").find((candidate) => {
      return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
    }) ?? null
  );
}

function buttonByText(text: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

function computerUsePermissions() {
  return {
    accessibility: true,
    screenRecording: true,
    automation: {
      chrome: { status: "unknown" as const, updatedAt: null, reason: null },
      safari: { status: "unknown" as const, updatedAt: null, reason: null },
    },
  };
}

function computerUseHost(args: {
  readonly id: string;
  readonly displayName: string;
  readonly status: "online" | "offline";
}) {
  return {
    id: args.id,
    displayName: args.displayName,
    appVersion: "1.0.0",
    osVersion: "macOS 15.0",
    supportedCapabilities: ["app.open"],
    permissions: computerUsePermissions(),
    status: args.status,
    lastSeenAt: "2026-06-10T12:00:00Z",
    createdAt: "2026-06-10T11:00:00Z",
  };
}

describe("computer use authorization page", () => {
  it("shows only online hosts and applies the selected host", async () => {
    const user = userEvent.setup({ delay: null });
    let appliedHostId: string | null = null;
    let completedHostId: string | null = null;

    context.mocks.api(
      zeroComputerUseAuthorizationRequestsContract.get,
      ({ respond }) => {
        return respond(200, {
          source: "chat",
          expiresAt: "2026-06-25T12:00:00Z",
          completedAt: completedHostId ? "2026-06-25T11:00:00Z" : null,
          computerUseHostId: completedHostId,
          hosts: [
            computerUseHost({
              id: "00000000-0000-4000-a000-000000000001",
              displayName: "Studio Mac",
              status: "online",
            }),
            computerUseHost({
              id: "00000000-0000-4000-a000-000000000004",
              displayName: "Travel Mac",
              status: "online",
            }),
            computerUseHost({
              id: "00000000-0000-4000-a000-000000000002",
              displayName: "Offline Desktop",
              status: "offline",
            }),
          ],
        });
      },
    );
    context.mocks.api(
      zeroComputerUseAuthorizationRequestsContract.apply,
      ({ body, respond }) => {
        appliedHostId = body.computerUseHostId;
        completedHostId = body.computerUseHostId;
        return respond(200, {
          ok: true,
          source: "chat",
          computerUseHostId: body.computerUseHostId,
        });
      },
    );

    detachedSetupPage({
      context,
      path: "/computer-use/authorize/vm0_computer_use_authorization_request_test",
    });

    await expect(
      screen.findByRole("heading", { name: "Authorize computer use" }),
    ).resolves.toBeInTheDocument();
    expect(
      screen.getByText(
        "Choose an online computer for Zero to use in this chat thread.",
      ),
    ).toBeInTheDocument();
    await expect(screen.findByText("Studio Mac")).resolves.toBeInTheDocument();
    expect(screen.getByText("Travel Mac")).toBeInTheDocument();
    expect(screen.queryByText("Offline Desktop")).not.toBeInTheDocument();

    const authorizeButton = queryAllByRoleFast("button").find((button) => {
      return button.textContent === "Authorize";
    });
    expect(authorizeButton).toBeDefined();
    await user.click(authorizeButton!);

    await waitFor(() => {
      expect(appliedHostId).toBe("00000000-0000-4000-a000-000000000001");
    });
    await waitFor(() => {
      expect(
        queryAllByRoleFast("button").filter((button) => {
          return button.textContent === "Authorized";
        }),
      ).toHaveLength(1);
    });
    const authorizedButton = queryAllByRoleFast("button").find((button) => {
      return button.textContent === "Authorized";
    });
    expect(authorizedButton).toBeDisabled();
    const remainingAuthorizeButtons = queryAllByRoleFast("button").filter(
      (button) => {
        return button.textContent === "Authorize";
      },
    );
    expect(remainingAuthorizeButtons).toHaveLength(1);
    expect(remainingAuthorizeButtons[0]).toBeDisabled();
  });

  it("shows desktop guidance when there are no online hosts", async () => {
    context.mocks.api(
      zeroComputerUseAuthorizationRequestsContract.get,
      ({ respond }) => {
        return respond(200, {
          source: "slack",
          expiresAt: "2026-06-25T12:00:00Z",
          completedAt: null,
          computerUseHostId: null,
          hosts: [
            computerUseHost({
              id: "00000000-0000-4000-a000-000000000003",
              displayName: "Offline Desktop",
              status: "offline",
            }),
          ],
        });
      },
    );

    detachedSetupPage({
      context,
      path: "/computer-use/authorize/vm0_computer_use_authorization_request_empty",
    });

    await expect(
      screen.findByText("No online computers"),
    ).resolves.toBeInTheDocument();
    expect(
      screen.getByText(
        "Open Zero Computer Use on your Mac and refresh this page when it comes online.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Zero Computer Use currently supports Apple Silicon Macs only.",
      ),
    ).toBeInTheDocument();
    const downloadLink = await waitFor(() => {
      return linkByText("Download for macOS");
    });
    expect(downloadLink).toHaveAttribute(
      "href",
      expect.stringContaining(
        "/api/zero/desktop/updates/stable/darwin/arm64/dmg",
      ),
    );
    expect(screen.queryByText("Offline Desktop")).not.toBeInTheDocument();
  });

  it("blocks the desktop download when the browser identifies an Intel Mac", async () => {
    mockMacUserAgentData("x86");
    context.mocks.api(
      zeroComputerUseAuthorizationRequestsContract.get,
      ({ respond }) => {
        return respond(200, {
          source: "slack",
          expiresAt: "2026-06-25T12:00:00Z",
          completedAt: null,
          computerUseHostId: null,
          hosts: [],
        });
      },
    );

    detachedSetupPage({
      context,
      path: "/computer-use/authorize/vm0_computer_use_authorization_request_intel",
    });

    await expect(
      screen.findByText("No online computers"),
    ).resolves.toBeInTheDocument();
    const requiredButton = await waitFor(() => {
      return buttonByText("Apple Silicon Mac required");
    });
    expect(requiredButton).toBeDisabled();
    expect(queryLinkByText("Download for macOS")).not.toBeInTheDocument();
  });
});
