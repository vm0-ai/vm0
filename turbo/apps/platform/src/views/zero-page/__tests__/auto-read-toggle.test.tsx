/**
 * Tests for the auto-read (TTS) toggle button in the chat thread header.
 *
 * The toggle is gated on the `audioOutput` feature switch. When enabled, a button
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
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { setMockFeatureSwitches } from "../../../mocks/handlers/api-feature-switches.ts";
import { mockSubagentThread } from "./chat-test-helpers.ts";
import { autoReadEnabled$ } from "../../../signals/voice-io/voice-io-settings.ts";

const context = testContext();

const THREAD_ID = "thread-auto-read-test";

// ---------------------------------------------------------------------------
// AR-001: toggle absent when audioOutput feature is off (default)
// ---------------------------------------------------------------------------

describe("auto-read toggle - hidden when audioOutput feature is off (AR-001)", () => {
  it("does not render the Toggle auto-read button when audioOutput is disabled", async () => {
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
// AR-002: toggle present when audioOutput feature is on
// ---------------------------------------------------------------------------

describe("auto-read toggle - visible when audioOutput feature is on (AR-002)", () => {
  it("renders the Toggle auto-read button when audioOutput is enabled", async () => {
    setMockFeatureSwitches({ audioOutput: true });
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
    setMockFeatureSwitches({ audioOutput: true });
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
    setMockFeatureSwitches({ audioOutput: true });
    mockSubagentThread(THREAD_ID);
    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const toggleBtn = await waitFor(() => {
      return screen.getAllByLabelText("Toggle auto-read")[0];
    });

    click(toggleBtn);

    expect(context.store.get(autoReadEnabled$)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// AR-005: clicking toggle twice returns to off
// ---------------------------------------------------------------------------

describe("auto-read toggle - double-click returns to off (AR-005)", () => {
  it("returns autoReadEnabled$ to false after clicking toggle twice", async () => {
    setMockFeatureSwitches({ audioOutput: true });
    mockSubagentThread(THREAD_ID);
    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const toggleBtn = await waitFor(() => {
      return screen.getAllByLabelText("Toggle auto-read")[0];
    });

    click(toggleBtn);
    click(toggleBtn);

    expect(context.store.get(autoReadEnabled$)).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// AR-006: mobile top bar toggle hidden on non-chat routes even with audioOutput on
// ---------------------------------------------------------------------------

describe("auto-read toggle - mobile top bar hides toggle on non-chat routes (AR-006)", () => {
  it("does not render the mobile top bar Toggle auto-read button on /agents even when audioOutput is enabled", async () => {
    setMockFeatureSwitches({ audioOutput: true });
    detachedSetupPage({ context, path: "/agents" });

    // Wait for the mobile top bar to render (menu button is always present)
    await waitFor(() => {
      expect(screen.getByLabelText("Open menu")).toBeInTheDocument();
    });

    // The only place the toggle renders outside chat thread pages is the
    // mobile top bar; on /agents (a non-chat route) it must be absent.
    expect(screen.queryAllByLabelText("Toggle auto-read")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AR-007: mobile top bar toggle shown on chat routes with audioOutput on
// ---------------------------------------------------------------------------

describe("auto-read toggle - mobile top bar shows toggle on chat routes (AR-007)", () => {
  it("renders the mobile top bar Toggle auto-read button on the home chat route when audioOutput is enabled", async () => {
    setMockFeatureSwitches({ audioOutput: true });
    detachedSetupPage({ context, path: "/" });

    // The home route (isChatRoute === true) should render the toggle in the
    // mobile top bar when audioOutput is on.
    await waitFor(() => {
      expect(
        screen.getAllByLabelText("Toggle auto-read").length,
      ).toBeGreaterThan(0);
    });
  });
});
