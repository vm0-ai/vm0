import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, fill } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";

const context = testContext();

const MOCK_AGENT_ID = "d0000000-0000-4000-a000-000000000001";
const MOCK_MEMBER_AGENT_ID = "c0000000-0000-4000-a000-000000000001";

function mockAdminOnboarding() {
  server.use(
    http.get("*/api/zero/onboarding/status", () => {
      return HttpResponse.json({
        needsOnboarding: true,
        isAdmin: true,
        hasOrg: true,
        hasDefaultAgent: false,
        defaultAgentId: null,
        defaultAgentMetadata: null,
        defaultAgentSkills: [],
      });
    }),
    http.post("*/api/zero/onboarding/setup", () => {
      return HttpResponse.json({ agentId: MOCK_AGENT_ID });
    }),
  );
}

function switchToAdminComplete() {
  server.use(
    http.get("*/api/zero/onboarding/status", () => {
      return HttpResponse.json({
        needsOnboarding: false,
        isAdmin: true,
        hasOrg: true,
        hasDefaultAgent: true,
        defaultAgentId: MOCK_AGENT_ID,
        defaultAgentMetadata: null,
        defaultAgentSkills: [],
      });
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

function mockMemberOnboarding() {
  server.use(
    http.get("*/api/zero/onboarding/status", () => {
      return HttpResponse.json({
        needsOnboarding: true,
        isAdmin: false,
        hasOrg: true,
        hasDefaultAgent: true,
        defaultAgentId: MOCK_MEMBER_AGENT_ID,
        defaultAgentMetadata: { displayName: "Zero" },
        defaultAgentSkills: [],
      });
    }),
    http.post("*/api/zero/onboarding/complete", () => {
      return HttpResponse.json({ ok: true });
    }),
  );
}

function switchToMemberComplete() {
  server.use(
    http.get("*/api/zero/onboarding/status", () => {
      return HttpResponse.json({
        needsOnboarding: false,
        isAdmin: false,
        hasOrg: true,
        hasDefaultAgent: true,
        defaultAgentId: MOCK_MEMBER_AGENT_ID,
        defaultAgentMetadata: { displayName: "Zero" },
        defaultAgentSkills: [],
      });
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

async function walkAdminToWhereStep(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => {
    expect(screen.getByText(/Name your workspace/)).toBeInTheDocument();
  });

  const input = screen.getByPlaceholderText("e.g. Acme Corp");
  await fill(input, "Test Workspace");
  await user.click(screen.getByText("Next"));

  await waitFor(() => {
    expect(screen.getByText("Choose your tools")).toBeInTheDocument();
  });
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

describe("onboarding continue in web → agent chat page", () => {
  it("should navigate to /agents/:id/chat after admin completes full onboarding", async () => {
    const user = userEvent.setup();
    mockAdminOnboarding();

    detachedSetupPage({ context, path: "/onboarding" });
    await walkAdminToWhereStep(user);

    switchToAdminComplete();

    await user.click(screen.getByText(/Continue in web/));

    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${MOCK_AGENT_ID}/chat`);
    });
  });

  it("should navigate to /agents/:id/chat after member completes onboarding", async () => {
    const user = userEvent.setup();
    mockMemberOnboarding();

    detachedSetupPage({ context, path: "/onboarding" });

    // Member with no connectors skips directly to step 4
    await waitFor(() => {
      expect(
        screen.getByText(/Where would you like to work with/),
      ).toBeInTheDocument();
    });

    switchToMemberComplete();

    await user.click(screen.getByText(/Continue in web/));

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
    const user = userEvent.setup();
    mockAdminOnboarding();

    detachedSetupPage({ context, path: "/onboarding" });
    await walkAdminToWhereStep(user);

    switchToAdminComplete();

    await user.click(screen.getByText(/Add .+ to Slack/));

    await waitFor(() => {
      expect(pathname()).toBe("/works");
    });
  });

  it("should navigate to /works after member completes onboarding via Slack", async () => {
    const user = userEvent.setup();
    mockMemberOnboarding();

    detachedSetupPage({ context, path: "/onboarding" });

    // Member with no connectors skips directly to step 4
    await waitFor(() => {
      expect(
        screen.getByText(/Where would you like to work with/),
      ).toBeInTheDocument();
    });

    switchToMemberComplete();

    await user.click(screen.getByText(/Add .+ to Slack/));

    await waitFor(() => {
      expect(pathname()).toBe("/works");
    });
  });
});
