/**
 * Unified chat-threads sidebar behaviour (#10162).
 *
 * When the `unifyChatThreads` feature switch is ON, the sidebar:
 *  - calls `chatThreadsContract.list` WITHOUT an `agentId` query param,
 *  - renders the `"Chats"` title (no "with {agent}" suffix),
 *  - shows per-row agent avatars so threads from different agents are
 *    distinguishable at a glance.
 *
 * When the flag is OFF, the existing per-agent behaviour is preserved
 * (title `"Chats with {agent}"`, scoped request, no per-row avatar).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import {
  chatThreadsContract,
  chatThreadByIdContract,
  chatThreadMessagesContract,
  zeroAgentsByIdContract,
} from "@vm0/core";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { setMockFeatureSwitches } from "../../../mocks/handlers/api-feature-switches.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";

const context = testContext();
const mockApi = createMockApi(context);

const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const SUB_AGENT_ID = "a1111111-0000-4000-a000-000000000001";

interface ListQuery {
  agentId?: string;
}

function mockUnifiedThreads(observedQueries: ListQuery[]) {
  setMockTeam([
    {
      id: DEFAULT_AGENT_ID,
      displayName: "Zero",
      description: null,
      sound: null,
      avatarUrl: null,
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
    {
      id: SUB_AGENT_ID,
      displayName: "Helper",
      description: null,
      sound: null,
      avatarUrl: null,
      headVersionId: "version_2",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ]);
  server.use(
    mockApi(chatThreadsContract.list, ({ query, respond }) => {
      observedQueries.push({ agentId: query.agentId });
      return respond(200, {
        threads: [
          {
            id: "thread-default",
            title: "Default thread",
            agentId: DEFAULT_AGENT_ID,
            agent: { id: DEFAULT_AGENT_ID, avatarUrl: null },
            createdAt: "2026-03-10T00:00:00Z",
            updatedAt: "2026-03-10T00:00:00Z",
            isRead: true,
            isArchived: false,
            running: false,
          },
          {
            id: "thread-sub",
            title: "Sub thread",
            agentId: SUB_AGENT_ID,
            agent: { id: SUB_AGENT_ID, avatarUrl: null },
            createdAt: "2026-03-09T00:00:00Z",
            updatedAt: "2026-03-09T00:00:00Z",
            isRead: true,
            isArchived: false,
            running: false,
          },
        ],
      });
    }),
    mockApi(chatThreadByIdContract.get, ({ params, respond }) => {
      return respond(200, {
        id: params.id,
        title: null,
        agentId: DEFAULT_AGENT_ID,
        chatMessages: [],
        latestSessionId: null,
        activeRunIds: [],
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      });
    }),
    mockApi(chatThreadMessagesContract.list, ({ respond }) => {
      return respond(200, { messages: [] });
    }),
    mockApi(zeroAgentsByIdContract.get, ({ params, respond }) => {
      const agents: Record<
        string,
        {
          agentId: string;
          displayName: string;
          ownerId: string;
          description: null;
          sound: null;
          avatarUrl: null;
          permissionPolicies: null;
          customSkills: string[];
        }
      > = {
        [DEFAULT_AGENT_ID]: {
          agentId: DEFAULT_AGENT_ID,
          ownerId: "test-user",
          displayName: "Zero",
          description: null,
          sound: null,
          avatarUrl: null,
          permissionPolicies: null,
          customSkills: [],
        },
        [SUB_AGENT_ID]: {
          agentId: SUB_AGENT_ID,
          ownerId: "test-user",
          displayName: "Helper",
          description: null,
          sound: null,
          avatarUrl: null,
          permissionPolicies: null,
          customSkills: [],
        },
      };
      const agent = agents[params.id];
      if (!agent) {
        return respond(404, {
          error: { message: "Not found", code: "NOT_FOUND" },
        });
      }
      return respond(200, agent);
    }),
  );
}

function getSidebar(): HTMLElement {
  return screen.getByRole("navigation", { name: "Sidebar" });
}

describe("sidebar unify chat threads (#10162)", () => {
  beforeEach(() => {
    setMockFeatureSwitches({});
  });

  it("calls list with no agentId when unifyChatThreads is ON", async () => {
    setMockFeatureSwitches({ unifyChatThreads: true });
    const observed: ListQuery[] = [];
    mockUnifiedThreads(observed);
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(
        within(getSidebar()).getByText("Default thread"),
      ).toBeInTheDocument();
      expect(within(getSidebar()).getByText("Sub thread")).toBeInTheDocument();
    });
    // At least one call went through without agentId — the unified request shape.
    expect(
      observed.some((q) => {
        return q.agentId === undefined;
      }),
    ).toBeTruthy();
  });

  it("renders the flag-on title 'Chats' (without agent suffix)", async () => {
    setMockFeatureSwitches({ unifyChatThreads: true });
    const observed: ListQuery[] = [];
    mockUnifiedThreads(observed);
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(within(getSidebar()).getByText("Chats")).toBeInTheDocument();
    });
    expect(
      within(getSidebar()).queryByText(/^Chats with /),
    ).not.toBeInTheDocument();
  });

  it("renders the legacy title 'Chats with {agent}' when the flag is OFF", async () => {
    setMockFeatureSwitches({ unifyChatThreads: false });
    const observed: ListQuery[] = [];
    mockUnifiedThreads(observed);
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(
        within(getSidebar()).getByText(/^Chats with /),
      ).toBeInTheDocument();
    });
    // Every list call must carry an agentId — no unscoped fallback.
    expect(
      observed.every((q) => {
        return typeof q.agentId === "string";
      }),
    ).toBeTruthy();
  });
});
