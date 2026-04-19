/**
 * Agents API Handlers
 *
 * Mock handlers for agent-related endpoints.
 * Default behavior: user has one agent.
 */

import {
  zeroTeamContract,
  zeroComposesListContract,
  zeroComposesByIdContract,
  zeroUserConnectorsContract,
  zeroAgentsByIdContract,
  zeroAgentInstructionsContract,
  zeroSchedulesMainContract,
  chatThreadsContract,
  chatThreadByIdContract,
  chatThreadMarkReadContract,
  chatThreadMessagesContract,
  type ComposeListItem,
} from "@vm0/core";
import { mockApi } from "../msw-contract.ts";

const DEFAULT_COMPOSES_LIST: ComposeListItem[] = [
  {
    id: "c0000000-0000-4000-a000-000000000001",
    name: "zero",
    displayName: null,
    description: null,
    sound: null,
    headVersionId: "version_1",
    updatedAt: "2024-01-01T00:00:00Z",
  },
];

let mockComposesList: ComposeListItem[] = [...DEFAULT_COMPOSES_LIST];

export function setMockComposesList(composes: ComposeListItem[]): void {
  mockComposesList = composes;
}

export function resetMockComposesList(): void {
  mockComposesList = [...DEFAULT_COMPOSES_LIST];
}

export const apiAgentsHandlers = [
  // GET /api/zero/team
  mockApi(zeroTeamContract.list, ({ respond }) => {
    return respond(200, [
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
  }),

  // GET /api/zero/composes/list
  mockApi(zeroComposesListContract.list, ({ respond }) => {
    return respond(200, { composes: mockComposesList });
  }),

  // GET /api/zero/composes/:id (kept for backwards compat with other tests)
  mockApi(zeroComposesByIdContract.getById, ({ params, respond }) => {
    return respond(200, {
      id: params.id,
      name: "zero",
      headVersionId: "version_1",
      content: {
        version: "1",
        agents: { zero: { framework: "claude-code" } },
      },
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    });
  }),

  // GET /api/zero/agents/:id/user-connectors
  mockApi(zeroUserConnectorsContract.get, ({ respond }) => {
    return respond(200, { enabledTypes: [] });
  }),

  // PUT /api/zero/agents/:id/user-connectors
  mockApi(zeroUserConnectorsContract.update, ({ body, respond }) => {
    return respond(200, { enabledTypes: body.enabledTypes });
  }),

  // GET /api/zero/agents/:id
  mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
    return respond(200, {
      agentId: "c0000000-0000-4000-a000-000000000001",
      ownerId: "test-user-123",
      description: null,
      displayName: null,
      sound: null,
      avatarUrl: null,
      permissionPolicies: null,
      customSkills: [],
    });
  }),

  // GET /api/zero/agents/:id/instructions
  mockApi(zeroAgentInstructionsContract.get, ({ respond }) => {
    return respond(200, {
      content: null,
      filename: null,
    });
  }),

  // GET /api/zero/schedules
  mockApi(zeroSchedulesMainContract.list, ({ respond }) => {
    return respond(200, { schedules: [] });
  }),

  // GET /api/zero/chat-threads
  mockApi(chatThreadsContract.list, ({ respond }) => {
    return respond(200, { threads: [] });
  }),

  // POST /api/zero/chat-threads (create new thread)
  mockApi(chatThreadsContract.create, ({ respond }) => {
    return respond(201, {
      id: "b0000000-0000-4000-a000-000000000001",
      title: null,
      createdAt: "2026-03-10T00:00:00Z",
    });
  }),

  // GET /api/zero/chat-threads/:threadId/messages (paged messages)
  mockApi(chatThreadMessagesContract.list, ({ respond }) => {
    return respond(200, { messages: [], hasMore: false });
  }),

  // GET /api/zero/chat-threads/:id (thread detail)
  mockApi(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      id: "b0000000-0000-4000-a000-000000000001",
      title: null,
      agentId: "c0000000-0000-4000-a000-000000000001",
      chatMessages: [],
      latestSessionId: null,
      activeRunIds: [],
      createdAt: "2026-03-10T00:00:00Z",
      updatedAt: "2026-03-10T00:00:00Z",
      draftContent: null,
      draftAttachments: null,
    });
  }),

  // PATCH /api/zero/chat-threads/:id (update draft)
  mockApi(chatThreadByIdContract.patch, ({ respond }) => {
    return respond(204);
  }),

  // POST /api/zero/chat-threads/:id/mark-read
  mockApi(chatThreadMarkReadContract.markRead, ({ respond }) => {
    return respond(200, { lastReadAt: new Date().toISOString() });
  }),
];
