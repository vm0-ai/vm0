/**
 * Tests for VoiceChatPage component.
 *
 * Covers:
 * - Feature-gated rendering: disabled state when voiceChat switch is off
 * - Idle state model selector: tab ordering and default selection
 * - Quick Chat box: Start Voice Chat button enabled when agent is available
 *
 * See: turbo/apps/platform/src/views/voice-chat/voice-chat-page.tsx
 */

import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { setMockFeatureSwitches } from "../../../mocks/handlers/api-feature-switches.ts";
import { vcModel$ } from "../../../signals/voice-chat/voice-chat-session.ts";

const context = testContext();

// ---------------------------------------------------------------------------
// VC-001: feature disabled
// ---------------------------------------------------------------------------

describe("voice-chat page - feature disabled (VC-001)", () => {
  it("shows not-available message when voiceChat feature switch is off", async () => {
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
    detachedSetupPage({ context, path: "/voice-chat" });

    await waitFor(() => {
      expect(
        screen.getAllByRole("tab").find((el) => {
          return /GPT Realtime Mini/.test(el.textContent ?? "");
        }),
      ).toBeInTheDocument();
    });

    expect(context.store.get(vcModel$)).toBe("gpt-realtime-mini");
  });
});

// ---------------------------------------------------------------------------
// VC-003: idle state – Quick Chat box
// ---------------------------------------------------------------------------

describe("voice-chat page - idle state quick chat box (VC-003)", () => {
  it("start voice chat button is enabled when an agent is available", async () => {
    setMockFeatureSwitches({ voiceChat: true });
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
