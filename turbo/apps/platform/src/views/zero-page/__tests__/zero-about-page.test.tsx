import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { setZeroShowAboutPage$ } from "../../../signals/zero-page/zero-nav.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { zeroAgentsByIdContract } from "@vm0/api-contracts/contracts/zero-agents";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import { setMockOnboardingStatus } from "../../../mocks/handlers/api-onboarding.ts";

const context = testContext();
const mockApi = createMockApi(context);

function mockBasicAPIs() {
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
  ]);
}

describe("zero about page", () => {
  // AGENT-D-072: About page renders when flag is set
  it("renders the about page when zeroShowAboutPage is true", async () => {
    mockBasicAPIs();
    detachedSetupPage({ context, path: "/" });
    context.store.set(setZeroShowAboutPage$, true);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "About VM0 Zero" }),
      ).toBeInTheDocument();
    });
  });

  // AGENT-D-073: Dynamic text interpolation with name
  it("interpolates agent display name in section headings", async () => {
    mockBasicAPIs();
    setMockOnboardingStatus({
      defaultAgentMetadata: { displayName: "MyAgent" },
    });
    server.use(
      mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
        return respond(200, {
          agentId: "c0000000-0000-4000-a000-000000000001",
          ownerId: "test-user",
          displayName: "MyAgent",
          description: null,
          sound: null,
          avatarUrl: null,
          customSkills: [],
        });
      }),
    );
    detachedSetupPage({ context, path: "/" });
    context.store.set(setZeroShowAboutPage$, true);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /Who MyAgent is for/i }),
      ).toBeInTheDocument();
    });
  });

  // AGENT-D-074: Back button navigates back
  it("back button hides the about page", async () => {
    mockBasicAPIs();
    detachedSetupPage({ context, path: "/" });
    context.store.set(setZeroShowAboutPage$, true);

    await waitFor(() => {
      expect(screen.getByText(/back/i)).toBeInTheDocument();
    });

    click(screen.getByText(/back/i));

    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "About VM0 Zero" }),
      ).not.toBeInTheDocument();
    });
  });

  // AGENT-D-075: External link opens vm0.ai
  it("renders external link to vm0.ai", async () => {
    mockBasicAPIs();
    detachedSetupPage({ context, path: "/" });
    context.store.set(setZeroShowAboutPage$, true);

    await waitFor(() => {
      const link = document.querySelector('a[href="https://vm0.ai"]');
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute("target", "_blank");
    });
  });
});
