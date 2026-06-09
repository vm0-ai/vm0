import { createHash, randomUUID } from "node:crypto";

import {
  chatMessagesContract,
  chatSearchContract,
  chatThreadArtifactsContract,
  chatThreadByIdContract,
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
import { composesMainContract } from "@vm0/api-contracts/contracts/composes";
import type { ApiErrorResponse } from "@vm0/api-contracts/contracts/errors";
import {
  storagesCommitContract,
  storagesDownloadContract,
  storagesListContract,
  storagesPrepareContract,
} from "@vm0/api-contracts/contracts/storages";
import {
  zeroComputerUseAuditEventsContract,
  zeroComputerUseCommandContract,
  zeroComputerUseHeartbeatContract,
  zeroComputerUseHostCommandsContract,
  zeroComputerUseHostsContract,
  zeroComputerUseWriteCommandContract,
  type ComputerUseAuditEventListResponse,
  type ComputerUseCommandCreateResponse,
  type ComputerUseCommandResponse,
  type ComputerUseHostListResponse,
} from "@vm0/api-contracts/contracts/zero-computer-use";
import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
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
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

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

interface RequiredAuthHeaders {
  readonly authorization: string;
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

const DEFAULT_SUPPORTED_COMPUTER_USE_CAPABILITIES = [
  "apps.list",
  "app.state",
  "app.open",
  "element.click",
  "element.scroll",
  "element.set_value",
  "element.perform_action",
  "keyboard.type_text",
  "keyboard.press_key",
] as const;

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

function hostHeaders(hostToken: string): RequiredAuthHeaders {
  return { authorization: `Bearer ${hostToken}` };
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

  function featureSwitchesClient() {
    return setupApp({ context })(zeroFeatureSwitchesContract);
  }

  function computerUseHostsClient() {
    return setupApp({ context })(zeroComputerUseHostsContract);
  }

  function computerUseHeartbeatClient() {
    return setupApp({ context })(zeroComputerUseHeartbeatContract);
  }

  function computerUseCommandClient() {
    return setupApp({ context })(zeroComputerUseCommandContract);
  }

  function computerUseWriteCommandClient() {
    return setupApp({ context })(zeroComputerUseWriteCommandContract);
  }

  function computerUseHostCommandsClient() {
    return setupApp({ context })(zeroComputerUseHostCommandsContract);
  }

  function computerUseAuditEventsClient() {
    return setupApp({ context })(zeroComputerUseAuditEventsContract);
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

    async enableComputerUse(actor: ApiTestUser): Promise<void> {
      await accept(
        featureSwitchesClient().update({
          headers: authenticate(context, actor),
          body: { switches: { [FeatureSwitchKey.ComputerUse]: true } },
        }),
        [200],
      );
    },

    async startComputerUseHost(
      actor: ApiTestUser,
    ): Promise<{ readonly hostId: string; readonly hostToken: string }> {
      const response = await accept(
        computerUseHostsClient().start({
          headers: authenticate(context, actor),
          body: {
            hostName: "Zero Desktop",
            appVersion: "0.1.0",
            osVersion: "macOS 15",
            supportedCapabilities: [
              ...DEFAULT_SUPPORTED_COMPUTER_USE_CAPABILITIES,
            ],
            permissions: { accessibility: true, screenRecording: true },
          },
        }),
        [200],
      );
      return response.body;
    },

    async requestStartComputerUseHost(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 403 | 409)[],
    ) {
      return await accept(
        computerUseHostsClient().start({
          headers: authenticate(context, actor),
          body: {
            hostName: "Zero Desktop",
            appVersion: "0.1.0",
            osVersion: "macOS 15",
            supportedCapabilities: [
              ...DEFAULT_SUPPORTED_COMPUTER_USE_CAPABILITIES,
            ],
            permissions: { accessibility: true, screenRecording: true },
          },
        }),
        statuses,
      );
    },

    async requestListComputerUseHosts(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 403)[],
    ) {
      return await accept(
        computerUseHostsClient().list({
          headers: authenticate(context, actor),
        }),
        statuses,
      );
    },

    async listComputerUseHosts(
      actor: ApiTestUser,
    ): Promise<ComputerUseHostListResponse> {
      const response = await accept(
        computerUseHostsClient().list({
          headers: authenticate(context, actor),
        }),
        [200],
      );
      return response.body;
    },

    async requestDeleteComputerUseHost(
      actor: ApiTestUser | null,
      hostId: string,
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      return await accept(
        computerUseHostsClient().delete({
          headers: authenticate(context, actor),
          params: { hostId },
        }),
        statuses,
      );
    },

    async deleteComputerUseHost(
      actor: ApiTestUser,
      hostId: string,
    ): Promise<void> {
      await accept(
        computerUseHostsClient().delete({
          headers: authenticate(context, actor),
          params: { hostId },
        }),
        [200],
      );
    },

    async stopComputerUseHost(
      hostToken: string,
    ): Promise<{ readonly ok: true; readonly hostId: string }> {
      const response = await accept(
        computerUseHeartbeatClient().stop({
          headers: hostHeaders(hostToken),
          body: {},
        }),
        [200],
      );
      return response.body;
    },

    async createComputerUseWriteCommand(
      actor: ApiTestUser,
    ): Promise<ComputerUseCommandCreateResponse> {
      const response = await accept(
        computerUseWriteCommandClient().create({
          headers: authenticate(context, actor),
          body: {
            kind: "app.open",
            app: "Safari",
            timeoutMs: 15_000,
          },
        }),
        [200],
      );
      return response.body;
    },

    async requestCreateComputerUseWriteCommand(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 403 | 404 | 409)[],
    ) {
      return await accept(
        computerUseWriteCommandClient().create({
          headers: authenticate(context, actor),
          body: {
            kind: "app.open",
            app: "Safari",
            timeoutMs: 15_000,
          },
        }),
        statuses,
      );
    },

    async readComputerUseCommand(
      actor: ApiTestUser,
      commandId: string,
    ): Promise<ComputerUseCommandResponse> {
      const response = await accept(
        computerUseCommandClient().get({
          headers: authenticate(context, actor),
          params: { commandId },
        }),
        [200],
      );
      return response.body;
    },

    async requestReadComputerUseCommand(
      actor: ApiTestUser | null,
      commandId: string,
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      return await accept(
        computerUseCommandClient().get({
          headers: authenticate(context, actor),
          params: { commandId },
        }),
        statuses,
      );
    },

    async requestComputerUseScreenshot(
      actor: ApiTestUser | null,
      commandId: string,
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      return await accept(
        computerUseCommandClient().getScreenshot({
          headers: authenticate(context, actor),
          params: { commandId },
        }),
        statuses,
      );
    },

    async claimNextComputerUseCommand(hostToken: string): Promise<
      | { readonly status: "idle" }
      | {
          readonly status: "command";
          readonly command: ComputerUseCommandResponse;
        }
    > {
      const response = await accept(
        computerUseHostCommandsClient().next({
          headers: hostHeaders(hostToken),
          body: {
            supportedCapabilities: [
              ...DEFAULT_SUPPORTED_COMPUTER_USE_CAPABILITIES,
            ],
          },
        }),
        [200],
      );
      return response.body;
    },

    async completeComputerUseCommand(
      hostToken: string,
      commandId: string,
    ): Promise<void> {
      await accept(
        computerUseHostCommandsClient().complete({
          headers: hostHeaders(hostToken),
          params: { commandId },
          body: {
            status: "succeeded",
            result: { app: "Safari", opened: true },
          },
        }),
        [200],
      );
    },

    async requestListComputerUseAuditEvents(
      actor: ApiTestUser | null,
      query: {
        readonly commandId?: string;
        readonly hostId?: string;
        readonly runId?: string;
        readonly limit?: number;
      },
      statuses: readonly (200 | 401 | 403)[],
    ) {
      return await accept(
        computerUseAuditEventsClient().list({
          headers: authenticate(context, actor),
          query,
        }),
        statuses,
      );
    },

    async listComputerUseAuditEvents(
      actor: ApiTestUser,
      query: {
        readonly commandId?: string;
        readonly hostId?: string;
        readonly runId?: string;
        readonly limit?: number;
      } = {},
    ): Promise<ComputerUseAuditEventListResponse> {
      const response = await accept(
        computerUseAuditEventsClient().list({
          headers: authenticate(context, actor),
          query,
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
