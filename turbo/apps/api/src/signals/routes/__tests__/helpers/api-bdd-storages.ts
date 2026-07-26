import type {
  TestStorageStateActionBody,
  TestStorageStateActionResponse,
} from "@vm0/api-contracts/contracts/test-storage-fixture";

import { createAppWithRoutes } from "../../../../app-factory-core";
import type { TestContext } from "../../../../__tests__/test-context";
import { testStorageStateRoutes } from "../../test-storage-fixture";
import type { ApiTestUser } from "./api-bdd";
import type { BddStorageFileEntry } from "./api-bdd-storage-files";

type StorageFixtureKind = "volume" | "artifact";

interface BddStoragePrepareBody {
  readonly storageName: string;
  readonly storageType: StorageFixtureKind;
  readonly files: readonly BddStorageFileEntry[];
  readonly force?: boolean;
  readonly baseVersion?: string;
  readonly changes?: {
    readonly added: readonly string[];
    readonly modified: readonly string[];
    readonly deleted: readonly string[];
  };
}

interface BddStorageCommitBody {
  readonly storageName: string;
  readonly storageType: StorageFixtureKind;
  readonly versionId: string;
  readonly files: readonly BddStorageFileEntry[];
  readonly message?: string;
}

interface BddStorageDownloadQuery {
  readonly name: string;
  readonly type: StorageFixtureKind;
  readonly version?: string;
}

function requireOrgId(actor: ApiTestUser): string {
  if (!actor.orgId) {
    throw new Error("Storage fixture requires an org-scoped actor");
  }
  return actor.orgId;
}

function storageOwner(kind: StorageFixtureKind): "organization" | "user" {
  return kind === "volume" ? "organization" : "user";
}

function requestStorageState(
  context: TestContext,
  body: TestStorageStateActionBody,
): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: testStorageStateRoutes,
  });
  return Promise.resolve(
    app.request("/api/test/storage-fixture/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function postAction(
  context: TestContext,
  body: TestStorageStateActionBody,
): Promise<TestStorageStateActionResponse> {
  const response = await requestStorageState(context, body);
  if (!response.ok) {
    throw new Error(
      `Storage state action ${body.action} failed with ${response.status}`,
    );
  }
  return (await response.json()) as TestStorageStateActionResponse;
}

function fixtureFiles(files: readonly BddStorageFileEntry[]) {
  return files.map((file) => {
    return { ...file };
  });
}

export function createStoragesBddApi(context: TestContext) {
  return {
    mockStoragePresignedUrls(
      url = "https://r2.example.com/storages/presigned?sig=bdd",
    ): void {
      context.mocks.s3.getSignedUrl.mockResolvedValue(url);
    },

    mockStorageObjectsExist(contentLength = 1024): void {
      context.mocks.s3.send.mockResolvedValue({
        ContentLength: contentLength,
      });
    },

    mockStorageObjectExistsOnce(contentLength = 1024): void {
      context.mocks.s3.send.mockResolvedValueOnce({
        ContentLength: contentLength,
      });
    },

    async prepareStorage(actor: ApiTestUser, body: BddStoragePrepareBody) {
      const response = await postAction(context, {
        action: "prepare",
        orgId: requireOrgId(actor),
        userId: actor.userId,
        storageName: body.storageName,
        storageOwner: storageOwner(body.storageType),
        files: fixtureFiles(body.files),
        force: body.force,
        baseVersion: body.baseVersion,
        changes: body.changes
          ? {
              added: [...body.changes.added],
              modified: [...body.changes.modified],
              deleted: [...body.changes.deleted],
            }
          : undefined,
      });
      if (!response.prepared) {
        throw new Error("Storage prepare action returned no result");
      }
      return response.prepared;
    },

    async commitStorage(actor: ApiTestUser, body: BddStorageCommitBody) {
      const response = await postAction(context, {
        action: "commit",
        orgId: requireOrgId(actor),
        userId: actor.userId,
        storageName: body.storageName,
        storageOwner: storageOwner(body.storageType),
        versionId: body.versionId,
        files: fixtureFiles(body.files),
        message: body.message,
      });
      if (!response.committed) {
        throw new Error("Storage commit action returned no result");
      }
      return response.committed;
    },

    async listStorages(actor: ApiTestUser, kind: StorageFixtureKind) {
      const response = await postAction(context, {
        action: "list",
        orgId: requireOrgId(actor),
        userId: actor.userId,
        storageOwner: storageOwner(kind),
      });
      if (!response.storages) {
        throw new Error("Storage list action returned no result");
      }
      return response.storages;
    },

    async downloadStorage(actor: ApiTestUser, query: BddStorageDownloadQuery) {
      const response = await postAction(context, {
        action: "download",
        orgId: requireOrgId(actor),
        userId: actor.userId,
        storageName: query.name,
        storageOwner: storageOwner(query.type),
        versionId: query.version,
      });
      if (!response.download) {
        throw new Error("Storage download action returned no result");
      }
      return response.download;
    },
  };
}
