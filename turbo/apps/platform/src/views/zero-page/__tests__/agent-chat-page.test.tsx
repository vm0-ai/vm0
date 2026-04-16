/**
 * Tests for AgentChatPage component.
 *
 * Covers:
 * - Voice chat mic button: hidden when voiceChat feature switch is off
 * - Voice chat mic button: visible when voiceChat feature switch is on
 * - Tagline renders on page load
 * - Invite button visibility depends on org admin status
 *
 * See: turbo/apps/platform/src/views/zero-page/agent-chat-page.tsx
 * Related commits: #9685 (add voice chat mic button to chat homepage)
 */

import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { setMockFeatureSwitches } from "../../../mocks/handlers/api-feature-switches.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const CHAT_PATH = `/agents/${AGENT_ID}/chat`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockChatHomepageApis() {
  server.use(
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
    http.get("*/api/zero/user-preferences", () => {
      return HttpResponse.json({ pinnedAgentIds: [] });
    }),
  );
}

// ---------------------------------------------------------------------------
// AG-C-001: Voice chat mic button — feature switch off
// ---------------------------------------------------------------------------

describe("agent-chat-page - voice chat mic button hidden (AG-C-001)", () => {
  it("does not render the voice chat mic button when voiceChat feature is disabled", async () => {
    mockChatHomepageApis();

    detachedSetupPage({ context, path: CHAT_PATH });

    // Wait for the chat composer to appear (page fully loaded)
    await waitFor(() => {
      expect(
        screen.getByPlaceholderText(/automate workflows/i),
      ).toBeInTheDocument();
    });

    expect(
      screen.queryByLabelText("Start voice chat"),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// AG-C-002: Voice chat mic button — feature switch on
// ---------------------------------------------------------------------------

describe("agent-chat-page - voice chat mic button visible (AG-C-002)", () => {
  it("renders the voice chat mic button when voiceChat feature is enabled", async () => {
    setMockFeatureSwitches({ voiceChat: true });
    mockChatHomepageApis();

    detachedSetupPage({ context, path: CHAT_PATH });

    await waitFor(() => {
      expect(
        screen.getByLabelText("Start voice chat"),
      ).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// AG-C-003: Tagline renders
// ---------------------------------------------------------------------------

describe("agent-chat-page - tagline renders (AG-C-003)", () => {
  it("renders a tagline when the page loads", async () => {
    mockChatHomepageApis();

    detachedSetupPage({ context, path: CHAT_PATH });

    await waitFor(() => {
      expect(screen.getByTestId("chat-tagline")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// AG-C-004: Invite button visible to admin
// ---------------------------------------------------------------------------

describe("agent-chat-page - invite button admin (AG-C-004)", () => {
  it("renders the invite button for org admins", async () => {
    mockChatHomepageApis();

    server.use(
      http.get("*/api/zero/org/members", () => {
        return HttpResponse.json({ members: [] });
      }),
    );

    detachedSetupPage({ context, path: CHAT_PATH });

    await waitFor(() => {
      expect(screen.getByTestId("invite-button")).toBeInTheDocument();
    });
  });
});
