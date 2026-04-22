/**
 * Tests for the PWA install banner rendered inside SidebarLayout.
 *
 * Covers user-visible behavior of InstallBanner and IosInstallModal on the
 * chat-list route ("/"), where SidebarLayout embeds the banner:
 *
 * - Banner appears when iOS Safari UA is detected and the user has not
 *   dismissed it.
 * - Clicking Install on iOS Safari (no deferred prompt) opens the iOS
 *   "Add to Home Screen" modal.
 * - Clicking Dismiss hides the banner.
 * - Standalone PWA display-mode suppresses the banner entirely.
 *
 * See: turbo/apps/platform/src/views/pwa-install/install-banner.tsx
 * See: turbo/apps/platform/src/signals/pwa-install.ts
 * Related commit: feat(platform): add pwa install banner and rebrand to zero (#9925)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";

const context = testContext();

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockDisplayModeStandalone(standalone: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => {
    return {
      matches: query === "(display-mode: standalone)" ? standalone : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as MediaQueryList;
  });
}

function mockIOSSafariUA(isIOS: boolean) {
  const ua = isIOS
    ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
}

// ---------------------------------------------------------------------------
// PWA-D-001: banner visible on iOS Safari
// ---------------------------------------------------------------------------

describe("install banner - visible on iOS Safari (PWA-D-001)", () => {
  it("renders the install CTA and Install button when iOS Safari UA is detected", async () => {
    mockDisplayModeStandalone(false);
    mockIOSSafariUA(true);
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(
        screen.getByLabelText("Dismiss install banner"),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Install app")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// PWA-D-002: install button opens iOS modal
// ---------------------------------------------------------------------------

describe("install banner - install opens iOS modal (PWA-D-002)", () => {
  it("opens the 'Add to Home Screen' modal on iOS Safari with no deferred prompt", async () => {
    mockDisplayModeStandalone(false);
    mockIOSSafariUA(true);
    detachedSetupPage({ context, path: "/" });

    const installButton = await waitFor(() => {
      return screen.getByLabelText("Install app");
    });
    click(installButton);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Install Zero" }),
      ).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// PWA-D-003: dismiss hides banner
// ---------------------------------------------------------------------------

describe("install banner - dismiss hides banner (PWA-D-003)", () => {
  it("removes the banner from the DOM after the dismiss button is clicked", async () => {
    mockDisplayModeStandalone(false);
    mockIOSSafariUA(true);
    detachedSetupPage({ context, path: "/" });

    const dismissButton = await waitFor(() => {
      return screen.getByLabelText("Dismiss install banner");
    });
    click(dismissButton);

    await waitFor(() => {
      expect(
        screen.queryByLabelText("Dismiss install banner"),
      ).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// PWA-D-004: hidden in standalone display mode
// ---------------------------------------------------------------------------

describe("install banner - hidden in standalone mode (PWA-D-004)", () => {
  it("does not render the banner when display-mode is standalone, even on iOS Safari", async () => {
    mockDisplayModeStandalone(true);
    mockIOSSafariUA(true);
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByLabelText("Open menu")).toBeInTheDocument();
    });
    expect(
      screen.queryByLabelText("Dismiss install banner"),
    ).not.toBeInTheDocument();
  });
});
