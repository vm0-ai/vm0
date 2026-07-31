import {
  zeroTeamContract,
  type TeamComposeItem,
} from "@vm0/api-contracts/contracts/zero-team";
import { zeroAgentCustomConnectorsContract } from "@vm0/api-contracts/contracts/zero-agent-custom-connectors";
import { zeroComposesListContract } from "@vm0/api-contracts/contracts/zero-composes";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import {
  zeroAgentsByIdContract,
  zeroAgentInstructionsContract,
  zeroAgentDraftContract,
} from "@vm0/api-contracts/contracts/zero-agents";
import {
  chatThreadsContract,
  chatThreadByIdContract,
  chatThreadDraftContract,
  chatThreadMarkAgentReadContract,
  chatThreadMarkReadContract,
  chatThreadComputerUseHostContract,
  chatThreadModelSelectionContract,
  chatThreadEventsContract,
  chatThreadArtifactsContract,
  artifactsContract,
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
const mockEnabledConnectorSlugsByAgent = new Map<string, string[]>();
const mockEnabledCustomConnectorIdsByAgent = new Map<string, string[]>();

export function setMockComposesList(composes: ComposeListItem[]): void {
  mockComposesList = composes;
}

export function resetMockComposesList(): void {
  mockComposesList = [...DEFAULT_COMPOSES_LIST];
}

export function resetMockUserConnectors(): void {
  mockEnabledConnectorSlugsByAgent.clear();
  mockEnabledCustomConnectorIdsByAgent.clear();
}

function mockConnectorUpdateResponse(
  current: readonly string[],
  requested: readonly string[],
  operation: "replace" | "add" | "remove" | undefined,
): string[] {
  if (operation === "add") {
    return Array.from(new Set([...current, ...requested]));
  }
  if (operation === "remove") {
    return current.filter((value) => {
      return !requested.includes(value);
    });
  }
  return [...requested];
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

  // GET /api/zero/agents/:id/user-connectors
  mockApi(zeroUserConnectorsContract.get, ({ params, respond }) => {
    const enabledConnectorSlugs =
      mockEnabledConnectorSlugsByAgent.get(params.id) ?? [];
    return respond(200, {
      enabledConnectorSlugs,
    });
  }),

  // GET /api/zero/agents/:id/custom-connectors
  mockApi(zeroAgentCustomConnectorsContract.get, ({ params, respond }) => {
    return respond(200, {
      enabledIds: mockEnabledCustomConnectorIdsByAgent.get(params.id) ?? [],
    });
  }),

  // PUT /api/zero/agents/:id/user-connectors
  mockApi(zeroUserConnectorsContract.update, ({ body, params, respond }) => {
    const enabledConnectorSlugs = mockConnectorUpdateResponse(
      mockEnabledConnectorSlugsByAgent.get(params.id) ?? [],
      body.enabledConnectorSlugs,
      body.operation,
    );
    mockEnabledConnectorSlugsByAgent.set(params.id, enabledConnectorSlugs);
    return respond(200, {
      enabledConnectorSlugs,
    });
  }),

  // PUT /api/zero/agents/:id/custom-connectors
  mockApi(
    zeroAgentCustomConnectorsContract.update,
    ({ body, params, respond }) => {
      const requestedIds =
        "enabledIds" in body
          ? body.enabledIds
          : body.grants.map((grant) => {
              return grant.customConnectorId;
            });
      const enabledIds = mockConnectorUpdateResponse(
        mockEnabledCustomConnectorIdsByAgent.get(params.id) ?? [],
        requestedIds,
        body.operation,
      );
      mockEnabledCustomConnectorIdsByAgent.set(params.id, enabledIds);
      return respond(200, { enabledIds });
    },
  ),

  // GET /api/zero/agents/:id
  mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
    return respond(200, {
      agentId: "c0000000-0000-4000-a000-000000000001",
      ownerId: "test-user-123",
      description: null,
      displayName: null,
      sound: null,
      avatarUrl: null,
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

  // GET /api/zero/agents/:id/draft
  mockApi(zeroAgentDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftUserMessage: null,
      draftAttachments: null,
    });
  }),

  // PATCH /api/zero/agents/:id/draft
  mockApi(zeroAgentDraftContract.patch, ({ respond }) => {
    return respond(204);
  }),

  // GET /api/zero/chat-threads/snapshot
  mockApi(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(200, {
      chatThreads: [],
      latestEventId: null,
      latestSeqId: null,
    });
  }),

  // GET /api/zero/chat-threads/events
  mockApi(chatThreadsContract.events, ({ respond }) => {
    return respond(200, {
      events: [],
      hasMore: false,
    });
  }),

  // GET /api/zero/chat-threads/active-ids
  mockApi(chatThreadsContract.activeIds, ({ respond }) => {
    return respond(200, { threadIds: [] });
  }),

  // GET /api/zero/chat-thread-drafts
  mockApi(chatThreadsContract.drafts, ({ respond }) => {
    return respond(200, { draftThreadIds: [] });
  }),

  // POST /api/zero/chat-threads (create new thread)
  mockApi(chatThreadsContract.create, ({ body, respond }) => {
    return respond(201, {
      id: body.clientThreadId ?? "b0000000-0000-4000-a000-000000000001",
      title: null,
      createdAt: "2026-03-10T00:00:00Z",
    });
  }),

  // GET /api/zero/chat-threads/:threadId/events (paged events)
  mockApi(chatThreadEventsContract.list, ({ respond }) => {
    return respond(200, { events: [] });
  }),

  // GET /api/zero/chat-threads/:threadId/artifacts
  mockApi(chatThreadArtifactsContract.list, ({ respond }) => {
    return respond(200, { runs: [] });
  }),

  // GET /api/zero/artifacts
  mockApi(artifactsContract.list, ({ respond }) => {
    return respond(200, { artifacts: [], truncated: false, nextCursor: null });
  }),

  // GET /api/zero/chat-threads/:id (thread detail)
  mockApi(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      lastReadAt: "2026-03-10T00:00:00Z",
    });
  }),

  // GET /api/zero/chat-threads/:id/draft
  mockApi(chatThreadDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftUserMessage: null,
      draftAttachments: null,
    });
  }),

  // PATCH /api/zero/chat-threads/:id (update draft)
  mockApi(chatThreadByIdContract.patch, ({ respond }) => {
    return respond(204);
  }),

  // POST /api/zero/chat-threads/:id/model-selection
  mockApi(chatThreadModelSelectionContract.update, ({ respond }) => {
    return respond(204);
  }),

  // POST /api/zero/chat-threads/:id/computer-use-host
  mockApi(chatThreadComputerUseHostContract.update, ({ respond }) => {
    return respond(204);
  }),

  // GET /api/zero/chat-thread-unreads
  mockApi(chatThreadsContract.unreads, ({ respond }) => {
    return respond(200, { unreads: [] });
  }),

  // GET /api/zero/chat-thread-unread-agents
  mockApi(chatThreadsContract.unreadAgents, ({ respond }) => {
    return respond(200, { agentIds: [] });
  }),

  // POST /api/zero/chat-thread-unreads/mark-read
  mockApi(chatThreadMarkAgentReadContract.markAgentRead, ({ respond }) => {
    return respond(204);
  }),

  // POST /api/zero/chat-threads/:id/mark-read
  mockApi(chatThreadMarkReadContract.markRead, ({ respond }) => {
    return respond(200, { lastReadAt: null, unreads: [] });
  }),
];
