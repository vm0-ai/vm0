import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, fill } from "../../../__tests__/page-helper.ts";
import { PLACEHOLDER } from "./chat-test-helpers.ts";
import { pathname } from "../../../signals/location.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import {
  onboardingStatusContract,
  onboardingSetupContract,
  onboardingCompleteContract,
} from "@vm0/core";

const context = testContext();

const MOCK_AGENT_ID = "d0000000-0000-4000-a000-000000000001";
const MOCK_MEMBER_AGENT_ID = "c0000000-0000-4000-a000-000000000001";

function mockAdminOnboarding() {
  server.use(
    mockApi(onboardingStatusContract.getStatus, ({ respond }) => {
      return respond(200, {
        needsOnboarding: true,
        isAdmin: true,
        hasOrg: true,
        hasDefaultAgent: false,
        defaultAgentId: null,
        defaultAgentMetadata: null,
      });
    }),
    mockApi(onboardingSetupContract.setup, ({ respond }) => {
      return respond(200, { agentId: MOCK_AGENT_ID });
    }),
  );
}

function mockMemberOnboarding() {
  server.use(
    mockApi(onboardingStatusContract.getStatus, ({ respond }) => {
      return respond(200, {
        needsOnboarding: true,
        isAdmin: false,
        hasOrg: true,
        hasDefaultAgent: true,
        defaultAgentId: MOCK_MEMBER_AGENT_ID,
        defaultAgentMetadata: { displayName: "Zero" },
      });
    }),
    mockApi(onboardingCompleteContract.complete, ({ respond }) => {
      return respond(200, { ok: true });
    }),
  );
}

/** Walk through onboarding steps up to the "Where would you like to work" step. */
async function walkToWhereStep(
  user: ReturnType<typeof userEvent.setup>,
  isMember: boolean,
) {
  if (isMember) {
    // Member lands on step 2 (Choose your tools) under the unified flow
    await waitFor(() => {
      expect(screen.getByText("Choose your tools")).toBeInTheDocument();
    });
    // Advance without selecting a connector — skips step 3, lands on step 4
    await user.click(screen.getByText("Next"));

    await waitFor(() => {
      expect(
        screen.getByText(/Where would you like to work with/),
      ).toBeInTheDocument();
    });
  } else {
    await waitFor(() => {
      expect(screen.getByText(/Name your workspace/)).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText("e.g. Acme Corp");
    await fill(input, "Test Workspace");
    await user.click(screen.getByText("Next"));

    await waitFor(() => {
      expect(screen.getByText("Choose your tools")).toBeInTheDocument();
    });
    // Select a connector so step 3 is reachable (#9129)
    await user.click(screen.getByTestId("connector-card-github"));
    await user.click(screen.getByText("Next"));

    await waitFor(() => {
      expect(screen.getByText("Connect your apps")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Next"));

    await waitFor(() => {
      expect(
        screen.getByText(/Where would you like to work with/),
      ).toBeInTheDocument();
    });
  }
}

describe("onboarding → chat page (no auto-intro)", () => {
  it("should navigate to /agents/:id/chat after admin completes onboarding", async () => {
    const user = userEvent.setup();
    mockAdminOnboarding();

    detachedSetupPage({ context, path: "/onboarding" });
    await walkToWhereStep(user, false);

    // Switch onboarding status so post-navigate route doesn't redirect back
    server.use(
      mockApi(onboardingStatusContract.getStatus, ({ respond }) => {
        return respond(200, {
          needsOnboarding: false,
          isAdmin: true,
          hasOrg: true,
          hasDefaultAgent: true,
          defaultAgentId: MOCK_AGENT_ID,
          defaultAgentMetadata: null,
        });
      }),
    );

    await user.click(screen.getByText(/Continue in web/));

    // Should navigate directly to the agent chat page
    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${MOCK_AGENT_ID}/chat`);
    });

    // Chat input should be ready for user to type (no auto-intro sent)
    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    expect(textarea).not.toBeDisabled();
  });

  it("should navigate to /agents/:id/chat after member completes onboarding", async () => {
    const user = userEvent.setup();
    mockMemberOnboarding();

    detachedSetupPage({ context, path: "/onboarding" });
    await walkToWhereStep(user, true);

    server.use(
      mockApi(onboardingStatusContract.getStatus, ({ respond }) => {
        return respond(200, {
          needsOnboarding: false,
          isAdmin: false,
          hasOrg: true,
          hasDefaultAgent: true,
          defaultAgentId: MOCK_MEMBER_AGENT_ID,
          defaultAgentMetadata: { displayName: "Zero" },
        });
      }),
    );

    await user.click(screen.getByText(/Continue in web/));

    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${MOCK_MEMBER_AGENT_ID}/chat`);
    });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    expect(textarea).not.toBeDisabled();
  });
});
