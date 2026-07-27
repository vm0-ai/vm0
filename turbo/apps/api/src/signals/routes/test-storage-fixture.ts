import {
  testStorageFixtureContract,
  type TestStorageStateActionBody,
} from "@vm0/api-contracts/contracts/test-storage-fixture";
import { VOLUME_ORG_USER_ID } from "@vm0/core/storage-names";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { command } from "ccstate";
import { and, desc, eq } from "drizzle-orm";

import { notFound } from "../../lib/error";
import { nowDate } from "../../lib/time";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { storageDml } from "../services/storage-dml.service";
import { newStorageS3Location } from "../services/storage-s3-prefix.utils";
import {
  commitStorageUploadForStorage$,
  prepareStorageUploadForStorage$,
} from "../services/storage-write.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const prepareBody$ = bodyResultOf(testStorageFixtureContract.prepare);
const commitBody$ = bodyResultOf(testStorageFixtureContract.commit);
const actionBody$ = bodyResultOf(testStorageFixtureContract.action);

type StorageStateAction<TAction extends TestStorageStateActionBody["action"]> =
  Extract<TestStorageStateActionBody, { action: TAction }>;

function actionOk(extra: Record<string, unknown> = {}) {
  return { status: 200 as const, body: { ok: true as const, ...extra } };
}

function fixtureOwner(userId: string, owner: "organization" | "user"): string {
  return owner === "organization" ? VOLUME_ORG_USER_ID : userId;
}

async function findOrCreateFixtureStorageId(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly owner: "organization" | "user";
}) {
  const userId = fixtureOwner(args.userId, args.owner);
  const [existing] = await args.db
    .select({ id: storages.id })
    .from(storages)
    .where(
      and(
        eq(storages.orgId, args.orgId),
        eq(storages.userId, userId),
        eq(storages.name, args.name),
      ),
    )
    .limit(1);
  if (existing) {
    return existing.id;
  }

  const location = newStorageS3Location(args.orgId);
  const [storage] = await args.db
    .insert(storageDml)
    .values({
      id: location.storageId,
      orgId: args.orgId,
      userId,
      name: args.name,
      s3Prefix: location.s3Prefix,
      size: 0,
      fileCount: 0,
    })
    .onConflictDoUpdate({
      target: [storageDml.orgId, storageDml.userId, storageDml.name],
      set: { updatedAt: nowDate() },
    })
    .returning({ id: storageDml.id });
  if (!storage?.id) {
    throw new Error("Failed to create Storage fixture");
  }
  return storage.id;
}

async function findFixtureStorage(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly owner: "organization" | "user";
}) {
  const [storage] = await args.db
    .select({
      id: storages.id,
      headVersionId: storages.headVersionId,
    })
    .from(storages)
    .where(
      and(
        eq(storages.orgId, args.orgId),
        eq(storages.userId, fixtureOwner(args.userId, args.owner)),
        eq(storages.name, args.name),
      ),
    )
    .limit(1);
  return storage;
}

async function prepareStorageState(
  set: Parameters<Parameters<typeof command>[0]>[0]["set"],
  db: Db,
  body: StorageStateAction<"prepare">,
  signal: AbortSignal,
) {
  const storageId = await findOrCreateFixtureStorageId({
    db,
    orgId: body.orgId,
    userId: body.userId,
    name: body.storageName,
    owner: body.storageOwner,
  });
  signal.throwIfAborted();
  const response = await set(
    prepareStorageUploadForStorage$,
    {
      storageId,
      files: body.files,
      force: body.force,
      baseVersion: body.baseVersion,
      changes: body.changes,
    },
    signal,
  );
  signal.throwIfAborted();
  return response.status === 200
    ? actionOk({ prepared: response.body })
    : response;
}

async function commitStorageState(
  set: Parameters<Parameters<typeof command>[0]>[0]["set"],
  db: Db,
  body: StorageStateAction<"commit">,
  signal: AbortSignal,
) {
  const storage = await findFixtureStorage({
    db,
    orgId: body.orgId,
    userId: body.userId,
    name: body.storageName,
    owner: body.storageOwner,
  });
  signal.throwIfAborted();
  if (!storage) {
    return notFound("Storage fixture commit target not found");
  }
  const response = await set(
    commitStorageUploadForStorage$,
    {
      storageId: storage.id,
      versionId: body.versionId,
      files: body.files,
      message: body.message,
    },
    signal,
  );
  signal.throwIfAborted();
  return response.status === 200
    ? actionOk({ committed: response.body })
    : response;
}

async function listStorageState(
  db: Db,
  body: StorageStateAction<"list">,
  signal: AbortSignal,
) {
  const rows = await db
    .select({
      name: storages.name,
      size: storages.size,
      fileCount: storages.fileCount,
      updatedAt: storages.updatedAt,
    })
    .from(storages)
    .where(
      and(
        eq(storages.orgId, body.orgId),
        eq(storages.userId, fixtureOwner(body.userId, body.storageOwner)),
      ),
    )
    .orderBy(desc(storages.updatedAt));
  signal.throwIfAborted();
  return actionOk({
    storages: rows.map((row) => {
      return { ...row, updatedAt: row.updatedAt.toISOString() };
    }),
  });
}

async function downloadStorageState(
  db: Db,
  body: StorageStateAction<"download">,
  signal: AbortSignal,
) {
  const storage = await findFixtureStorage({
    db,
    orgId: body.orgId,
    userId: body.userId,
    name: body.storageName,
    owner: body.storageOwner,
  });
  signal.throwIfAborted();
  const versionId = body.versionId ?? storage?.headVersionId;
  if (!storage || !versionId) {
    return notFound("Storage fixture download target not found");
  }
  const [version] = await db
    .select({
      id: storageVersions.id,
      size: storageVersions.size,
      fileCount: storageVersions.fileCount,
    })
    .from(storageVersions)
    .where(
      and(
        eq(storageVersions.storageId, storage.id),
        eq(storageVersions.id, versionId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!version) {
    return notFound("Storage fixture version not found");
  }
  if (version.fileCount === 0) {
    return actionOk({
      download: {
        empty: true,
        versionId: version.id,
        fileCount: 0,
        size: 0,
      },
    });
  }
  return actionOk({
    download: {
      url: "https://r2.example.com/storages/download?sig=bdd",
      versionId: version.id,
      fileCount: version.fileCount,
      size: Number(version.size),
    },
  });
}

const prepare$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!isTestEndpointAllowed(get(request$))) {
    return testEndpointNotFoundResponse();
  }
  const bodyResult = await get(prepareBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const auth = get(authContext$);
  const orgId = auth.orgId;
  if (!orgId) {
    return testEndpointNotFoundResponse();
  }
  const db = set(writeDb$);
  const storageId = await findOrCreateFixtureStorageId({
    db,
    orgId,
    userId: auth.userId,
    name: bodyResult.data.storageName,
    owner: bodyResult.data.storageOwner,
  });
  signal.throwIfAborted();

  return await set(
    prepareStorageUploadForStorage$,
    {
      storageId,
      files: bodyResult.data.files,
      force: bodyResult.data.force,
    },
    signal,
  );
});

const commit$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!isTestEndpointAllowed(get(request$))) {
    return testEndpointNotFoundResponse();
  }
  const bodyResult = await get(commitBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const auth = get(authContext$);
  const orgId = auth.orgId;
  if (!orgId) {
    return testEndpointNotFoundResponse();
  }
  const db = set(writeDb$);
  const storageId = await findOrCreateFixtureStorageId({
    db,
    orgId,
    userId: auth.userId,
    name: bodyResult.data.storageName,
    owner: bodyResult.data.storageOwner,
  });
  signal.throwIfAborted();

  return await set(
    commitStorageUploadForStorage$,
    {
      storageId,
      versionId: bodyResult.data.versionId,
      files: bodyResult.data.files,
    },
    signal,
  );
});

const action$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!isTestEndpointAllowed(get(request$))) {
    return testEndpointNotFoundResponse();
  }
  const bodyResult = await get(actionBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const db = set(writeDb$);
  switch (bodyResult.data.action) {
    case "prepare": {
      return await prepareStorageState(set, db, bodyResult.data, signal);
    }
    case "commit": {
      return await commitStorageState(set, db, bodyResult.data, signal);
    }
    case "list": {
      return await listStorageState(db, bodyResult.data, signal);
    }
    case "download": {
      return await downloadStorageState(db, bodyResult.data, signal);
    }
  }
});

export const testStorageFixtureRoutes: readonly RouteEntry[] = [
  {
    route: testStorageFixtureContract.prepare,
    handler: authRoute({ requireOrganization: true }, prepare$),
  },
  {
    route: testStorageFixtureContract.commit,
    handler: authRoute({ requireOrganization: true }, commit$),
  },
];

export const testStorageStateRoutes: readonly RouteEntry[] = [
  {
    route: testStorageFixtureContract.action,
    handler: action$,
  },
];
