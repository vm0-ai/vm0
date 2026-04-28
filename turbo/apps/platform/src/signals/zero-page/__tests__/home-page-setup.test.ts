/**
 * Tests for setupHomePage$ — the route setup at "/" that decides whether
 * to land users on the default agent's chat (desktop / switch-off) or the
 * chats list (mobile + MobileNativeV1 enabled).
 */

import { describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { testContext } from "../../__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../location.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";

const context = testContext();
const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";

function mockMobileViewport(isMobile: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => {
    return {
      matches: query === "(max-width: 767px)" ? isMobile : false,
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

function mockBaseAPIs() {
  setMockTeam([
    {
      id: DEFAULT_AGENT_ID,
      displayName: null,
      description: null,
      sound: null,
      avatarUrl: null,
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ]);
}

function mobileNativeOn(): Partial<Record<FeatureSwitchKey, boolean>> {
  return { [FeatureSwitchKey.MobileNativeV1]: true };
}

describe("home page setup - desktop redirects to default agent chat (HOME-D-001)", () => {
  it("redirects / to /agents/:id/chat on desktop", async () => {
    mockMobileViewport(false);
    mockBaseAPIs();
    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: mobileNativeOn(),
    });

    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${DEFAULT_AGENT_ID}/chat`);
    });
  });
});

describe("home page setup - mobile redirects to chats list (HOME-D-002)", () => {
  it("redirects / to /chats on mobile when MobileNativeV1 is on", async () => {
    mockMobileViewport(true);
    mockBaseAPIs();
    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: mobileNativeOn(),
    });

    await waitFor(() => {
      expect(pathname()).toBe("/chats");
    });
  });
});

describe("home page setup - mobile keeps default chat when switch off (HOME-D-003)", () => {
  it("falls back to /agents/:id/chat on mobile when MobileNativeV1 is off", async () => {
    mockMobileViewport(true);
    mockBaseAPIs();
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${DEFAULT_AGENT_ID}/chat`);
    });
  });
});
