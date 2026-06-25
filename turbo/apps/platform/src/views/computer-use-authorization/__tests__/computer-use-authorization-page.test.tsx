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
    permissions: { accessibility: true, screenRecording: true },
    status: args.status,
    lastSeenAt: "2026-06-10T12:00:00Z",
    createdAt: "2026-06-10T11:00:00Z",
  };
}

describe("computer use authorization page", () => {
  it("shows only online hosts and applies the selected host", async () => {
    const user = userEvent.setup({ delay: null });
    let appliedHostId: string | null = null;

    context.mocks.api(
      zeroComputerUseAuthorizationRequestsContract.get,
      ({ respond }) => {
        return respond(200, {
          source: "chat",
          expiresAt: "2026-06-25T12:00:00Z",
          completedAt: null,
          hosts: [
            computerUseHost({
              id: "00000000-0000-4000-a000-000000000001",
              displayName: "Studio Mac",
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
    expect(screen.queryByText("Offline Desktop")).not.toBeInTheDocument();

    const authorizeButton = queryAllByRoleFast("button").find((button) => {
      return button.textContent === "Authorize";
    });
    expect(authorizeButton).toBeDefined();
    await user.click(authorizeButton!);

    await waitFor(() => {
      expect(appliedHostId).toBe("00000000-0000-4000-a000-000000000001");
    });
  });

  it("shows desktop guidance when there are no online hosts", async () => {
    context.mocks.api(
      zeroComputerUseAuthorizationRequestsContract.get,
      ({ respond }) => {
        return respond(200, {
          source: "slack",
          expiresAt: "2026-06-25T12:00:00Z",
          completedAt: null,
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
    const downloadLink = queryAllByRoleFast("link").find((link) => {
      return link.textContent === "Download for macOS";
    });
    expect(downloadLink).toHaveAttribute(
      "href",
      expect.stringContaining(
        "/api/zero/desktop/updates/stable/darwin/arm64/dmg",
      ),
    );
    expect(screen.queryByText("Offline Desktop")).not.toBeInTheDocument();
  });
});
