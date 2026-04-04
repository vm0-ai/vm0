/**
 * Tests for the /settings/slack page (ZeroSlackConnectPage).
 *
 * Entry point: setupPage({ path: "/settings/slack?..." })
 * Mock (external): Slack connect API via MSW
 * Real (internal): signals, components, rendering
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  setMockSlackConnectData,
  resetMockSlackConnect,
} from "../../../mocks/handlers/api-integrations-slack-connect.ts";

const context = testContext();

afterEach(() => {
  vi.restoreAllMocks();
  resetMockSlackConnect();
  // Reset location if redirected to slack:// scheme by signal code
  if (!window.location.href.startsWith("http://localhost")) {
    window.location.href = "http://localhost/settings/slack";
  }
});

// CONN-D-050: Status indicator is displayed
describe("zero-slack-connect-page - connection status indicator (CONN-D-050)", () => {
  it("shows a connection failed indicator when error param is present", async () => {
    await setupPage({
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
  it("shows success icon when connected", async () => {
    setMockSlackConnectData({ isConnected: true });
    await setupPage({ context, path: "/settings/slack?w=ws1&u=u1" });

    await waitFor(() => {
      // Success state: IconCircleCheck rendered, heading "Connected to Slack!" present
      expect(
        screen.getByRole("heading", { name: "Connected to Slack!" }),
      ).toBeInTheDocument();
    });
  });

  it("shows error icon when error param is present", async () => {
    await setupPage({ context, path: "/settings/slack?error=Auth+failed" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Connection Failed" }),
      ).toBeInTheDocument();
    });
  });
});

// CONN-D-052: Status message is shown
describe("zero-slack-connect-page - status message (CONN-D-052)", () => {
  it("shows a descriptive message for the current connection state", async () => {
    await setupPage({ context, path: "/settings/slack?w=ws1&u=u1" });

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
    await setupPage({
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
    await setupPage({
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
    await setupPage({ context, path: "/settings/slack?w=ws1&u=u1" });

    await waitFor(() => {
      const link = screen.getByRole("link", { name: /Back to settings/i });
      expect(link).toHaveAttribute("href", "/works");
    });
  });
});

// CONN-I-056: Connect button initiates Slack connection
describe("zero-slack-connect-page - connect button (CONN-I-056)", () => {
  it("clicking Connect submits the workspace and user IDs to the Slack connect API", async () => {
    const user = userEvent.setup();
    let submittedBody: Record<string, string> | undefined;

    server.use(
      http.post(
        "*/api/zero/integrations/slack/connect",
        async ({ request }) => {
          submittedBody = (await request.json()) as Record<string, string>;
          return HttpResponse.json({
            success: true,
            connectionId: "conn-001",
            role: "member",
          });
        },
      ),
    );

    await setupPage({ context, path: "/settings/slack?w=ws1&u=u1" });

    const connectButton = await waitFor(() => {
      return screen.getByRole("button", { name: /^Connect$/i });
    });

    await user.click(connectButton);

    await waitFor(() => {
      expect(submittedBody).toBeDefined();
      expect(submittedBody?.workspaceId).toBe("ws1");
      expect(submittedBody?.slackUserId).toBe("u1");
    });
  });
});

// CONN-I-057: Open Slack button appears on success
describe("zero-slack-connect-page - open slack button on success (CONN-I-057)", () => {
  it("shows an Open Slack button when already connected and it is clickable", async () => {
    const user = userEvent.setup();

    // Use isConnected: true via mock API to get success state without URL-triggered redirect
    setMockSlackConnectData({ isConnected: true });
    await setupPage({ context, path: "/settings/slack?w=ws1&u=u1" });

    const openSlackBtn = await waitFor(() => {
      return screen.getByRole("button", { name: /Open Slack/i });
    });
    expect(openSlackBtn).toBeInTheDocument();

    await user.click(openSlackBtn);

    await waitFor(() => {
      expect(window.location.href).toBe("slack://open");
    });
  });
});
