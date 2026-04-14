/**
 * Tests for VoiceChatPage component.
 *
 * Covers:
 * - Feature-gated rendering: disabled state when voiceChat switch is off
 * - Idle state model selector: tab ordering and default selection
 * - Quick Chat box: Start Voice Chat button enabled when agent is available
 * - Meeting box: Start Meeting button disabled when textarea is empty
 * - Meeting box: Prepare button disabled/enabled based on textarea content
 *
 * See: turbo/apps/platform/src/views/voice-chat/voice-chat-page.tsx
 * Related commits: #9151 (meeting prep), #9179 (model tab reorder), #9180 (footer layout), #9082 (model selector)
 */

import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { setMockFeatureSwitches } from "../../../mocks/handlers/api-feature-switches.ts";
import { vcModel$ } from "../../../signals/voice-chat/voice-chat-session.ts";

const context = testContext();

/**
 * Mock voice-chat preparation endpoints called fire-and-forget from
 * setupVoiceChatPage$ to avoid unhandled-request warnings during tests.
 */
function mockVoiceChatPrepareEndpoint() {
  server.use(
    http.post("*/api/zero/voice-chat/prepare", () => {
      return HttpResponse.json({
        preparation: { id: "prep-noop", status: "idle" },
      });
    }),
    http.get("*/api/zero/voice-chat/prepare/list", () => {
      return HttpResponse.json({ preparations: [] });
    }),
  );
}

// ---------------------------------------------------------------------------
// VC-001: feature disabled
// ---------------------------------------------------------------------------

describe("voice-chat page - feature disabled (VC-001)", () => {
  it("shows not-available message when voiceChat feature switch is off", async () => {
    mockVoiceChatPrepareEndpoint();
    detachedSetupPage({ context, path: "/voice-chat" });

    await waitFor(() => {
      expect(
        screen.getByText(/not available for your account/i),
      ).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// VC-002: idle state – model selector
// ---------------------------------------------------------------------------

describe("voice-chat page - idle state model selector (VC-002)", () => {
  it("shows GPT Realtime Mini tab first when voiceChat is enabled", async () => {
    setMockFeatureSwitches({ voiceChat: true });
    mockVoiceChatPrepareEndpoint();
    detachedSetupPage({ context, path: "/voice-chat" });

    await waitFor(() => {
      expect(
        screen.getAllByRole("tab").find((el) => {
          return /GPT Realtime Mini/.test(el.textContent ?? "");
        }),
      ).toBeInTheDocument();
    });

    const tabs = screen.getAllByRole("tab");
    const mini = tabs.findIndex((t) => {
      return t.textContent === "GPT Realtime Mini";
    });
    const full = tabs.findIndex((t) => {
      return t.textContent === "GPT Realtime";
    });
    expect(mini).toBeLessThan(full);
  });

  it("gpt realtime tab is selected by default when voiceChat is enabled", async () => {
    setMockFeatureSwitches({ voiceChat: true });
    mockVoiceChatPrepareEndpoint();
    detachedSetupPage({ context, path: "/voice-chat" });

    // Wait for the page to render the tab list
    await waitFor(() => {
      expect(
        screen.getAllByRole("tab").find((el) => {
          return /GPT Realtime Mini/.test(el.textContent ?? "");
        }),
      ).toBeInTheDocument();
    });

    // Verify the default model signal value — more reliable than querying
    // aria-selected which can race with async store initialization.
    // Default changed back to gpt-realtime in #9292.
    expect(context.store.get(vcModel$)).toBe("gpt-realtime");
  });
});

// ---------------------------------------------------------------------------
// VC-003: idle state – Quick Chat box
// ---------------------------------------------------------------------------

describe("voice-chat page - idle state quick chat box (VC-003)", () => {
  it("start voice chat button is enabled when an agent is available", async () => {
    setMockFeatureSwitches({ voiceChat: true });
    mockVoiceChatPrepareEndpoint();
    detachedSetupPage({ context, path: "/voice-chat" });

    const btn = await waitFor(() => {
      const el = screen.getAllByRole("button").find((b) => {
        return /start voice chat/i.test(b.textContent ?? "");
      });
      expect(el).toBeDefined();
      expect(el).not.toBeDisabled();
      return el;
    });
    expect(btn).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// VC-004: idle state – Meeting box
// ---------------------------------------------------------------------------

describe("voice-chat page - idle state meeting box (VC-004)", () => {
  it("start meeting button is disabled when meeting topic textarea is empty", async () => {
    setMockFeatureSwitches({ voiceChat: true });
    mockVoiceChatPrepareEndpoint();
    detachedSetupPage({ context, path: "/voice-chat" });

    const btn = await waitFor(() => {
      const el = screen.getAllByRole("button").find((b) => {
        return /start meeting/i.test(b.textContent ?? "");
      });
      expect(el).toBeDefined();
      return el;
    });
    expect(btn).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// VC-005: meeting box – Prepare button disabled when textarea is empty
// ---------------------------------------------------------------------------

describe("voice-chat page - meeting box prepare button (VC-005)", () => {
  it("prepare button is disabled when meeting topic is empty", async () => {
    setMockFeatureSwitches({ voiceChat: true });
    mockVoiceChatPrepareEndpoint();
    detachedSetupPage({ context, path: "/voice-chat" });

    const prepareBtn = await waitFor(() => {
      return screen.getByText(/^prepare$/i);
    });
    expect(prepareBtn).toBeDisabled();
  });

  it("prepare button is enabled after typing a meeting topic", async () => {
    const user = userEvent.setup();
    setMockFeatureSwitches({ voiceChat: true });
    mockVoiceChatPrepareEndpoint();
    detachedSetupPage({ context, path: "/voice-chat" });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText("What would you like to discuss?");
    });
    await user.type(textarea, "Quarterly planning");

    await waitFor(() => {
      expect(screen.getByText(/^prepare$/i)).not.toBeDisabled();
    });
  });
});
