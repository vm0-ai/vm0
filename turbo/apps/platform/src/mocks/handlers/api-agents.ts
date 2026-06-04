import {
  zeroTeamContract,
  type TeamComposeItem,
} from "@vm0/api-contracts/contracts/zero-team";
import {
  zeroComposesListContract,
  zeroComposesByIdContract,
} from "@vm0/api-contracts/contracts/zero-composes";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import {
  zeroAgentsByIdContract,
  zeroAgentInstructionsContract,
} from "@vm0/api-contracts/contracts/zero-agents";
import {
  chatThreadsContract,
  chatThreadByIdContract,
  chatThreadMarkReadContract,
  chatThreadMessagesContract,
  chatThreadArtifactsContract,
  chatThreadGithubPrsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import type { ComposeListItem } from "@vm0/api-contracts/contracts/composes";
import { mockApi } from "../msw-contract.ts";

const DEFAULT_TEAM: TeamComposeItem[] = [
  {
    id: "c0000000-0000-4000-a000-000000000001",
    displayName: null,
    description: null,
    sound: null,
    avatarUrl: null,
    customSkills: [],
    headVersionId: "version_1",
    updatedAt: "2024-01-01T00:00:00Z",
  },
];

let mockTeam: TeamComposeItem[] = [...DEFAULT_TEAM];

export function setMockTeam(team: TeamComposeItem[]): void {
  mockTeam = team;
}

export function resetMockTeam(): void {
  mockTeam = [...DEFAULT_TEAM];
}

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
    return respond(200, mockTeam);
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
      customSkills: [],
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
    });
  }),

  // GET /api/zero/agents/:id/instructions
  mockApi(zeroAgentInstructionsContract.get, ({ respond }) => {
    return respond(200, {
      content: null,
      filename: null,
    });
  }),

  // GET /api/zero/chat-threads
  mockApi(chatThreadsContract.list, ({ respond }) => {
    return respond(200, {
      pinned: [],
      threads: [],
      hasMore: false,
      nextCursor: null,
      totalCount: 0,
    });
  }),

  // POST /api/zero/chat-threads (create new thread)
  mockApi(chatThreadsContract.create, ({ body, respond }) => {
    return respond(201, {
      id: body.clientThreadId ?? "b0000000-0000-4000-a000-000000000001",
      title: null,
      createdAt: "2026-03-10T00:00:00Z",
    });
  }),

  // GET /api/zero/chat-threads/:threadId/messages (paged messages)
  mockApi(chatThreadMessagesContract.list, ({ respond }) => {
    return respond(200, { messages: [] });
  }),

  // GET /api/zero/chat-threads/:threadId/artifacts
  mockApi(chatThreadArtifactsContract.list, ({ respond }) => {
    return respond(200, { runs: [] });
  }),

  // GET /api/zero/chat-threads/:threadId/github-prs
  mockApi(chatThreadGithubPrsContract.list, ({ respond }) => {
    return respond(200, { prs: [] });
  }),

  // GET /api/zero/chat-threads/:id (thread detail)
  mockApi(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      id: "b0000000-0000-4000-a000-000000000001",
      title: null,
      agentId: "c0000000-0000-4000-a000-000000000001",
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
    return respond(200, { lastReadMessageId: null, changed: false });
  }),
];
