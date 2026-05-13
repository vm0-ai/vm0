import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  fill,
  click,
} from "../../../__tests__/page-helper.ts";
import { pathname, search } from "../../../signals/location.ts";
import { PLACEHOLDER } from "./chat-test-helpers.ts";
import { zeroIntegrationsSlackContract } from "@vm0/api-contracts/contracts/zero-integrations-slack";
import {
  onboardingStatusContract,
  onboardingSetupContract,
  onboardingCompleteContract,
} from "@vm0/api-contracts/contracts/onboarding";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
const context = testContext();
const mockApi = createMockApi(context);

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

function switchToMemberComplete() {
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
}

function mockSlackInstallReady() {
  server.use(
    mockApi(zeroIntegrationsSlackContract.getStatus, ({ respond }) => {
      return respond(200, {
        isConnected: false,
        isInstalled: false,
        isAdmin: true,
        installUrl: "https://example.com/api/zero/slack/oauth/install?orgId=o1",
        connectUrl: null,
        reinstallUrl: null,
        scopeMismatch: false,
        workspaceName: null,
        agentOrgSlug: null,
        environment: {
          requiredSecrets: [],
          requiredVars: [],
          missingSecrets: [],
          missingVars: [],
        },
      });
    }),
  );
}

function mockSlackConnectReady() {
  server.use(
    mockApi(zeroIntegrationsSlackContract.getStatus, ({ respond }) => {
      return respond(200, {
        isConnected: false,
        isInstalled: true,
        isAdmin: false,
        installUrl: null,
        connectUrl: "https://example.com/api/zero/slack/oauth/connect?orgId=o1",
        reinstallUrl: null,
        scopeMismatch: false,
        workspaceName: "Acme",
        agentOrgSlug: null,
        environment: {
          requiredSecrets: [],
          requiredVars: [],
          missingSecrets: [],
          missingVars: [],
        },
      });
    }),
  );
}

async function walkMemberToWhereStep() {
  await waitFor(() => {
    expect(screen.getByText("Choose your tools")).toBeInTheDocument();
  });
  click(screen.getByText("Next"));

  await waitFor(() => {
    expect(
      screen.getByText(/Where would you like to work with/),
    ).toBeInTheDocument();
  });
}

async function walkAdminToWhereStep() {
  await waitFor(() => {
    expect(screen.getByText(/Name your workspace/)).toBeInTheDocument();
  });

  const input = screen.getByPlaceholderText("e.g. Acme Corp");
  await fill(input, "Test Workspace");
  click(screen.getByText("Next"));

  await waitFor(() => {
    expect(screen.getByText("Choose your tools")).toBeInTheDocument();
  });
  // Select a connector so step 3 is reachable (#9129 — step 3 is
  // conditional on at least one selected connector)
  click(screen.getByTestId("connector-card-github"));
  click(screen.getByText("Next"));

  await waitFor(() => {
    expect(screen.getByText("Connect your apps")).toBeInTheDocument();
  });
  click(screen.getByText("Next"));

  await waitFor(() => {
    expect(
      screen.getByText(/Where would you like to work with/),
    ).toBeInTheDocument();
  });
}

describe("onboarding continue in web → agent chat page", () => {
  it("should navigate to /agents/:id/chat after admin completes full onboarding", async () => {
    mockAdminOnboarding();

    detachedSetupPage({ context, path: "/onboarding" });
    await walkAdminToWhereStep();

    switchToAdminComplete();

    click(screen.getByText(/Continue in web/));

    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${MOCK_AGENT_ID}/chat`);
    });
  });

  it("should navigate to /agents/:id/chat after member completes onboarding", async () => {
    mockMemberOnboarding();

    detachedSetupPage({ context, path: "/onboarding" });

    // Member lands on step 2 (Choose your tools) under the unified flow
    await waitFor(() => {
      expect(screen.getByText("Choose your tools")).toBeInTheDocument();
    });
    // Advance without selecting a connector — skips step 3, lands on step 4
    click(screen.getByText("Next"));

    await waitFor(() => {
      expect(
        screen.getByText(/Where would you like to work with/),
      ).toBeInTheDocument();
    });

    switchToMemberComplete();

    click(screen.getByText(/Continue in web/));

    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${MOCK_MEMBER_AGENT_ID}/chat`);
    });
  });
});

// ---------------------------------------------------------------------------
// Continue in Slack
// ---------------------------------------------------------------------------

describe("onboarding add to Slack → works page", () => {
  it("should navigate to /works after admin completes onboarding via Slack", async () => {
    mockAdminOnboarding();

    detachedSetupPage({ context, path: "/onboarding" });
    await walkAdminToWhereStep();

    switchToAdminComplete();

    click(screen.getByText(/Add .+ to Slack/));

    await waitFor(() => {
      expect(pathname()).toBe("/works");
    });
  });

  it("should navigate to /works after member completes onboarding via Slack", async () => {
    mockMemberOnboarding();

    detachedSetupPage({ context, path: "/onboarding" });

    // Member lands on step 2 (Choose your tools) under the unified flow
    await waitFor(() => {
      expect(screen.getByText("Choose your tools")).toBeInTheDocument();
    });
    // Advance without selecting a connector — skips step 3, lands on step 4
    click(screen.getByText("Next"));

    await waitFor(() => {
      expect(
        screen.getByText(/Where would you like to work with/),
      ).toBeInTheDocument();
    });

    switchToMemberComplete();

    click(screen.getByText(/Add .+ to Slack/));

    await waitFor(() => {
      expect(pathname()).toBe("/works");
    });
  });
});

// ---------------------------------------------------------------------------
// Continue in Telegram
// ---------------------------------------------------------------------------

describe("onboarding set up Telegram → settings page", () => {
  it("should navigate to /settings/telegram after saving the agent", async () => {
    mockAdminOnboarding();

    detachedSetupPage({
      context,
      path: "/onboarding",
    });
    await walkAdminToWhereStep();

    await waitFor(() => {
      expect(screen.getByText(/Add .+ to Telegram/)).toBeInTheDocument();
    });

    switchToAdminComplete();

    click(screen.getByText(/Add .+ to Telegram/));

    await waitFor(() => {
      expect(pathname()).toBe("/settings/telegram");
    });
  });
});

describe("onboarding set up AgentPhone → works page", () => {
  it("shows AgentPhone only when enabled and navigates after saving the agent", async () => {
    mockAdminOnboarding();

    detachedSetupPage({
      context,
      path: "/onboarding",
      featureSwitches: { [FeatureSwitchKey.AgentPhoneAppUi]: true },
    });
    await walkAdminToWhereStep();

    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-agentphone-option"),
      ).toBeInTheDocument();
    });

    switchToAdminComplete();

    click(screen.getByTestId("onboarding-agentphone-option"));

    await waitFor(() => {
      expect(pathname()).toBe("/works");
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
    await walkAdminToWhereStep();

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
    await walkAdminToWhereStep();

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

  it("should forward ?prompt= to /works via Add to Slack", async () => {
    mockAdminOnboarding();

    detachedSetupPage({ context, path: "/onboarding?prompt=hello%20world" });
    await walkAdminToWhereStep();

    switchToAdminComplete();

    click(screen.getByText(/Add .+ to Slack/));

    await waitFor(() => {
      expect(pathname()).toBe("/works");
    });
    expect(new URLSearchParams(search()).get("prompt")).toBe("hello world");
  });

  it("should not include prompt param in /works when absent", async () => {
    mockAdminOnboarding();

    detachedSetupPage({ context, path: "/onboarding" });
    await walkAdminToWhereStep();

    switchToAdminComplete();

    click(screen.getByText(/Add .+ to Slack/));

    await waitFor(() => {
      expect(pathname()).toBe("/works");
    });
    expect(search()).toBe("");
  });

  it("should forward ?prompt= to /works for member via Add to Slack", async () => {
    mockMemberOnboarding();

    detachedSetupPage({
      context,
      path: "/onboarding?prompt=summarize%20inbox",
    });

    await walkMemberToWhereStep();

    switchToMemberComplete();

    click(screen.getByText(/Add .+ to Slack/));

    await waitFor(() => {
      expect(pathname()).toBe("/works");
    });
    expect(new URLSearchParams(search()).get("prompt")).toBe("summarize inbox");
  });

  it("should append ?prompt= to Slack install URL", async () => {
    mockAdminOnboarding();
    mockSlackInstallReady();
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);

    detachedSetupPage({
      context,
      path: "/onboarding?prompt=summarize%20inbox",
    });
    await walkAdminToWhereStep();

    switchToAdminComplete();

    click(screen.getByText(/Add .+ to Slack/));

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledTimes(1);
    });
    const openedUrl = new URL(openSpy.mock.calls[0]?.[0] as string);
    expect(openedUrl.searchParams.get("prompt")).toBe("summarize inbox");

    openSpy.mockRestore();
  });

  it("should omit prompt from Slack install URL when absent", async () => {
    mockAdminOnboarding();
    mockSlackInstallReady();
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);

    detachedSetupPage({ context, path: "/onboarding" });
    await walkAdminToWhereStep();

    switchToAdminComplete();

    click(screen.getByText(/Add .+ to Slack/));

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledTimes(1);
    });
    const openedUrl = new URL(openSpy.mock.calls[0]?.[0] as string);
    expect(openedUrl.searchParams.get("prompt")).toBeNull();

    openSpy.mockRestore();
  });

  it("should open connect URL for member with ?prompt=", async () => {
    mockMemberOnboarding();
    mockSlackConnectReady();
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);

    detachedSetupPage({
      context,
      path: "/onboarding?prompt=summarize%20inbox",
    });

    await walkMemberToWhereStep();

    switchToMemberComplete();

    click(screen.getByText(/Add .+ to Slack/));

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledTimes(1);
    });
    const openedUrl = new URL(openSpy.mock.calls[0]?.[0] as string);
    expect(openedUrl.pathname).toBe("/api/zero/slack/oauth/connect");
    expect(openedUrl.searchParams.get("prompt")).toBe("summarize inbox");

    openSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Member completion sends selectedConnectors to backend
// ---------------------------------------------------------------------------

describe("completeMemberOnboarding request body", () => {
  it("should send selectedConnectors when member has selected connectors", async () => {
    mockMemberOnboarding();

    let receivedBody: unknown = null;
    server.use(
      mockApi(onboardingCompleteContract.complete, ({ body, respond }) => {
        receivedBody = body;
        return respond(200, { ok: true });
      }),
    );

    detachedSetupPage({ context, path: "/onboarding" });

    // Member lands on step 2 — select connectors
    await waitFor(() => {
      expect(screen.getByText("Choose your tools")).toBeInTheDocument();
    });
    click(screen.getByTestId("connector-card-slack"));
    click(screen.getByTestId("connector-card-github"));
    click(screen.getByText("Next"));

    // Step 3 (connect apps) → skip to step 4
    await waitFor(() => {
      expect(screen.getByText("Connect your apps")).toBeInTheDocument();
    });
    click(screen.getByText("Next"));

    await waitFor(() => {
      expect(
        screen.getByText(/Where would you like to work with/),
      ).toBeInTheDocument();
    });

    switchToMemberComplete();

    click(screen.getByText(/Continue in web/));

    await waitFor(() => {
      expect(receivedBody).not.toBeNull();
    });
    expect(receivedBody).toMatchObject({
      selectedConnectors: expect.arrayContaining(["slack", "github"]),
    });
  });

  it("should send empty body when member has no selected connectors", async () => {
    mockMemberOnboarding();

    let receivedBody: unknown = null;
    server.use(
      mockApi(onboardingCompleteContract.complete, ({ body, respond }) => {
        receivedBody = body;
        return respond(200, { ok: true });
      }),
    );

    detachedSetupPage({ context, path: "/onboarding" });

    await walkMemberToWhereStep();

    switchToMemberComplete();

    click(screen.getByText(/Continue in web/));

    await waitFor(() => {
      expect(receivedBody).not.toBeNull();
    });
    expect(receivedBody).toStrictEqual({});
  });
});
