/**
 * Tests for VoiceChatPage component.
 *
 * Covers:
 * - Feature-gated rendering: disabled state when voiceChat switch is off
 * - Idle state UI: model selector tabs, Quick Chat box, Meeting box
 * - Meeting box: textarea, Prepare button, Start Meeting button
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

const context = testContext();
const user = userEvent.setup();

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

  it("shows both model tabs when voiceChat is enabled", async () => {
    setMockFeatureSwitches({ voiceChat: true });
    mockVoiceChatPrepareEndpoint();
    detachedSetupPage({ context, path: "/voice-chat" });

    await waitFor(() => {
      expect(
        screen.getAllByRole("tab").find((el) => {
          return /GPT Realtime/.test(el.textContent ?? "");
        }),
      ).toBeInTheDocument();
    });
    expect(
      screen.getAllByRole("tab").find((el) => {
        return /GPT Realtime Mini/.test(el.textContent ?? "");
      }),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// VC-003: idle state – Quick Chat box
// ---------------------------------------------------------------------------

describe("voice-chat page - idle state quick chat box (VC-003)", () => {
  it("renders Start Voice Chat button", async () => {
    setMockFeatureSwitches({ voiceChat: true });
    mockVoiceChatPrepareEndpoint();
    detachedSetupPage({ context, path: "/voice-chat" });

    await waitFor(() => {
      expect(
        screen.getByText(/start voice chat/i),
      ).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// VC-004: idle state – Meeting box
// ---------------------------------------------------------------------------

describe("voice-chat page - idle state meeting box (VC-004)", () => {
  it("renders Voice Meeting section heading", async () => {
    setMockFeatureSwitches({ voiceChat: true });
    mockVoiceChatPrepareEndpoint();
    detachedSetupPage({ context, path: "/voice-chat" });

    await waitFor(() => {
      expect(screen.getByText("Voice Meeting")).toBeInTheDocument();
    });
  });

  it("renders meeting topic textarea", async () => {
    setMockFeatureSwitches({ voiceChat: true });
    mockVoiceChatPrepareEndpoint();
    detachedSetupPage({ context, path: "/voice-chat" });

    await waitFor(() => {
      expect(
        screen.getByPlaceholderText("What would you like to discuss?"),
      ).toBeInTheDocument();
    });
  });

  it("renders Prepare and Start Meeting buttons", async () => {
    setMockFeatureSwitches({ voiceChat: true });
    mockVoiceChatPrepareEndpoint();
    detachedSetupPage({ context, path: "/voice-chat" });

    await waitFor(() => {
      expect(
        screen.getByText(/prepare/i),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText(/start meeting/i),
    ).toBeInTheDocument();
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
    setMockFeatureSwitches({ voiceChat: true });
    mockVoiceChatPrepareEndpoint();
    detachedSetupPage({ context, path: "/voice-chat" });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText("What would you like to discuss?");
    });
    await user.type(textarea, "Quarterly planning");

    await waitFor(() => {
      expect(
        screen.getByText(/^prepare$/i),
      ).not.toBeDisabled();
    });
  });
});
