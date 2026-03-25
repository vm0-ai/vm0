import { describe, expect, it } from "vitest";
import { screen, waitFor, fireEvent, act } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

/**
 * Mock APIs for default agent detail page.
 * The default agent has id "mock-compose-id" which matches the onboarding
 * status mock's `defaultAgentId`.
 */
function mockDefaultAgentAPIs() {
  server.use(
    http.get("*/api/zero/team", () =>
      HttpResponse.json([
        {
          id: "mock-compose-id",
          name: "zero",
          displayName: "Zero",
          description: null,
          headVersionId: "version_1",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ]),
    ),
    http.get("*/api/zero/chat-threads", () =>
      HttpResponse.json({ threads: [] }),
    ),
    http.get("*/api/zero/agents/mock-compose-id", () =>
      HttpResponse.json({
        name: "zero",
        agentId: "mock-compose-id",
        description: null,
        displayName: "Zero",
        sound: null,
        connectors: [],
      }),
    ),
    http.get("*/api/zero/agents/:name/instructions", () =>
      HttpResponse.json({ instructions: null }),
    ),
    http.get("*/api/zero/schedules", () =>
      HttpResponse.json({ schedules: [] }),
    ),
  );
}

function mockSubAgentAPIs() {
  server.use(
    http.get("*/api/zero/team", () =>
      HttpResponse.json([
        {
          id: "mock-compose-id",
          name: "zero",
          displayName: null,
          description: null,
          headVersionId: "version_1",
          updatedAt: "2024-01-01T00:00:00Z",
        },
        {
          id: "sub-agent-id",
          name: "sub-agent",
          displayName: "Sub Agent",
          description: "A sub agent",
          headVersionId: "version_2",
          updatedAt: "2024-01-02T00:00:00Z",
        },
      ]),
    ),
    http.get("*/api/zero/chat-threads", () =>
      HttpResponse.json({ threads: [] }),
    ),
    http.get("*/api/zero/agents/sub-agent-id", () =>
      HttpResponse.json({
        name: "sub-agent",
        agentId: "sub-agent-id",
        description: "A sub agent",
        displayName: "Sub Agent",
        sound: null,
        connectors: [],
      }),
    ),
    http.get("*/api/zero/agents/:name/instructions", () =>
      HttpResponse.json({ instructions: null }),
    ),
    http.get("*/api/zero/schedules", () =>
      HttpResponse.json({ schedules: [] }),
    ),
  );
}

describe("team detail page - avatar cycling", () => {
  it("should cycle through all 5 avatars for default agent", async () => {
    mockDefaultAgentAPIs();
    await setupPage({ context, path: "/team/mock-compose-id" });

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Zero" })).toBeInTheDocument();
    });

    const avatarButton = screen.getByRole("button", {
      name: "Switch avatar",
    });
    const avatarImg = avatarButton.querySelector("img");
    expect(avatarImg).toBeTruthy();

    // Collect unique avatar srcs across 5 cycles (should see all ZERO_AVATARS)
    const srcs = new Set<string>();
    srcs.add(avatarImg!.src);

    for (let i = 0; i < 5; i++) {
      await act(() => {
        fireEvent.click(avatarButton);
      });
      srcs.add(avatarImg!.src);
    }

    // Default agent has 5 avatars (avatar_0 through avatar_4)
    expect(srcs.size).toBe(5);
  });

  it("should cycle through only 4 avatars for sub-agent", async () => {
    mockSubAgentAPIs();
    await setupPage({ context, path: "/team/sub-agent-id" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Sub Agent" }),
      ).toBeInTheDocument();
    });

    const avatarButton = screen.getByRole("button", {
      name: "Switch avatar",
    });
    const avatarImg = avatarButton.querySelector("img");
    expect(avatarImg).toBeTruthy();

    // Collect unique avatar srcs across 4 cycles (should see all AGENT_AVATARS)
    const srcs = new Set<string>();
    srcs.add(avatarImg!.src);

    for (let i = 0; i < 4; i++) {
      await act(() => {
        fireEvent.click(avatarButton);
      });
      srcs.add(avatarImg!.src);
    }

    // Sub-agent has 4 avatars (avatar_1 through avatar_4)
    expect(srcs.size).toBe(4);
  });
});
