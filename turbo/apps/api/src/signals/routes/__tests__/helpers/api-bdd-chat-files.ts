import { randomUUID } from "node:crypto";

import {
  artifactsContract,
  chatMessagesContract,
  chatSearchContract,
  chatThreadArtifactsContract,
  chatThreadByIdContract,
  chatThreadComputerUseHostContract,
  chatThreadDraftContract,
  chatThreadMarkAgentReadContract,
  chatThreadMarkReadContract,
  chatThreadModelSelectionContract,
  chatThreadPinContract,
  chatThreadRenameContract,
  chatThreadUnpinContract,
  chatThreadsContract,
  chatThreadMessagesContract,
  type AttachFile,
  type ArtifactFavoritesResponse,
  type ArtifactsListResponse,
  type ChatSearchResponse,
  type ChatThreadArtifactRun,
  type ChatThreadDetail,
  type ChatThreadDraft,
  type ChatThreadSnapshotProjection,
  type ChatRunOptionsRequest,
  type CodexServiceTier,
  type GenerationTemplateRequest,
  type PagedChatMessage,
  type PersistedAttachment,
  type UserMessageDocument,
} from "@vm0/api-contracts/contracts/chat-threads";
import {
  artifactCatalogContract,
  type ArtifactCatalogKind,
  type ArtifactDetail,
  type ArtifactSummary,
} from "@vm0/api-contracts/contracts/artifact-catalog";
import { composesMainContract } from "@vm0/api-contracts/contracts/composes";
import type { ApiErrorResponse } from "@vm0/api-contracts/contracts/errors";
import { DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL } from "@vm0/api-contracts/contracts/model-providers";
import {
  addClientCapabilityToVersion,
  CLIENT_CAPABILITY_STRUCTURED_FEEDBACK_PARTS,
  CLIENT_VERSION_HEADER,
} from "@vm0/api-contracts/contracts/client-headers";
import { zeroModelPoliciesMainContract } from "@vm0/api-contracts/contracts/zero-model-policies";
import {
  zeroHostContract,
  type HostedSiteCompleteResponse,
  type HostedSitePrepareRequest,
  type HostedSitePrepareResponse,
} from "@vm0/api-contracts/contracts/zero-host";
import {
  zeroUploadsContract,
  type UploadCompleteResponse,
  type UploadPrepareResponse,
} from "@vm0/api-contracts/contracts/zero-uploads";
import { setupAppWithRoutes } from "../../../../__tests__/test-app";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { agentComposesReadRoutes } from "../../agent-composes-read";
import { agentComposesRoutes } from "../../agent-composes";
import { zeroChatMessagesRoutes } from "../../zero-chat-messages";
import { zeroArtifactCatalogRoutes } from "../../zero-artifact-catalog";
import { zeroArtifactsRoutes } from "../../zero-artifacts";
import { zeroChatThreadComputerUseHostRoutes } from "../../zero-chat-threads-computer-use-host";
import { zeroChatThreadCreateRoutes } from "../../zero-chat-threads-create";
import { zeroChatThreadDeleteRoutes } from "../../zero-chat-threads-delete";
import { zeroChatThreadMarkReadRoutes } from "../../zero-chat-threads-mark-read";
import { zeroChatThreadModelSelectionRoutes } from "../../zero-chat-threads-model-selection";
import { zeroChatThreadPatchRoutes } from "../../zero-chat-threads-patch";
import { zeroChatThreadPinRoutes } from "../../zero-chat-threads-pin";
import { zeroChatThreadRenameRoutes } from "../../zero-chat-threads-rename";
import { zeroChatThreadRoutes } from "../../zero-chat-threads";
import { zeroChatThreadUnpinRoutes } from "../../zero-chat-threads-unpin";
import { zeroChatThreadsArtifactsSyncRoutes } from "../../zero-chat-threads-artifacts-sync";
import { zeroHostRoutes } from "../../zero-host";
import { zeroModelPoliciesRoutes } from "../../zero-model-policies";
import { zeroUploadsCompleteRoutes } from "../../zero-uploads-complete";
import { zeroUploadsPrepareRoutes } from "../../zero-uploads-prepare";
import type { ApiTestUser } from "./api-bdd";
import { createZeroRouteMocks } from "./zero-route-test";
export { hostedTextFile } from "./api-bdd-host-files";

interface AuthHeaders {
  readonly authorization?: string;
  readonly [CLIENT_VERSION_HEADER]?: string;
}

const BDD_CLIENT_VERSION = addClientCapabilityToVersion(
  "0.636.1",
  CLIENT_CAPABILITY_STRUCTURED_FEEDBACK_PARTS,
);

interface BddCompose {
  readonly composeId: string;
  readonly name: string;
  readonly versionId: string;
  readonly action: "created" | "existing";
  readonly updatedAt: string;
}

type BddSendMessageBody =
  | {
      readonly agentId: string;
      readonly prompt: string;
      readonly threadId?: string;
      readonly clientThreadId?: string;
      readonly model?: string;
      readonly runOptions?: ChatRunOptionsRequest;
      readonly structuredPrompt?: UserMessageDocument;
      readonly generationTemplate?: GenerationTemplateRequest;
      readonly hasTextContent?: boolean;
      readonly attachFiles?: readonly AttachFile[];
      readonly computerUseHostId?: string | null;
      readonly cloudBrowserEnabled?: boolean;
      readonly clientMessageId?: string;
      readonly chatThreadSortEventId?: string;
      readonly realAgentInPreview?: boolean;
      readonly revokesMessageId?: string;
    }
  | {
      readonly agentId: string;
      readonly threadId: string;
      readonly revokesMessageId: string;
      readonly clientMessageId?: string;
    }
  | {
      readonly agentId: string;
      readonly threadId: string;
      readonly interruptsRunId: string;
      readonly clientMessageId?: string;
    };

function authHeaders(actor: ApiTestUser | null): AuthHeaders {
  return actor
    ? {
        authorization: "Bearer clerk-session",
        [CLIENT_VERSION_HEADER]: BDD_CLIENT_VERSION,
      }
    : {};
}

function authenticate(
  context: TestContext,
  actor: ApiTestUser | null,
): AuthHeaders {
  if (!actor) {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    return {};
  }

  createZeroRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return authHeaders(actor);
}

function commandName(command: unknown): string {
  return typeof command === "object" && command !== null
    ? command.constructor.name
    : "";
}

function mockObjectStorageObjectsExist(context: TestContext): void {
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const name = commandName(command);
    if (name === "HeadObjectCommand") {
      return Promise.resolve({ ContentLength: 1024 });
    }
    return Promise.resolve({});
  });
}

const chatFilesRoutes = [
  ...agentComposesRoutes,
  ...agentComposesReadRoutes,
  ...zeroArtifactCatalogRoutes,
  ...zeroArtifactsRoutes,
  ...zeroChatThreadRoutes,
  ...zeroChatThreadCreateRoutes,
  ...zeroChatThreadDeleteRoutes,
  ...zeroChatThreadPatchRoutes,
  ...zeroChatThreadMarkReadRoutes,
  ...zeroChatThreadPinRoutes,
  ...zeroChatThreadUnpinRoutes,
  ...zeroChatThreadRenameRoutes,
  ...zeroChatThreadModelSelectionRoutes,
  ...zeroChatThreadComputerUseHostRoutes,
  ...zeroChatThreadsArtifactsSyncRoutes,
  ...zeroChatMessagesRoutes,
  ...zeroUploadsPrepareRoutes,
  ...zeroUploadsCompleteRoutes,
  ...zeroHostRoutes,
  ...zeroModelPoliciesRoutes,
] as const;

function chatFilesApp(context: TestContext) {
  return setupAppWithRoutes({ context, routes: chatFilesRoutes });
}

export function persistedAttachment(
  id: string,
  filename: string,
  contentType: string,
  size: number,
): PersistedAttachment {
  return {
    id,
    filename,
    contentType,
    size,
    url: `https://cdn.vm7.io/artifacts/test/${id}/${filename}`,
  };
}

export function createChatFilesBddApi(context: TestContext) {
  const mocks = createZeroRouteMocks(context);

  function composeClient() {
    return chatFilesApp(context)(composesMainContract);
  }

  function threadsClient() {
    return chatFilesApp(context)(chatThreadsContract);
  }

  function modelPoliciesClient() {
    return chatFilesApp(context)(zeroModelPoliciesMainContract);
  }

  async function defaultCreateThreadModel(
    actor: ApiTestUser | null,
  ): Promise<string> {
    if (!actor?.orgId) {
      return DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL;
    }
    const response = await accept(
      modelPoliciesClient().list({ headers: authenticate(context, actor) }),
      [200],
    );
    return (
      response.body.workspaceDefaultModel ??
      DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL
    );
  }

  function threadByIdClient() {
    return chatFilesApp(context)(chatThreadByIdContract);
  }

  function threadDraftClient() {
    return chatFilesApp(context)(chatThreadDraftContract);
  }

  function threadMessagesClient() {
    return chatFilesApp(context)(chatThreadMessagesContract);
  }

  function threadArtifactsClient() {
    return chatFilesApp(context)(chatThreadArtifactsContract);
  }

  function artifactsClient() {
    return chatFilesApp(context)(artifactsContract);
  }

  function artifactCatalogClient() {
    return chatFilesApp(context)(artifactCatalogContract);
  }

  function threadMarkReadClient() {
    return chatFilesApp(context)(chatThreadMarkReadContract);
  }

  function threadMarkAgentReadClient() {
    return chatFilesApp(context)(chatThreadMarkAgentReadContract);
  }

  function threadPinClient() {
    return chatFilesApp(context)(chatThreadPinContract);
  }

  function threadUnpinClient() {
    return chatFilesApp(context)(chatThreadUnpinContract);
  }

  function threadRenameClient() {
    return chatFilesApp(context)(chatThreadRenameContract);
  }

  function threadModelSelectionClient() {
    return chatFilesApp(context)(chatThreadModelSelectionContract);
  }

  function threadComputerUseHostClient() {
    return chatFilesApp(context)(chatThreadComputerUseHostContract);
  }

  function chatMessagesClient() {
    return chatFilesApp(context)(chatMessagesContract);
  }

  function chatSearchClient() {
    return chatFilesApp(context)(chatSearchContract);
  }

  /**
   * Raw-bearer auth headers for tokens that are not Clerk sessions (PATs,
   * run-scoped sandbox tokens). Forces the Clerk fall-through branch to
   * report unauthenticated so a stale session mock can never leak in.
   */
  function bearerAuth(authorization: string | undefined): AuthHeaders {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    return authorization === undefined ? {} : { authorization };
  }

  function uploadsClient() {
    return chatFilesApp(context)(zeroUploadsContract);
  }

  function hostClient() {
    return chatFilesApp(context)(zeroHostContract);
  }

  return {
    mockCompletedUploadObject(
      actor: ApiTestUser,
      uploadId: string,
      filename: string,
      size: number,
    ): void {
      mocks.s3.listObjects([
        {
          bucket: "test-user-artifacts",
          key: `artifacts/${actor.userId}/${uploadId}/${filename}`,
          size,
        },
      ]);
    },

    mockObjectStorageObjectsExist(): void {
      mockObjectStorageObjectsExist(context);
    },

    async createComposeForChatThread(
      actor: ApiTestUser,
      agentName = `bdd-chat-${randomUUID().slice(0, 8)}`,
    ): Promise<BddCompose> {
      const response = await accept(
        composeClient().create({
          headers: authenticate(context, actor),
          body: {
            content: {
              version: "1.0",
              agents: {
                [agentName]: {
                  framework: "claude-code",
                },
              },
            },
          },
        }),
        [200, 201],
      );
      return response.body;
    },

    async createThread(
      actor: ApiTestUser,
      body: {
        readonly agentId: string;
        readonly title?: string;
        readonly clientThreadId?: string;
        readonly eventId?: string;
        readonly model?: string;
      },
    ): Promise<{ readonly id: string; readonly title: string | null }> {
      const response = await accept(
        threadsClient().create({
          headers: authenticate(context, actor),
          body: {
            agentId: body.agentId,
            ...(body.title === undefined ? {} : { title: body.title }),
            ...(body.clientThreadId === undefined
              ? {}
              : { clientThreadId: body.clientThreadId }),
            ...(body.eventId === undefined ? {} : { eventId: body.eventId }),
            model: body.model ?? (await defaultCreateThreadModel(actor)),
          },
        }),
        [201],
      );
      return response.body;
    },

    async requestCreateThread(
      actor: ApiTestUser | null,
      body: {
        readonly agentId: string;
        readonly title?: string;
        readonly clientThreadId?: string;
        readonly eventId?: string;
        readonly model?: string;
      },
      statuses: readonly (201 | 400 | 401 | 402 | 404)[],
    ) {
      return await accept(
        threadsClient().create({
          headers: authenticate(context, actor),
          body: {
            agentId: body.agentId,
            ...(body.title === undefined ? {} : { title: body.title }),
            ...(body.clientThreadId === undefined
              ? {}
              : { clientThreadId: body.clientThreadId }),
            ...(body.eventId === undefined ? {} : { eventId: body.eventId }),
            model: body.model ?? (await defaultCreateThreadModel(actor)),
          },
        }),
        statuses,
      );
    },

    async getThreadSnapshot(actor: ApiTestUser): Promise<{
      readonly chatThreads: readonly ChatThreadSnapshotProjection[];
      readonly latestEventId: string | null;
    }> {
      const response = await accept(
        threadsClient().snapshot({
          headers: authenticate(context, actor),
        }),
        [200],
      );
      return response.body;
    },

    async requestThreadEvents(
      actor: ApiTestUser,
      query: { readonly sinceEventId?: string },
      statuses: readonly (200 | 410)[],
    ) {
      return await accept(
        threadsClient().events({
          headers: authenticate(context, actor),
          query,
        }),
        statuses,
      );
    },

    async listThreadDrafts(actor: ApiTestUser): Promise<readonly string[]> {
      const response = await accept(
        threadsClient().drafts({
          headers: authenticate(context, actor),
          query: {},
        }),
        [200],
      );
      return response.body.draftThreadIds;
    },

    async listThreadUnreads(
      actor: ApiTestUser,
      agentId: string,
    ): Promise<readonly { threadId: string; unreadAt: string }[]> {
      const response = await accept(
        threadsClient().unreads({
          headers: authenticate(context, actor),
          query: { agentId },
        }),
        [200],
      );
      return response.body.unreads;
    },

    async listActiveChatThreadIds(
      actor: ApiTestUser,
    ): Promise<readonly string[]> {
      const response = await accept(
        threadsClient().activeIds({
          headers: authenticate(context, actor),
        }),
        [200],
      );
      return response.body.threadIds;
    },

    async requestListUnreadAgents(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 403)[],
    ) {
      return await accept(
        threadsClient().unreadAgents({
          headers: authenticate(context, actor),
        }),
        statuses,
      );
    },

    async listUnreadAgents(actor: ApiTestUser): Promise<readonly string[]> {
      const response = await accept(
        threadsClient().unreadAgents({
          headers: authenticate(context, actor),
        }),
        [200],
      );
      return response.body.agentIds;
    },

    async markAgentThreadsRead(
      actor: ApiTestUser,
      agentId: string,
    ): Promise<void> {
      await accept(
        threadMarkAgentReadClient().markAgentRead({
          headers: authenticate(context, actor),
          body: { agentId },
        }),
        [204],
      );
    },

    async requestMarkAgentThreadsRead(
      actor: ApiTestUser | null,
      agentId: string,
      statuses: readonly (204 | 400 | 401 | 403)[],
    ) {
      return await accept(
        threadMarkAgentReadClient().markAgentRead({
          headers: authenticate(context, actor),
          body: { agentId },
        }),
        statuses,
      );
    },

    async readThread(
      actor: ApiTestUser,
      threadId: string,
    ): Promise<ChatThreadDetail> {
      const response = await accept(
        threadByIdClient().get({
          headers: authenticate(context, actor),
          params: { id: threadId },
        }),
        [200],
      );
      return response.body;
    },

    async requestReadThread(
      actor: ApiTestUser | null,
      threadId: string,
      statuses: readonly (200 | 400 | 401 | 404)[],
    ) {
      return await accept(
        threadByIdClient().get({
          headers: authenticate(context, actor),
          params: { id: threadId },
        }),
        statuses,
      );
    },

    async readThreadDraft(
      actor: ApiTestUser,
      threadId: string,
    ): Promise<ChatThreadDraft> {
      const response = await accept(
        threadDraftClient().get({
          headers: authenticate(context, actor),
          params: { id: threadId },
        }),
        [200],
      );
      return response.body;
    },

    async requestReadThreadDraft(
      actor: ApiTestUser | null,
      threadId: string,
      statuses: readonly (200 | 400 | 401 | 404)[],
    ) {
      return await accept(
        threadDraftClient().get({
          headers: authenticate(context, actor),
          params: { id: threadId },
        }),
        statuses,
      );
    },

    async patchThread(
      actor: ApiTestUser,
      threadId: string,
      body: {
        readonly draftContent?: string | null;
        readonly draftStructuredPrompt?: UserMessageDocument | null;
        readonly draftAttachments?: readonly PersistedAttachment[] | null;
      },
    ): Promise<void> {
      const requestBody = {
        ...(body.draftContent === undefined
          ? {}
          : { draftContent: body.draftContent }),
        ...(body.draftStructuredPrompt === undefined
          ? {}
          : { draftStructuredPrompt: body.draftStructuredPrompt }),
        ...(body.draftAttachments === undefined
          ? {}
          : {
              draftAttachments: body.draftAttachments
                ? [...body.draftAttachments]
                : null,
            }),
      };

      await accept(
        threadByIdClient().patch({
          headers: authenticate(context, actor),
          params: { id: threadId },
          body: requestBody,
        }),
        [204],
      );
    },

    async requestPatchThread(
      actor: ApiTestUser | null,
      threadId: string,
      body: {
        readonly draftContent?: string | null;
        readonly draftStructuredPrompt?: UserMessageDocument | null;
        readonly draftAttachments?: readonly PersistedAttachment[] | null;
      },
      statuses: readonly (204 | 400 | 401 | 404)[],
    ) {
      return await accept(
        threadByIdClient().patch({
          headers: authenticate(context, actor),
          params: { id: threadId },
          body: {
            ...(body.draftContent === undefined
              ? {}
              : { draftContent: body.draftContent }),
            ...(body.draftStructuredPrompt === undefined
              ? {}
              : { draftStructuredPrompt: body.draftStructuredPrompt }),
            ...(body.draftAttachments === undefined
              ? {}
              : {
                  draftAttachments: body.draftAttachments
                    ? [...body.draftAttachments]
                    : null,
                }),
          },
        }),
        statuses,
      );
    },

    async renameThread(
      actor: ApiTestUser,
      threadId: string,
      title: string,
      eventId?: string,
    ): Promise<void> {
      await accept(
        threadRenameClient().rename({
          headers: authenticate(context, actor),
          params: { id: threadId },
          body: { title, ...(eventId === undefined ? {} : { eventId }) },
        }),
        [204],
      );
    },

    async requestRenameThread(
      actor: ApiTestUser | null,
      threadId: string,
      title: string,
      statuses: readonly (204 | 400 | 401 | 404)[],
    ) {
      return await accept(
        threadRenameClient().rename({
          headers: authenticate(context, actor),
          params: { id: threadId },
          body: { title },
        }),
        statuses,
      );
    },

    async pinThread(actor: ApiTestUser, threadId: string): Promise<void> {
      await accept(
        threadPinClient().pin({
          headers: authenticate(context, actor),
          params: { id: threadId },
        }),
        [204],
      );
    },

    async requestPinThread(
      actor: ApiTestUser | null,
      threadId: string,
      statuses: readonly (204 | 400 | 401 | 404)[],
    ) {
      return await accept(
        threadPinClient().pin({
          headers: authenticate(context, actor),
          params: { id: threadId },
        }),
        statuses,
      );
    },

    async unpinThread(actor: ApiTestUser, threadId: string): Promise<void> {
      await accept(
        threadUnpinClient().unpin({
          headers: authenticate(context, actor),
          params: { id: threadId },
        }),
        [204],
      );
    },

    async requestUnpinThread(
      actor: ApiTestUser | null,
      threadId: string,
      statuses: readonly (204 | 400 | 401 | 404)[],
    ) {
      return await accept(
        threadUnpinClient().unpin({
          headers: authenticate(context, actor),
          params: { id: threadId },
        }),
        statuses,
      );
    },

    async markThreadRead(
      actor: ApiTestUser,
      threadId: string,
    ): Promise<{
      readonly lastReadAt: string | null;
      readonly unreads: readonly { threadId: string; unreadAt: string }[];
    }> {
      const response = await accept(
        threadMarkReadClient().markRead({
          headers: authenticate(context, actor),
          params: { id: threadId },
        }),
        [200],
      );
      return response.body;
    },

    async requestMarkThreadRead(
      actor: ApiTestUser | null,
      threadId: string,
      statuses: readonly (200 | 400 | 401 | 404)[],
    ) {
      return await accept(
        threadMarkReadClient().markRead({
          headers: authenticate(context, actor),
          params: { id: threadId },
        }),
        statuses,
      );
    },

    async updateThreadModelSelection(
      actor: ApiTestUser,
      threadId: string,
      model: string | null,
      options?: {
        readonly codexServiceTier?: CodexServiceTier | null;
        readonly eventId?: string;
      },
    ): Promise<void> {
      await accept(
        threadModelSelectionClient().update({
          headers: authenticate(context, actor),
          params: { id: threadId },
          body: {
            model,
            codexServiceTier: options?.codexServiceTier,
            eventId: options?.eventId,
          },
        }),
        [204],
      );
    },

    async requestUpdateThreadModelSelection(
      actor: ApiTestUser | null,
      threadId: string,
      model: string | null,
      statuses: readonly (204 | 400 | 401 | 402 | 404)[],
      options?: {
        readonly codexServiceTier?: CodexServiceTier | null;
        readonly eventId?: string;
      },
    ) {
      return await accept(
        threadModelSelectionClient().update({
          headers: authenticate(context, actor),
          params: { id: threadId },
          body: {
            model,
            codexServiceTier: options?.codexServiceTier,
            eventId: options?.eventId,
          },
        }),
        statuses,
      );
    },

    async updateThreadComputerUseHost(
      actor: ApiTestUser,
      threadId: string,
      computerUseHostId: string | null,
    ): Promise<void> {
      await accept(
        threadComputerUseHostClient().update({
          headers: authenticate(context, actor),
          params: { id: threadId },
          body: { computerUseHostId },
        }),
        [204],
      );
    },

    async requestUpdateThreadComputerUseHost(
      actor: ApiTestUser | null,
      threadId: string,
      computerUseHostId: string | null,
      statuses: readonly (204 | 400 | 401 | 403 | 404)[],
    ) {
      return await accept(
        threadComputerUseHostClient().update({
          headers: authenticate(context, actor),
          params: { id: threadId },
          body: { computerUseHostId },
        }),
        statuses,
      );
    },

    async deleteThread(actor: ApiTestUser, threadId: string): Promise<void> {
      await accept(
        threadByIdClient().delete({
          headers: authenticate(context, actor),
          params: { id: threadId },
        }),
        [204],
      );
    },

    async requestDeleteThread(
      actor: ApiTestUser | null,
      threadId: string,
      statuses: readonly (204 | 400 | 401 | 404)[],
    ) {
      return await accept(
        threadByIdClient().delete({
          headers: authenticate(context, actor),
          params: { id: threadId },
        }),
        statuses,
      );
    },

    async listThreadMessages(
      actor: ApiTestUser,
      threadId: string,
      query: {
        readonly sinceSeqId?: number;
        readonly beforeSeqId?: number;
        readonly sinceId?: string;
        readonly beforeId?: string;
        readonly limit?: number;
      } = {},
    ): Promise<{
      readonly messages: readonly PagedChatMessage[];
      readonly hasHistoryBefore?: boolean;
    }> {
      const response = await accept(
        threadMessagesClient().list({
          headers: authenticate(context, actor),
          params: { threadId },
          query,
        }),
        [200],
      );
      return response.body;
    },

    async requestListThreadMessages(
      actor: ApiTestUser | null,
      threadId: string,
      query: {
        readonly sinceSeqId?: number;
        readonly beforeSeqId?: number;
        readonly sinceId?: string;
        readonly beforeId?: string;
        readonly limit?: number;
      },
      statuses: readonly (200 | 400 | 401 | 404)[],
    ) {
      return await accept(
        threadMessagesClient().list({
          headers: authenticate(context, actor),
          params: { threadId },
          query,
        }),
        statuses,
      );
    },

    async getThreadMessage(
      actor: ApiTestUser,
      threadId: string,
      messageId: string,
    ): Promise<PagedChatMessage> {
      const response = await accept(
        threadMessagesClient().get({
          headers: authenticate(context, actor),
          params: { threadId, messageId },
        }),
        [200],
      );
      return response.body;
    },

    async listThreadArtifacts(
      actor: ApiTestUser,
      threadId: string,
    ): Promise<{ readonly runs: readonly ChatThreadArtifactRun[] }> {
      const response = await accept(
        threadArtifactsClient().list({
          headers: authenticate(context, actor),
          params: { threadId },
        }),
        [200],
      );
      return response.body;
    },

    async requestListThreadArtifacts(
      actor: ApiTestUser | null,
      threadId: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      return await accept(
        threadArtifactsClient().list({
          headers: authenticate(context, actor),
          params: { threadId },
        }),
        statuses,
      );
    },

    async listArtifacts(
      actor: ApiTestUser,
      query: {
        readonly limit?: number;
        readonly cursor?: string;
        readonly updatedAfter?: string;
      } = {},
    ): Promise<ArtifactsListResponse> {
      const response = await accept(
        artifactsClient().list({
          headers: authenticate(context, actor),
          query,
        }),
        [200],
      );
      return response.body;
    },

    async listArtifactCatalog(
      actor: ApiTestUser,
      query: {
        readonly limit?: number;
        readonly cursor?: string;
        readonly kind?: ArtifactCatalogKind;
      } = {},
    ): Promise<{
      readonly artifacts: readonly ArtifactSummary[];
      readonly nextCursor: string | null;
    }> {
      const response = await accept(
        artifactCatalogClient().list({
          headers: authenticate(context, actor),
          query,
        }),
        [200],
      );
      return response.body;
    },

    async requestListArtifactCatalog(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 403)[],
    ) {
      return await accept(
        artifactCatalogClient().list({
          headers: authenticate(context, actor),
          query: {},
        }),
        statuses,
      );
    },

    async getArtifactCatalogEntry(
      actor: ApiTestUser,
      artifactId: string,
    ): Promise<ArtifactDetail> {
      const response = await accept(
        artifactCatalogClient().get({
          headers: authenticate(context, actor),
          params: { artifactId },
        }),
        [200],
      );
      return response.body;
    },

    async requestArtifactCatalogEntry(
      actor: ApiTestUser | null,
      artifactId: string,
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      return await accept(
        artifactCatalogClient().get({
          headers: authenticate(context, actor),
          params: { artifactId },
        }),
        statuses,
      );
    },

    async listArtifactFavorites(
      actor: ApiTestUser,
    ): Promise<ArtifactFavoritesResponse> {
      const response = await accept(
        artifactsClient().listFavorites({
          headers: authenticate(context, actor),
        }),
        [200],
      );
      return response.body;
    },

    async favoriteArtifact(
      actor: ApiTestUser,
      artifactUrl: string,
    ): Promise<void> {
      await accept(
        artifactsClient().favorite({
          headers: authenticate(context, actor),
          body: { artifactUrl },
        }),
        [204],
      );
    },

    async requestFavoriteArtifact(
      actor: ApiTestUser | null,
      artifactUrl: string,
      statuses: readonly (204 | 400 | 401 | 403 | 404)[],
    ) {
      return await accept(
        artifactsClient().favorite({
          headers: authenticate(context, actor),
          body: { artifactUrl },
        }),
        statuses,
      );
    },

    async unfavoriteArtifact(
      actor: ApiTestUser,
      artifactUrl: string,
    ): Promise<void> {
      await accept(
        artifactsClient().unfavorite({
          headers: authenticate(context, actor),
          body: { artifactUrl },
        }),
        [204],
      );
    },

    async requestUnfavoriteArtifact(
      actor: ApiTestUser | null,
      artifactUrl: string,
      statuses: readonly (204 | 400 | 401 | 403 | 404)[],
    ) {
      return await accept(
        artifactsClient().unfavorite({
          headers: authenticate(context, actor),
          body: { artifactUrl },
        }),
        statuses,
      );
    },

    async searchChat(
      actor: ApiTestUser,
      keyword: string,
      query: {
        readonly agentId?: string;
        readonly since?: number;
        readonly limit?: number;
        readonly before?: number;
        readonly after?: number;
      } = {},
    ): Promise<ChatSearchResponse> {
      const response = await accept(
        chatSearchClient().search({
          headers: authenticate(context, actor),
          query: { keyword, ...query },
        }),
        [200],
      );
      return response.body;
    },

    async requestSearchChat(
      actor: ApiTestUser | null,
      keyword: string,
      query: {
        readonly agentId?: string;
        readonly since?: number;
        readonly limit?: number;
        readonly before?: number;
        readonly after?: number;
      },
      statuses: readonly (200 | 400 | 401 | 403)[],
    ) {
      return await accept(
        chatSearchClient().search({
          headers: authenticate(context, actor),
          query: { keyword, ...query },
        }),
        statuses,
      );
    },

    async searchChatWithBearer(
      authorization: string,
      keyword: string,
      statuses: readonly (200 | 401 | 403)[],
    ) {
      return await accept(
        chatSearchClient().search({
          headers: bearerAuth(authorization),
          query: { keyword },
        }),
        statuses,
      );
    },

    async requestSyncThreadArtifact(
      actor: ApiTestUser | null,
      threadId: string,
      body: { readonly runId: string; readonly fileId: string },
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      return await accept(
        threadArtifactsClient().syncGoogleDrive({
          headers: authenticate(context, actor),
          params: { threadId },
          body,
        }),
        statuses,
      );
    },

    async requestSyncThreadArtifactUnchecked(
      actor: ApiTestUser,
      threadId: string,
      body: unknown,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      return await accept(
        threadArtifactsClient().syncGoogleDrive({
          headers: authenticate(context, actor),
          params: { threadId },
          body: body as { runId: string; fileId: string },
        }),
        statuses,
      );
    },

    async requestSendMessage(
      actor: ApiTestUser | null,
      body: BddSendMessageBody,
      statuses: readonly (201 | 400 | 401 | 402 | 403 | 404 | 409 | 422)[],
      signal?: AbortSignal,
    ) {
      const client = signal
        ? setupAppWithRoutes({ context, routes: chatFilesRoutes, signal })(
            chatMessagesContract,
          )
        : chatMessagesClient();
      const defaultModel =
        "prompt" in body &&
        body.threadId === undefined &&
        body.model === undefined
          ? await defaultCreateThreadModel(actor)
          : undefined;
      const requestBody =
        "prompt" in body
          ? (() => {
              const selectedModel = body.model ?? defaultModel;
              return {
                agentId: body.agentId,
                prompt: body.prompt,
                ...(body.threadId === undefined
                  ? {}
                  : { threadId: body.threadId }),
                ...(body.clientThreadId === undefined
                  ? {}
                  : { clientThreadId: body.clientThreadId }),
                ...(selectedModel === undefined
                  ? {}
                  : { model: selectedModel }),
                ...(body.runOptions === undefined
                  ? {}
                  : { runOptions: body.runOptions }),
                ...(body.structuredPrompt === undefined
                  ? {}
                  : { structuredPrompt: body.structuredPrompt }),
                ...(body.generationTemplate === undefined
                  ? {}
                  : { generationTemplate: body.generationTemplate }),
                ...(body.hasTextContent === undefined
                  ? {}
                  : { hasTextContent: body.hasTextContent }),
                ...(body.attachFiles === undefined
                  ? {}
                  : { attachFiles: [...body.attachFiles] }),
                // Explicit null clears the thread's sticky computer-use host;
                // omitting the field keeps it, so the two must stay distinct.
                ...(body.computerUseHostId === undefined
                  ? {}
                  : { computerUseHostId: body.computerUseHostId }),
                ...(body.clientMessageId === undefined
                  ? {}
                  : { clientMessageId: body.clientMessageId }),
                ...(body.chatThreadSortEventId === undefined
                  ? {}
                  : { chatThreadSortEventId: body.chatThreadSortEventId }),
                ...(body.realAgentInPreview === undefined
                  ? {}
                  : { realAgentInPreview: body.realAgentInPreview }),
                ...(body.revokesMessageId === undefined
                  ? {}
                  : { revokesMessageId: body.revokesMessageId }),
              };
            })()
          : "interruptsRunId" in body
            ? {
                agentId: body.agentId,
                threadId: body.threadId,
                interruptsRunId: body.interruptsRunId,
                ...(body.clientMessageId === undefined
                  ? {}
                  : { clientMessageId: body.clientMessageId }),
              }
            : {
                agentId: body.agentId,
                threadId: body.threadId,
                revokesMessageId: body.revokesMessageId,
                ...(body.clientMessageId === undefined
                  ? {}
                  : { clientMessageId: body.clientMessageId }),
              };

      return await accept(
        client.send({
          headers: authenticate(context, actor),
          body: requestBody,
        }),
        statuses,
      );
    },

    async prepareUpload(
      actor: ApiTestUser,
      body: {
        readonly filename: string;
        readonly contentType: string;
        readonly size: number;
      },
    ): Promise<UploadPrepareResponse> {
      const response = await accept(
        uploadsClient().prepare({
          headers: authenticate(context, actor),
          body,
        }),
        [200],
      );
      return response.body;
    },

    async requestPrepareUpload(
      actor: ApiTestUser | null,
      body: {
        readonly filename: string;
        readonly contentType: string;
        readonly size: number;
      },
      statuses: readonly (200 | 400 | 401 | 402 | 403 | 500)[],
    ) {
      return await accept(
        uploadsClient().prepare({
          headers: authenticate(context, actor),
          body,
        }),
        statuses,
      );
    },

    async completeUpload(
      actor: ApiTestUser,
      body: { readonly id: string; readonly contentType?: string },
    ): Promise<UploadCompleteResponse> {
      const response = await accept(
        uploadsClient().complete({
          headers: authenticate(context, actor),
          body,
        }),
        [200],
      );
      return response.body;
    },

    async requestCompleteUpload(
      actor: ApiTestUser | null,
      body: { readonly id: string; readonly contentType?: string },
      statuses: readonly (200 | 400 | 401 | 402 | 403 | 404 | 500)[],
    ) {
      return await accept(
        uploadsClient().complete({
          headers: authenticate(context, actor),
          body,
        }),
        statuses,
      );
    },

    /** Upload complete with a run-scoped bearer so the file records its run. */
    async completeUploadWithBearer(
      authorization: string,
      body: { readonly id: string; readonly contentType?: string },
      statuses: readonly (200 | 400 | 401 | 402 | 403 | 404 | 500)[],
    ) {
      return await accept(
        uploadsClient().complete({
          headers: bearerAuth(authorization),
          body,
        }),
        statuses,
      );
    },

    async prepareHostedSite(
      actor: ApiTestUser,
      body: HostedSitePrepareRequest,
    ): Promise<HostedSitePrepareResponse> {
      const response = await accept(
        hostClient().prepare({
          headers: authenticate(context, actor),
          body,
        }),
        [200],
      );
      return response.body;
    },

    async requestPrepareHostedSite(
      actor: ApiTestUser | null,
      body: HostedSitePrepareRequest,
      statuses: readonly (200 | 400 | 401 | 402 | 403 | 409 | 500)[],
    ) {
      return await accept(
        hostClient().prepare({
          headers: authenticate(context, actor),
          body,
        }),
        statuses,
      );
    },

    async completeHostedSite(
      actor: ApiTestUser,
      deploymentId: string,
    ): Promise<HostedSiteCompleteResponse> {
      const response = await accept(
        hostClient().complete({
          headers: authenticate(context, actor),
          params: { deploymentId },
          body: {},
        }),
        [200],
      );
      return response.body;
    },

    async requestCompleteHostedSite(
      actor: ApiTestUser | null,
      deploymentId: string,
      statuses: readonly (200 | 400 | 401 | 402 | 403 | 404 | 409 | 500)[],
    ) {
      return await accept(
        hostClient().complete({
          headers: authenticate(context, actor),
          params: { deploymentId },
          body: {},
        }),
        statuses,
      );
    },

    /** Hosted-site prepare with a run-scoped bearer (deployment records the run). */
    async prepareHostedSiteWithBearer(
      authorization: string,
      body: HostedSitePrepareRequest,
    ): Promise<HostedSitePrepareResponse> {
      const response = await accept(
        hostClient().prepare({
          headers: bearerAuth(authorization),
          body,
        }),
        [200],
      );
      return response.body;
    },

    async completeHostedSiteWithBearer(
      authorization: string,
      deploymentId: string,
    ): Promise<HostedSiteCompleteResponse> {
      const response = await accept(
        hostClient().complete({
          headers: bearerAuth(authorization),
          params: { deploymentId },
          body: {},
        }),
        [200],
      );
      return response.body;
    },

    expectApiError(body: unknown): asserts body is ApiErrorResponse {
      if (
        typeof body !== "object" ||
        body === null ||
        !("error" in body) ||
        typeof body.error !== "object" ||
        body.error === null
      ) {
        throw new Error("Expected API error response body");
      }
    },
  };
}
