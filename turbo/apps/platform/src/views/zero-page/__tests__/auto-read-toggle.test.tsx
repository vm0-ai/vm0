/**
 * Tests for the auto-read (TTS) toggle button in the chat thread header.
 *
 * The toggle is gated on the `audioIO` feature switch. When enabled, a button
 * with aria-label "Toggle auto-read" appears in the chat thread page header
 * and in the mobile top bar. Clicking it toggles autoReadEnabled$ (localStorage-
 * backed signal) between false and true.
 *
 * See: turbo/apps/platform/src/views/zero-page/zero-chat-thread-page.tsx
 * See: turbo/apps/platform/src/views/zero-page/sidebar-layout.tsx
 * Related commit: feat(platform): add tts read-aloud button and auto-read toggle (#9105)
 */

import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { setMockFeatureSwitches } from "../../../mocks/handlers/api-feature-switches.ts";
import { mockSubagentThread } from "./chat-test-helpers.ts";
import { autoReadEnabled$ } from "../../../signals/voice-io/voice-io-settings.ts";

const context = testContext();

const THREAD_ID = "thread-auto-read-test";

// ---------------------------------------------------------------------------
// AR-001: toggle absent when audioIO feature is off (default)
// ---------------------------------------------------------------------------

describe("auto-read toggle - hidden when audioIO feature is off (AR-001)", () => {
  it("does not render the Toggle auto-read button when audioIO is disabled", async () => {
    mockSubagentThread(THREAD_ID);
    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    // Wait for the thread page to render the agent name in the header
    await waitFor(() => {
      expect(screen.getByText("Assistant")).toBeInTheDocument();
    });

    expect(screen.queryAllByLabelText("Toggle auto-read")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AR-002: toggle present when audioIO feature is on
// ---------------------------------------------------------------------------

describe("auto-read toggle - visible when audioIO feature is on (AR-002)", () => {
  it("renders the Toggle auto-read button when audioIO is enabled", async () => {
    setMockFeatureSwitches({ audioIO: true });
    mockSubagentThread(THREAD_ID);
    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await waitFor(() => {
      expect(
        screen.getAllByLabelText("Toggle auto-read").length,
      ).toBeGreaterThan(0);
    });
  });
});

// ---------------------------------------------------------------------------
// AR-003: toggle state starts as off
// ---------------------------------------------------------------------------

describe("auto-read toggle - initial state is off (AR-003)", () => {
  it("toggle button has aria-pressed=false before any interaction", async () => {
    setMockFeatureSwitches({ audioIO: true });
    mockSubagentThread(THREAD_ID);
    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await waitFor(() => {
      expect(
        screen.getAllByLabelText("Toggle auto-read").length,
      ).toBeGreaterThan(0);
    });

    expect(context.store.get(autoReadEnabled$)).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// AR-004: clicking toggle enables auto-read
// ---------------------------------------------------------------------------

describe("auto-read toggle - click enables auto-read (AR-004)", () => {
  it("sets autoReadEnabled$ to true after clicking the toggle once", async () => {
    const user = userEvent.setup();
    setMockFeatureSwitches({ audioIO: true });
    mockSubagentThread(THREAD_ID);
    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const toggleBtn = await waitFor(() => {
      return screen.getAllByLabelText("Toggle auto-read")[0];
    });

    await user.click(toggleBtn);

    expect(context.store.get(autoReadEnabled$)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// AR-005: clicking toggle twice returns to off
// ---------------------------------------------------------------------------

describe("auto-read toggle - double-click returns to off (AR-005)", () => {
  it("returns autoReadEnabled$ to false after clicking toggle twice", async () => {
    const user = userEvent.setup();
    setMockFeatureSwitches({ audioIO: true });
    mockSubagentThread(THREAD_ID);
    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const toggleBtn = await waitFor(() => {
      return screen.getAllByLabelText("Toggle auto-read")[0];
    });

    await user.click(toggleBtn);
    await user.click(toggleBtn);

    expect(context.store.get(autoReadEnabled$)).toBeFalsy();
  });
});
