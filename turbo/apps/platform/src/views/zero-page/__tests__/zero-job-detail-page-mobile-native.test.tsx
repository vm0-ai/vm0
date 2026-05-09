/**
 * Tests for the mobile-native agent detail layout (MobileNativeV1).
 *
 * The page replaces the desktop tabs / mobile dropdown selector with an
 * iOS-Settings-style index: hero (avatar + name + Chat CTA) and a grouped
 * list of section rows. Tapping a row pushes that section's content via
 * the existing ?tab= query param; the top bar's smart back arrow returns
 * to the index without leaving /agents/:id.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  zeroAgentsByIdContract,
  zeroAgentInstructionsContract,
} from "@vm0/api-contracts/contracts/zero-agents";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import { search } from "../../../signals/location.ts";

const context = testContext();
const mockApi = createMockApi(context);

function mobileNativeOn(): Partial<Record<FeatureSwitchKey, boolean>> {
  return { [FeatureSwitchKey.MobileNativeV1]: true };
}

function mockMobileViewport() {
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => {
    return {
      matches: query === "(max-width: 767px)",
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

function mockAPIs() {
  setMockTeam([
    {
      id: "c0000000-0000-4000-a000-000000000001",
      displayName: null,
      description: null,
      sound: null,
      avatarUrl: null,
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
    {
      id: "agent-detail-id",
      displayName: "Lisa",
      description: "Marketing teammate",
      sound: null,
      avatarUrl: null,
      headVersionId: "version_2",
      updatedAt: "2024-01-02T00:00:00Z",
    },
  ]);
  server.use(
    mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
      return respond(200, {
        agentId: "agent-detail-id",
        ownerId: "test-user-123",
        description: "Marketing teammate",
        displayName: "Lisa",
        sound: null,
        avatarUrl: null,
        permissionPolicies: null,
        customSkills: [],
      });
    }),
    mockApi(zeroAgentInstructionsContract.get, ({ respond }) => {
      return respond(200, { content: null, filename: null });
    }),
  );
}

beforeEach(() => {
  mockMobileViewport();
});

describe("mobile-native agent detail - index view (MOBILE-AGENT-001)", () => {
  it("renders hero, Chat CTA, and grouped section rows when MobileNativeV1 is on and no ?tab= is set", async () => {
    mockAPIs();
    detachedSetupPage({
      context,
      path: "/agents/agent-detail-id",
      featureSwitches: mobileNativeOn(),
    });

    await waitFor(() => {
      expect(screen.getByTestId("mobile-agent-display-name")).toHaveTextContent(
        "Lisa",
      );
    });

    expect(screen.getByTestId("mobile-agent-chat-cta")).toHaveTextContent(
      /Chat with Lisa/i,
    );
    expect(
      screen.getByTestId("mobile-agent-section-instructions"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("mobile-agent-section-profile"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("mobile-agent-section-connectors"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("mobile-agent-section-scheduled"),
    ).toBeInTheDocument();

    // Desktop tabs and the legacy mobile <Select> dropdown should NOT be in
    // the tree on mobile-native — the index list replaces both.
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
  });

  it("does not show the index view when MobileNativeV1 is off — falls back to desktop tabs / legacy Select", async () => {
    mockAPIs();
    detachedSetupPage({
      context,
      path: "/agents/agent-detail-id",
    });

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Lisa" })).toBeInTheDocument();
    });

    expect(
      screen.queryByTestId("mobile-agent-section-connectors"),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("tab").length).toBeGreaterThan(0);
  });
});

describe("mobile-native agent detail - row tap pushes section (MOBILE-AGENT-002)", () => {
  it("navigates from index to Connectors section when the Connectors row is tapped, updating ?tab=authorization", async () => {
    mockAPIs();
    detachedSetupPage({
      context,
      path: "/agents/agent-detail-id",
      featureSwitches: mobileNativeOn(),
    });

    const row = await waitFor(() => {
      return screen.getByTestId("mobile-agent-section-connectors");
    });

    click(row);

    await waitFor(() => {
      expect(search()).toBe("?tab=authorization");
    });
    expect(screen.getByTestId("mobile-agent-section-view")).toBeInTheDocument();
    // Index list rows should no longer be rendered when in section view.
    expect(
      screen.queryByTestId("mobile-agent-section-connectors"),
    ).not.toBeInTheDocument();
  });
});

describe("mobile-native agent detail - top bar back arrow returns to index (MOBILE-AGENT-003)", () => {
  it("clears ?tab= and re-renders the index when the smart back arrow is tapped inside a section", async () => {
    mockAPIs();
    detachedSetupPage({
      context,
      path: "/agents/agent-detail-id?tab=authorization",
      featureSwitches: mobileNativeOn(),
    });

    const back = await waitFor(() => {
      return screen.getByTestId("mobile-back-to-agent-overview");
    });

    click(back);

    await waitFor(() => {
      expect(search()).toBe("");
    });
    expect(
      screen.getByTestId("mobile-agent-section-connectors"),
    ).toBeInTheDocument();
  });
});

describe("mobile-native agent detail - top bar shows section title in section view (MOBILE-AGENT-004)", () => {
  it("centers the section label in the top bar instead of the agent name when ?tab= is set", async () => {
    mockAPIs();
    detachedSetupPage({
      context,
      path: "/agents/agent-detail-id?tab=schedule",
      featureSwitches: mobileNativeOn(),
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("mobile-back-to-agent-overview"),
      ).toBeInTheDocument();
    });

    const topBar = screen.getByTestId("mobile-back-to-agent-overview")
      .parentElement as HTMLElement;
    expect(topBar).toHaveTextContent(/Scheduled/i);
    expect(topBar).not.toHaveTextContent("Lisa");
  });
});
