/**
 * Tests for the /settings/slack page (ZeroSlackConnectPage).
 *
 * Entry point: setupPage({ path: "/settings/slack?..." })
 * Mock (external): Slack connect API via MSW
 * Real (internal): signals, components, rendering
 */

import { afterEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { zeroSlackConnectContract } from "@vm0/core";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  setMockSlackConnectData,
  resetMockSlackConnect,
} from "../../../mocks/handlers/api-integrations-slack-connect.ts";

const context = testContext();
const mockApi = createMockApi(context);

afterEach(() => {
  resetMockSlackConnect();
  // Reset location after tests that trigger slack:// redirects via signal code
  // (e.g. ?status=connected param or successful connect button click)
  if (!window.location.href.startsWith("http://localhost")) {
    window.location.href = "http://localhost/settings/slack";
  }
});

// CONN-D-050: Status indicator is displayed
describe("zero-slack-connect-page - connection status indicator (CONN-D-050)", () => {
  it("shows a connection failed indicator when error param is present", async () => {
    detachedSetupPage({
      context,
      path: "/settings/slack?error=Something+went+wrong",
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Connection Failed" }),
      ).toBeInTheDocument();
    });
  });
});

// CONN-D-051: Status icon is displayed
describe("zero-slack-connect-page - status icon (CONN-D-051)", () => {
  it("shows success heading when connected", async () => {
    setMockSlackConnectData({ isConnected: true });
    detachedSetupPage({ context, path: "/settings/slack?w=ws1&u=u1" });

    await waitFor(() => {
      // Success state: IconCircleCheck rendered, heading "Connected to Slack!" present
      expect(
        screen.getByRole("heading", { name: "Connected to Slack!" }),
      ).toBeInTheDocument();
    });
  });
});

// CONN-D-052: Status message is shown
describe("zero-slack-connect-page - status message (CONN-D-052)", () => {
  it("shows a descriptive message for the current connection state", async () => {
    detachedSetupPage({ context, path: "/settings/slack?w=ws1&u=u1" });

    await waitFor(() => {
      // Idle state (after checking): shows connect confirmation message
      expect(
        screen.getByText(/Link your account to this Slack workspace/i),
      ).toBeInTheDocument();
    });
  });
});

// CONN-D-053: Workspace name on success
describe("zero-slack-connect-page - workspace name on success (CONN-D-053)", () => {
  it("displays the connected workspace name when status=connected and workspace param is set", async () => {
    detachedSetupPage({
      context,
      path: "/settings/slack?status=connected&workspace=My+Team",
    });

    await waitFor(() => {
      expect(
        screen.getByText(/You're connected to My Team/),
      ).toBeInTheDocument();
    });
  });
});

// CONN-D-054: Error message on failure
describe("zero-slack-connect-page - error message on failure (CONN-D-054)", () => {
  it("displays the error message from the error URL param", async () => {
    detachedSetupPage({
      context,
      path: "/settings/slack?error=Account+already+linked",
    });

    await waitFor(() => {
      expect(screen.getByText("Account already linked")).toBeInTheDocument();
    });
  });
});

// CONN-N-055: Back to settings navigation
describe("zero-slack-connect-page - back to settings link (CONN-N-055)", () => {
  it("back link navigates to /works", async () => {
    detachedSetupPage({ context, path: "/settings/slack?w=ws1&u=u1" });

    await waitFor(() => {
      const link = screen.getAllByRole("link").find((el) => {
        return /Back to settings/i.test(el.textContent ?? "");
      });
      expect(link).toBeDefined();
      expect(link).toHaveAttribute("href", "/works");
    });
  });
});

// CONN-I-056: Connect button initiates Slack connection
describe("zero-slack-connect-page - connect button (CONN-I-056)", () => {
  it("clicking Connect submits the workspace and user IDs to the Slack connect API", async () => {
    let submittedBody: unknown;

    server.use(
      mockApi(zeroSlackConnectContract.connect, ({ body, respond }) => {
        submittedBody = body;
        return respond(200, {
          success: true,
          connectionId: "conn-001",
          role: "member",
        });
      }),
    );

    detachedSetupPage({ context, path: "/settings/slack?w=ws1&u=u1" });

    // Wait for the idle connect state (init checking has completed)
    await waitFor(() => {
      expect(
        screen.getByText(/Link your account to this Slack workspace/i),
      ).toBeInTheDocument();
    });

    const connectButton = screen.getAllByRole("button").find((el) => {
      return /^Connect$/i.test(el.textContent ?? "");
    })!;

    click(connectButton);

    await waitFor(() => {
      expect(submittedBody).toMatchObject({
        workspaceId: "ws1",
        slackUserId: "u1",
      });
    });
  });
});

// CONN-I-057: Open Slack button navigates to slack://open on click
describe("zero-slack-connect-page - open slack button on success (CONN-I-057)", () => {
  it("clicking Open Slack button sets window.location.href to slack://open", async () => {
    // Use isConnected: true via mock API to get success state without URL-triggered redirect
    setMockSlackConnectData({ isConnected: true });
    detachedSetupPage({ context, path: "/settings/slack?w=ws1&u=u1" });

    const openSlackBtn = await waitFor(() => {
      const btn = screen.getAllByRole("button").find((el) => {
        return /Open Slack/i.test(el.textContent ?? "");
      });
      expect(btn).toBeDefined();
      return btn!;
    });

    click(openSlackBtn);

    expect(window.location.href).toBe("slack://open");
  });
});
