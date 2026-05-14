import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  fill,
  click,
} from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { PLACEHOLDER } from "./chat-test-helpers.ts";
import {
  onboardingStatusContract,
  onboardingSetupContract,
} from "@vm0/api-contracts/contracts/onboarding";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";

const context = testContext();
const mockApi = createMockApi(context);

const MOCK_AGENT_ID = "d0000000-0000-4000-a000-000000000001";

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

function switchToAdminComplete() {
  // Register the newly provisioned agent in the team so the chat page setup
  // finds it instead of redirecting to the (same) default agent.
  setMockTeam([
    {
      id: MOCK_AGENT_ID,
      displayName: null,
      description: null,
      sound: null,
      avatarUrl: null,
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ]);
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
}

// Step 1 (name workspace) → step 2 (choose tools, pick a connector). Step 2's
// "Continue in web" is the terminal step of the regular admin flow.
async function walkAdminToContinue() {
  await waitFor(() => {
    expect(screen.getByText(/Name your workspace/)).toBeInTheDocument();
  });

  const input = screen.getByPlaceholderText("e.g. Acme Corp");
  await fill(input, "Test Workspace");
  click(screen.getByText("Next"));

  await waitFor(() => {
    expect(screen.getByText("Choose your tools")).toBeInTheDocument();
  });
  click(screen.getByTestId("connector-card-github"));

  await waitFor(() => {
    expect(screen.getByText(/Continue in web/)).toBeInTheDocument();
  });
}

describe("onboarding continue in web → agent chat page", () => {
  it("should navigate to /agents/:id/chat after admin completes onboarding", async () => {
    mockAdminOnboarding();

    detachedSetupPage({ context, path: "/onboarding" });
    await walkAdminToContinue();

    switchToAdminComplete();

    click(screen.getByText(/Continue in web/));

    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${MOCK_AGENT_ID}/chat`);
    });
  });
});

// ---------------------------------------------------------------------------
// ?prompt= forwarding
// ---------------------------------------------------------------------------

describe("prompt param forwarding", () => {
  it("should forward ?prompt= to chat page via Continue in web", async () => {
    mockAdminOnboarding();

    detachedSetupPage({ context, path: "/onboarding?prompt=hello%20world" });
    await walkAdminToContinue();

    switchToAdminComplete();

    click(screen.getByText(/Continue in web/));

    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${MOCK_AGENT_ID}/chat`);
    });

    // The chat page consumes ?prompt= and injects it into the textarea
    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    expect(textarea).toHaveValue("hello world");
  });

  it("should not include prompt param when absent", async () => {
    mockAdminOnboarding();

    detachedSetupPage({ context, path: "/onboarding" });
    await walkAdminToContinue();

    switchToAdminComplete();

    click(screen.getByText(/Continue in web/));

    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${MOCK_AGENT_ID}/chat`);
    });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    expect(textarea).toHaveValue("");
  });
});
