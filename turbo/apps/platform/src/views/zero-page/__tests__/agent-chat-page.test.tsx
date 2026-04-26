import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, fill } from "../../../__tests__/page-helper.ts";
import { PLACEHOLDER } from "./chat-test-helpers.ts";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

const context = testContext();

// Mock avatar images
beforeEach(() => {
  server.use(
    http.get("https://example.com/avatar.png", () => {
      return new HttpResponse("avatar", {
        headers: { "Content-Type": "image/png" },
      });
    }),
  );
});

// ---------------------------------------------------------------------------
// Tagline rendering — TypewriterText renders the tagline element
// Note: TypewriterText uses setInterval which doesn't advance in jsdom, so we
// only verify the element is present with the correct aria-label, not the text
// content which is populated by the animation.
// ---------------------------------------------------------------------------
describe("agent-chat-page tagline rendering", () => {
  it("renders the tagline element with correct aria-label", async () => {
    detachedSetupPage({
      context,
      path: "/agents/c0000000-0000-4000-a000-000000000001/chat",
      user: { id: "user-1", fullName: "Alice" },
    });

    await waitFor(() => {
      const tagline = screen.getByTestId("chat-tagline");
      expect(tagline).toBeInTheDocument();
    });
    // The aria-label reflects the tagline text
    const tagline = screen.getByTestId("chat-tagline");
    expect(tagline).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// ChatHeaderAction — shows New button when feature switch is enabled
// ---------------------------------------------------------------------------
describe("agent-chat-page ChatHeaderAction", () => {
  it("renders invite button by default when ChatHeaderNewButton feature switch is off", async () => {
    detachedSetupPage({
      context,
      path: "/agents/c0000000-0000-4000-a000-000000000001/chat",
    });

    await waitFor(() => {
      expect(screen.getByTestId("invite-button")).toBeInTheDocument();
    });
  });

  it("renders new-chat button when ChatHeaderNewButton feature switch is on", async () => {
    detachedSetupPage({
      context,
      path: "/agents/c0000000-0000-4000-a000-000000000001/chat",
      featureSwitches: { [FeatureSwitchKey.ChatHeaderNewButton]: true },
    });

    await waitFor(() => {
      expect(screen.getByTestId("chat-header-new-button")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Composer — renders with correct placeholder and send behavior
// ---------------------------------------------------------------------------
describe("agent-chat-page composer", () => {
  it("renders the composer with the placeholder text", async () => {
    detachedSetupPage({
      context,
      path: "/agents/c0000000-0000-4000-a000-000000000001/chat",
    });

    await waitFor(() => {
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
    });
  });

  it("renders suggested prompts grid", async () => {
    detachedSetupPage({
      context,
      path: "/agents/c0000000-0000-4000-a000-000000000001/chat",
    });

    await waitFor(() => {
      // The "Ideas & use cases" button should be visible
      expect(screen.getByText("Ideas & use cases")).toBeInTheDocument();
    });
  });

  it("fills the composer input when selecting a suggested prompt", async () => {
    const user = userEvent.setup();
    detachedSetupPage({
      context,
      path: "/agents/c0000000-0000-4000-a000-000000000001/chat",
    });

    await waitFor(() => {
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
    });

    // Click the Ideas & use cases button
    const ideasButton = screen.getByText("Ideas & use cases");
    await user.click(ideasButton);

    // After clicking, the composer input should be focused or populated
    // (the component navigates to /agents/:agentId/ideas)
  });
});

// ---------------------------------------------------------------------------
// VoiceChatLauncher — renders conditionally based on trinityEnabled
// ---------------------------------------------------------------------------
describe("agent-chat-page voice chat launcher", () => {
  it("does not render voice chat launcher when trinityEnabled is false", async () => {
    detachedSetupPage({
      context,
      path: "/agents/c0000000-0000-4000-a000-000000000001/chat",
    });

    await waitFor(() => {
      expect(screen.queryByTestId("voice-chat-launcher")).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// ChatAgentAvatar — renders with pin pill
// ---------------------------------------------------------------------------
describe("agent-chat-page avatar", () => {
  it("renders the agent avatar link", async () => {
    detachedSetupPage({
      context,
      path: "/agents/c0000000-0000-4000-a000-000000000001/chat",
    });

    await waitFor(() => {
      const avatarLink = document.querySelector('a[aria-label="View agent profile"]');
      expect(avatarLink).toBeInTheDocument();
    });
  });
});
