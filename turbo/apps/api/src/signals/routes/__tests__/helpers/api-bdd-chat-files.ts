import { createHash, randomUUID } from "node:crypto";

import {
  chatMessagesContract,
  chatSearchContract,
  chatThreadArtifactsContract,
  chatThreadByIdContract,
  chatThreadGithubPrsContract,
  chatThreadMarkReadContract,
  chatThreadModelSelectionContract,
  chatThreadPinContract,
  chatThreadRenameContract,
  chatThreadUnpinContract,
  chatThreadsContract,
  chatThreadMessagesContract,
  type AttachFile,
  type ChatSearchResponse,
  type ChatThreadArtifactRun,
  type ChatThreadDetail,
  type ChatThreadListItem,
  type GenerationTemplateRequest,
  type ModelSelectionRequest,
  type PagedChatMessage,
  type PersistedAttachment,
} from "@vm0/api-contracts/contracts/chat-threads";
import {
  chatThreadV1GetContract,
  chatThreadV1MessagesContract,
  chatThreadV1SendContract,
} from "@vm0/api-contracts/contracts/chat-threads-v1";
import { composesMainContract } from "@vm0/api-contracts/contracts/composes";
import type { ApiErrorResponse } from "@vm0/api-contracts/contracts/errors";
import {
  storagesCommitContract,
  storagesDownloadContract,
  storagesListContract,
  storagesPrepareContract,
} from "@vm0/api-contracts/contracts/storages";
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
import {
  zeroMemoryActivityContract,
  type MemoryActivityResponse,
} from "@vm0/api-contracts/contracts/zero-memory-activity";
import {
  zeroMemoryContract,
  type MemoryDetailResponse,
} from "@vm0/api-contracts/contracts/zero-memory";

import {
  accept,
  setupApp,
  type TestContext,
} from "../../../../__tests__/test-helpers";
import type { ApiTestUser } from "./api-bdd";
import { createZeroRouteMocks } from "./zero-route-test";

type StorageType = "volume" | "artifact";

interface AuthHeaders {
  readonly authorization?: string;
}

interface BddCompose {
  readonly composeId: string;
  readonly name: string;
  readonly versionId: string;
  readonly action: "created" | "existing";
  readonly updatedAt: string;
}

interface BddStorageFileEntry {
  readonly path: string;
  readonly hash: string;
  readonly size: number;
}

interface BddStoragePrepareResponse {
  readonly versionId: string;
  readonly existing: boolean;
  readonly uploads?: {
    readonly archive: {
      readonly key: string;
      readonly presignedUrl: string;
    };
    readonly manifest: {
      readonly key: string;
      readonly presignedUrl: string;
    };
  };
}

interface BddStorageCommitResponse {
  readonly success: true;
  readonly versionId: string;
  readonly storageName: string;
  readonly size: number;
  readonly fileCount: number;
  readonly deduplicated?: boolean;
}

interface BddStorageListItem {
  readonly name: string;
  readonly size: number;
  readonly fileCount: number;
  readonly updatedAt: string;
}

type BddStorageDownloadResponse =
  | {
      readonly url: string;
      readonly versionId: string;
      readonly fileCount: number;
      readonly size: number;
    }
  | {
      readonly empty: true;
      readonly versionId: string;
      readonly fileCount: 0;
      readonly size: 0;
    };

type BddSendMessageBody =
  | {
      readonly agentId: string;
      readonly prompt: string;
      readonly threadId?: string;
      readonly clientThreadId?: string;
      readonly modelProvider?: string;
      readonly modelSelection?: ModelSelectionRequest | null;
      readonly generationTemplate?: GenerationTemplateRequest;
      readonly hasTextContent?: boolean;
      readonly attachFiles?: readonly AttachFile[];
      readonly computerUseHostId?: string | null;
      readonly clientMessageId?: string;
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
  return actor ? { authorization: "Bearer clerk-session" } : {};
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
    if (name === "HeadObjectCommand" || name === "PutObjectCommand") {
      return Promise.resolve({});
    }
    return Promise.resolve({});
  });
}

export function hostedTextFile(
  path: string,
  content: string,
  contentType = "text/html; charset=utf-8",
): HostedSitePrepareRequest["files"][number] {
  const bytes = Buffer.from(content, "utf8");
  return {
    path,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentType,
  };
}

export function storageTextFile(
  path: string,
  content: string,
): BddStorageFileEntry {
  const bytes = Buffer.from(content, "utf8");
  return {
    path,
    hash: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
  };
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
    return setupApp({ context })(composesMainContract);
  }

  function threadsClient() {
    return setupApp({ context })(chatThreadsContract);
  }

  function threadByIdClient() {
    return setupApp({ context })(chatThreadByIdContract);
  }

  function threadMessagesClient() {
    return setupApp({ context })(chatThreadMessagesContract);
  }

  function threadArtifactsClient() {
    return setupApp({ context })(chatThreadArtifactsContract);
  }

  function threadMarkReadClient() {
    return setupApp({ context })(chatThreadMarkReadContract);
  }

  function threadPinClient() {
    return setupApp({ context })(chatThreadPinContract);
  }

  function threadUnpinClient() {
    return setupApp({ context })(chatThreadUnpinContract);
  }

  function threadRenameClient() {
    return setupApp({ context })(chatThreadRenameContract);
  }

  function threadModelSelectionClient() {
    return setupApp({ context })(chatThreadModelSelectionContract);
  }

  function chatMessagesClient() {
    return setupApp({ context })(chatMessagesContract);
  }

  function chatSearchClient() {
    return setupApp({ context })(chatSearchContract);
  }

  function threadGithubPrsClient() {
    return setupApp({ context })(chatThreadGithubPrsContract);
  }

  function threadV1Client() {
    return setupApp({ context })(chatThreadV1GetContract);
  }

  function threadV1MessagesClient() {
    return setupApp({ context })(chatThreadV1MessagesContract);
  }

  function threadV1SendClient() {
    return setupApp({ context })(chatThreadV1SendContract);
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
    return setupApp({ context })(zeroUploadsContract);
  }

  function hostClient() {
    return setupApp({ context })(zeroHostContract);
  }

  function memoryClient() {
    return setupApp({ context })(zeroMemoryContract);
  }

  function memoryActivityClient() {
    return setupApp({ context })(zeroMemoryActivityContract);
  }

  function storagePrepareClient() {
    return setupApp({ context })(storagesPrepareContract);
  }

  function storageCommitClient() {
    return setupApp({ context })(storagesCommitContract);
  }

  function storageListClient() {
    return setupApp({ context })(storagesListContract);
  }

  function storageDownloadClient() {
    return setupApp({ context })(storagesDownloadContract);
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
      },
    ): Promise<{ readonly id: string; readonly title: string | null }> {
      const response = await accept(
        threadsClient().create({
          headers: authenticate(context, actor),
          body,
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
      },
      statuses: readonly (201 | 401 | 404)[],
    ) {
      return await accept(
        threadsClient().create({
          headers: authenticate(context, actor),
          body,
        }),
        statuses,
      );
    },

    async listThreads(
      actor: ApiTestUser,
      query: {
        readonly agentId?: string;
        readonly limit?: number;
        readonly cursor?: string;
      } = {},
    ): Promise<{
      readonly pinned: readonly ChatThreadListItem[];
      readonly threads: readonly ChatThreadListItem[];
      readonly hasMore: boolean;
      readonly nextCursor: string | null;
      readonly totalCount: number;
    }> {
      const response = await accept(
        threadsClient().list({
          headers: authenticate(context, actor),
          query,
        }),
        [200],
      );
      return response.body;
    },

    async requestListThreads(
      actor: ApiTestUser | null,
      query: {
        readonly agentId?: string;
        readonly limit?: number;
        readonly cursor?: string;
      },
      statuses: readonly (200 | 401 | 404)[],
    ) {
      return await accept(
        threadsClient().list({
          headers: authenticate(context, actor),
          query,
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

    async patchThread(
      actor: ApiTestUser,
      threadId: string,
      body: {
        readonly draftContent?: string | null;
        readonly draftAttachments?: readonly PersistedAttachment[] | null;
      },
    ): Promise<void> {
      const requestBody = {
        ...(body.draftContent === undefined
          ? {}
          : { draftContent: body.draftContent }),
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
    ): Promise<void> {
      await accept(
        threadRenameClient().rename({
          headers: authenticate(context, actor),
          params: { id: threadId },
          body: { title },
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
      readonly lastReadMessageId: string | null;
      readonly changed: boolean;
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
      modelSelection: ModelSelectionRequest | null,
    ): Promise<void> {
      await accept(
        threadModelSelectionClient().update({
          headers: authenticate(context, actor),
          params: { id: threadId },
          body: { modelSelection },
        }),
        [204],
      );
    },

    async requestUpdateThreadModelSelection(
      actor: ApiTestUser | null,
      threadId: string,
      modelSelection: ModelSelectionRequest | null,
      statuses: readonly (204 | 400 | 401 | 404)[],
    ) {
      return await accept(
        threadModelSelectionClient().update({
          headers: authenticate(context, actor),
          params: { id: threadId },
          body: { modelSelection },
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

    async requestThreadGithubPrs(
      actor: ApiTestUser | null,
      threadId: string,
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      return await accept(
        threadGithubPrsClient().list({
          headers: authenticate(context, actor),
          params: { threadId },
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
    ) {
      const requestBody =
        "prompt" in body
          ? {
              agentId: body.agentId,
              prompt: body.prompt,
              ...(body.threadId === undefined
                ? {}
                : { threadId: body.threadId }),
              ...(body.clientThreadId === undefined
                ? {}
                : { clientThreadId: body.clientThreadId }),
              ...(body.modelProvider === undefined
                ? {}
                : { modelProvider: body.modelProvider }),
              ...(body.modelSelection === undefined
                ? {}
                : { modelSelection: body.modelSelection }),
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
              ...(body.revokesMessageId === undefined
                ? {}
                : { revokesMessageId: body.revokesMessageId }),
            }
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
        chatMessagesClient().send({
          headers: authenticate(context, actor),
          body: requestBody,
        }),
        statuses,
      );
    },

    async readMemory(actor: ApiTestUser): Promise<MemoryDetailResponse> {
      const response = await accept(
        memoryClient().get({ headers: authenticate(context, actor) }),
        [200],
      );
      return response.body;
    },

    async requestReadMemory(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401)[],
    ) {
      return await accept(
        memoryClient().get({ headers: authenticate(context, actor) }),
        statuses,
      );
    },

    async readMemoryWithBearer(
      token: string,
      statuses: readonly (200 | 401)[],
    ) {
      return await accept(
        memoryClient().get({
          headers: { authorization: `Bearer ${token}` },
        }),
        statuses,
      );
    },

    async readMemoryActivity(
      actor: ApiTestUser,
    ): Promise<MemoryActivityResponse> {
      const response = await accept(
        memoryActivityClient().get({
          headers: authenticate(context, actor),
          query: {},
        }),
        [200],
      );
      return response.body;
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

    async prepareStorage(
      actor: ApiTestUser,
      body: {
        readonly storageName: string;
        readonly storageType: StorageType;
        readonly files: readonly BddStorageFileEntry[];
        readonly force?: boolean;
      },
    ): Promise<BddStoragePrepareResponse> {
      const response = await accept(
        storagePrepareClient().prepare({
          headers: authenticate(context, actor),
          body: { ...body, files: [...body.files] },
        }),
        [200],
      );
      return response.body;
    },

    async commitStorage(
      actor: ApiTestUser,
      body: {
        readonly storageName: string;
        readonly storageType: StorageType;
        readonly versionId: string;
        readonly files: readonly BddStorageFileEntry[];
        readonly message?: string;
      },
    ): Promise<BddStorageCommitResponse> {
      const response = await accept(
        storageCommitClient().commit({
          headers: authenticate(context, actor),
          body: { ...body, files: [...body.files] },
        }),
        [200],
      );
      return response.body;
    },

    async listStorages(
      actor: ApiTestUser,
      type: StorageType,
    ): Promise<readonly BddStorageListItem[]> {
      const response = await accept(
        storageListClient().list({
          headers: authenticate(context, actor),
          query: { type },
        }),
        [200],
      );
      return response.body;
    },

    async downloadStorage(
      actor: ApiTestUser,
      name: string,
      type: StorageType,
    ): Promise<BddStorageDownloadResponse> {
      const response = await accept(
        storageDownloadClient().download({
          headers: authenticate(context, actor),
          query: { name, type },
        }),
        [200],
      );
      return response.body;
    },

    async requestDownloadStorage(
      actor: ApiTestUser | null,
      name: string,
      type: StorageType,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 500)[],
    ) {
      return await accept(
        storageDownloadClient().download({
          headers: authenticate(context, actor),
          query: { name, type },
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

    async requestV1Thread(
      authorization: string | undefined,
      threadId: string,
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      return await accept(
        threadV1Client().get({
          headers: bearerAuth(authorization),
          params: { threadId },
        }),
        statuses,
      );
    },

    async requestV1ThreadMessages(
      authorization: string | undefined,
      threadId: string,
      query: {
        readonly sinceId?: string;
        readonly beforeId?: string;
        readonly limit?: number;
      },
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      return await accept(
        threadV1MessagesClient().list({
          headers: bearerAuth(authorization),
          params: { threadId },
          query,
        }),
        statuses,
      );
    },

    async requestV1Send(
      authorization: string | undefined,
      body: { readonly prompt: string; readonly threadId: string },
      statuses: readonly (201 | 400 | 401 | 403 | 404 | 409)[],
    ) {
      return await accept(
        threadV1SendClient().send({
          headers: bearerAuth(authorization),
          body,
        }),
        statuses,
      );
    },

    async requestV1SendUnchecked(
      authorization: string,
      body: unknown,
      statuses: readonly (201 | 400 | 401 | 403 | 404)[],
    ) {
      return await accept(
        threadV1SendClient().send({
          headers: bearerAuth(authorization),
          body: body as { prompt: string; threadId: string },
        }),
        statuses,
      );
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
