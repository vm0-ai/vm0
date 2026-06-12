import {
  storagesCommitContract,
  storagesDownloadContract,
  storagesListContract,
  storagesPrepareContract,
} from "@vm0/api-contracts/contracts/storages";
import type { z } from "zod";

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

interface BddStorageFileEntry {
  readonly path: string;
  readonly hash: string;
  readonly size: number;
}

interface BddStoragePrepareBody {
  readonly storageName: string;
  readonly storageType: StorageType;
  readonly files: readonly BddStorageFileEntry[];
  readonly force?: boolean;
}

interface BddStorageCommitBody {
  readonly storageName: string;
  readonly storageType: StorageType;
  readonly versionId: string;
  readonly files: readonly BddStorageFileEntry[];
  readonly message?: string;
}

interface BddStorageDownloadQuery {
  readonly name: string;
  readonly type: StorageType;
  readonly version?: string;
}

type PrepareStatus = 200 | 400 | 401 | 403 | 404 | 413;
type CommitStatus = 200 | 400 | 401 | 403 | 404 | 409;
type ListStatus = 200 | 400 | 401 | 403 | 404;
type DownloadStatus = 200 | 400 | 401 | 403 | 404;

type PrepareContractBody = z.infer<typeof storagesPrepareContract.prepare.body>;
type CommitContractBody = z.infer<typeof storagesCommitContract.commit.body>;
type ListContractQuery = z.infer<typeof storagesListContract.list.query>;
type DownloadContractQuery = z.infer<
  typeof storagesDownloadContract.download.query
>;

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
  return { authorization: "Bearer clerk-session" };
}

function bearerHeaders(token: string): AuthHeaders {
  return { authorization: `Bearer ${token}` };
}

function downloadQuery(query: BddStorageDownloadQuery): DownloadContractQuery {
  return {
    name: query.name,
    type: query.type,
    ...(query.version === undefined ? {} : { version: query.version }),
  };
}

function storageObjectNotFoundError(): Error {
  const error = new Error("Not found") as Error & {
    $metadata: { httpStatusCode: number };
  };
  error.name = "NotFound";
  error.$metadata = { httpStatusCode: 404 };
  return error;
}

function commandInput(command: unknown): Record<string, unknown> {
  if (
    typeof command === "object" &&
    command !== null &&
    "input" in command &&
    typeof command.input === "object" &&
    command.input !== null
  ) {
    return command.input as Record<string, unknown>;
  }
  return {};
}

export function createStoragesBddApi(context: TestContext) {
  function prepareClient() {
    return setupApp({ context })(storagesPrepareContract);
  }

  function commitClient() {
    return setupApp({ context })(storagesCommitContract);
  }

  function listClient() {
    return setupApp({ context })(storagesListContract);
  }

  function downloadClient() {
    return setupApp({ context })(storagesDownloadContract);
  }

  return {
    mockStoragePresignedUrls(
      url = "https://r2.example.com/storages/presigned?sig=bdd",
    ): void {
      context.mocks.s3.getSignedUrl.mockResolvedValue(url);
    },

    mockStorageObjectsExist(): void {
      context.mocks.s3.send.mockResolvedValue({});
    },

    mockStorageObjectExistsOnce(): void {
      context.mocks.s3.send.mockResolvedValueOnce({});
    },

    mockStorageObjectMissingOnce(): void {
      context.mocks.s3.send.mockRejectedValueOnce(storageObjectNotFoundError());
    },

    /**
     * S3 key of the most recent presigned-URL request — the one boundary
     * assert kept for the provider download contract.
     */
    lastPresignedUrlKey(): unknown {
      const command = context.mocks.s3.getSignedUrl.mock.calls.at(-1)?.[1];
      return commandInput(command).Key;
    },

    async prepareStorage(actor: ApiTestUser, body: BddStoragePrepareBody) {
      const response = await accept(
        prepareClient().prepare({
          headers: authenticate(context, actor),
          body: { ...body, files: [...body.files] },
        }),
        [200],
      );
      return response.body;
    },

    async requestPrepareStorage(
      actor: ApiTestUser | null,
      body: unknown,
      statuses: readonly PrepareStatus[],
    ) {
      return await accept(
        prepareClient().prepare({
          headers: authenticate(context, actor),
          body: body as PrepareContractBody,
        }),
        statuses,
      );
    },

    async commitStorage(actor: ApiTestUser, body: BddStorageCommitBody) {
      const response = await accept(
        commitClient().commit({
          headers: authenticate(context, actor),
          body: { ...body, files: [...body.files] },
        }),
        [200],
      );
      return response.body;
    },

    async requestCommitStorage(
      actor: ApiTestUser | null,
      body: unknown,
      statuses: readonly CommitStatus[],
    ) {
      return await accept(
        commitClient().commit({
          headers: authenticate(context, actor),
          body: body as CommitContractBody,
        }),
        statuses,
      );
    },

    async listStorages(actor: ApiTestUser, type: StorageType) {
      const response = await accept(
        listClient().list({
          headers: authenticate(context, actor),
          query: { type },
        }),
        [200],
      );
      return response.body;
    },

    async requestListStorages(
      actor: ApiTestUser | null,
      query: unknown,
      statuses: readonly ListStatus[],
    ) {
      return await accept(
        listClient().list({
          headers: authenticate(context, actor),
          query: query as ListContractQuery,
        }),
        statuses,
      );
    },

    async requestListStoragesWithBearer(
      token: string,
      type: StorageType,
      statuses: readonly ListStatus[],
    ) {
      return await accept(
        listClient().list({
          headers: bearerHeaders(token),
          query: { type },
        }),
        statuses,
      );
    },

    async downloadStorage(actor: ApiTestUser, query: BddStorageDownloadQuery) {
      const response = await accept(
        downloadClient().download({
          headers: authenticate(context, actor),
          query: downloadQuery(query),
        }),
        [200],
      );
      return response.body;
    },

    async requestDownloadStorage(
      actor: ApiTestUser | null,
      query: unknown,
      statuses: readonly DownloadStatus[],
    ) {
      return await accept(
        downloadClient().download({
          headers: authenticate(context, actor),
          query: query as DownloadContractQuery,
        }),
        statuses,
      );
    },

    async requestDownloadStorageWithBearer(
      token: string,
      query: BddStorageDownloadQuery,
      statuses: readonly DownloadStatus[],
    ) {
      return await accept(
        downloadClient().download({
          headers: bearerHeaders(token),
          query: downloadQuery(query),
        }),
        statuses,
      );
    },
  };
}
