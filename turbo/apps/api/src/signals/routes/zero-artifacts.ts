import { command } from "ccstate";
import { and, eq, exists, sql, type SQL } from "drizzle-orm";
import { artifactsContract } from "@vm0/api-contracts/contracts/chat-threads";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { imageArtifactEditSnapshots } from "@vm0/db/schema/image-artifact-edit-snapshot";
import { runUploadedFiles } from "@vm0/db/schema/run-uploaded-file";
import { z } from "zod";

import { executeRawRows } from "../../lib/db-raw-rows";
import { env } from "../../lib/env";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, queryOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import {
  artifactFavoriteUrls$,
  favoriteArtifact$,
  unfavoriteArtifact$,
  zeroArtifacts$,
} from "../services/zero-chat-thread.service";
import { nowDate } from "../../lib/time";
import { notFound } from "../../lib/error";
import type { RouteEntry } from "../route-entry";

const artifactAccessRowSchema = z.object({ canAccess: z.boolean() });

interface UserArtifactUrlAccessArgs {
  readonly artifactUrl: string;
  readonly orgId: string;
  readonly userId: string;
}

function artifactNotFound() {
  return notFound("Artifact not found");
}

function publicArtifactObjectKey(url: string): string | null {
  const base = new URL(env("PUBLIC_ARTIFACTS_BASE_URL"));
  const parsed = new URL(url);
  if (parsed.origin !== base.origin) {
    return null;
  }

  const basePath = base.pathname.replace(/\/+$/, "");
  const pathPrefix = basePath === "" ? "/" : `${basePath}/`;
  if (!parsed.pathname.startsWith(pathPrefix)) {
    return null;
  }

  const key = parsed.pathname.slice(pathPrefix.length);
  return key.length > 0 ? key : null;
}

function uploadedArtifactAccessCondition(
  db: Pick<Db, "select">,
  args: UserArtifactUrlAccessArgs,
): SQL {
  return exists(
    db
      .select({ id: runUploadedFiles.id })
      .from(runUploadedFiles)
      .where(
        and(
          eq(runUploadedFiles.userId, args.userId),
          eq(runUploadedFiles.orgId, args.orgId),
          eq(runUploadedFiles.url, args.artifactUrl),
        ),
      ),
  );
}

function attachedArtifactAccessCondition(
  db: Pick<Db, "select">,
  args: UserArtifactUrlAccessArgs,
): SQL {
  const objectKey = publicArtifactObjectKey(args.artifactUrl);
  if (objectKey === null) {
    return sql`FALSE`;
  }

  const attachedFile = sql`jsonb_array_elements(
    COALESCE(${chatMessages.attachFileMetadata}, '[]'::jsonb)
  ) AS attached_file`;
  const attachedFileObjectKey = sql`attached_file->>'objectKey'`;
  return exists(
    db
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .innerJoin(chatThreads, eq(chatThreads.id, chatMessages.chatThreadId))
      .innerJoin(
        agentComposes,
        eq(agentComposes.id, chatThreads.agentComposeId),
      )
      .where(
        and(
          eq(chatThreads.userId, args.userId),
          eq(agentComposes.orgId, args.orgId),
          exists(
            db
              .select({ one: sql`1`.mapWith(Number) })
              .from(attachedFile)
              .where(eq(attachedFileObjectKey, objectKey)),
          ),
        ),
      ),
  );
}

async function userCanAccessArtifactUrl(
  db: Db,
  args: UserArtifactUrlAccessArgs,
): Promise<boolean> {
  const rows = await executeRawRows(
    db,
    sql`
      SELECT (
        ${uploadedArtifactAccessCondition(db, args)}
        OR ${attachedArtifactAccessCondition(db, args)}
      ) AS "canAccess"
    `,
    artifactAccessRowSchema,
  );

  return rows[0]?.canAccess === true;
}

async function deleteImageEditSnapshotRow(
  db: Db,
  args: UserArtifactUrlAccessArgs,
): Promise<void> {
  await db
    .delete(imageArtifactEditSnapshots)
    .where(
      and(
        eq(imageArtifactEditSnapshots.orgId, args.orgId),
        eq(imageArtifactEditSnapshots.userId, args.userId),
        eq(imageArtifactEditSnapshots.artifactUrl, args.artifactUrl),
      ),
    );
}

const listArtifactsInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const query = get(queryOf(artifactsContract.list));

    const result = await set(
      zeroArtifacts$,
      {
        userId: auth.userId,
        orgId: auth.orgId,
        limit: query.limit,
        cursor: query.cursor,
        updatedAfter: query.updatedAfter,
      },
      signal,
    );
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        artifacts: result.artifacts,
        truncated: result.truncated,
        nextCursor: result.nextCursor,
        syncUntil: result.syncUntil,
      },
    };
  },
);

const listArtifactFavoritesInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const artifactUrls = await set(
      artifactFavoriteUrls$,
      { userId: auth.userId, orgId: auth.orgId },
      signal,
    );

    return {
      status: 200 as const,
      body: { artifactUrls },
    };
  },
);

const favoriteArtifactInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(bodyResultOf(artifactsContract.favorite));
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const visible = await set(
      favoriteArtifact$,
      {
        userId: auth.userId,
        orgId: auth.orgId,
        artifactUrl: bodyResult.data.artifactUrl,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!visible) {
      return notFound("Artifact not found");
    }

    return { status: 204 as const, body: undefined };
  },
);

const unfavoriteArtifactInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(bodyResultOf(artifactsContract.unfavorite));
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    await set(
      unfavoriteArtifact$,
      {
        userId: auth.userId,
        orgId: auth.orgId,
        artifactUrl: bodyResult.data.artifactUrl,
      },
      signal,
    );
    signal.throwIfAborted();

    return { status: 204 as const, body: undefined };
  },
);

// Compatibility for browser bundles shipped before image editing was retired.
// Remove these snapshot routes and their table after the rollback window closes.
const getImageEditSnapshotInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const query = get(queryOf(artifactsContract.getImageEditSnapshot));
    const db = set(writeDb$);
    const canAccess = await userCanAccessArtifactUrl(db, {
      artifactUrl: query.url,
      orgId: auth.orgId,
      userId: auth.userId,
    });
    signal.throwIfAborted();
    if (!canAccess) {
      return artifactNotFound();
    }

    const [row] = await db
      .select({
        artifactUrl: imageArtifactEditSnapshots.artifactUrl,
        snapshot: imageArtifactEditSnapshots.snapshot,
        updatedAt: imageArtifactEditSnapshots.updatedAt,
      })
      .from(imageArtifactEditSnapshots)
      .where(
        and(
          eq(imageArtifactEditSnapshots.orgId, auth.orgId),
          eq(imageArtifactEditSnapshots.userId, auth.userId),
          eq(imageArtifactEditSnapshots.artifactUrl, query.url),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        snapshot: row
          ? {
              artifactUrl: row.artifactUrl,
              snapshot: row.snapshot,
              updatedAt: row.updatedAt.toISOString(),
            }
          : null,
      },
    };
  },
);

const upsertImageEditSnapshotInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(
      bodyResultOf(artifactsContract.upsertImageEditSnapshot),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const db = set(writeDb$);
    const canAccess = await userCanAccessArtifactUrl(db, {
      artifactUrl: bodyResult.data.url,
      orgId: auth.orgId,
      userId: auth.userId,
    });
    signal.throwIfAborted();
    if (!canAccess) {
      return artifactNotFound();
    }

    const updatedAt = nowDate();
    const [row] = await db
      .insert(imageArtifactEditSnapshots)
      .values({
        artifactUrl: bodyResult.data.url,
        orgId: auth.orgId,
        snapshot: bodyResult.data.snapshot,
        updatedAt,
        userId: auth.userId,
      })
      .onConflictDoUpdate({
        target: [
          imageArtifactEditSnapshots.orgId,
          imageArtifactEditSnapshots.userId,
          imageArtifactEditSnapshots.artifactUrl,
        ],
        set: {
          snapshot: bodyResult.data.snapshot,
          updatedAt,
        },
      })
      .returning({
        artifactUrl: imageArtifactEditSnapshots.artifactUrl,
        snapshot: imageArtifactEditSnapshots.snapshot,
        updatedAt: imageArtifactEditSnapshots.updatedAt,
      });
    signal.throwIfAborted();

    if (!row) {
      throw new Error("Failed to save image artifact edit snapshot");
    }

    return {
      status: 200 as const,
      body: {
        artifactUrl: row.artifactUrl,
        snapshot: row.snapshot,
        updatedAt: row.updatedAt.toISOString(),
      },
    };
  },
);

const deleteImageEditSnapshotInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const query = get(queryOf(artifactsContract.deleteImageEditSnapshot));
    const db = set(writeDb$);
    const canAccess = await userCanAccessArtifactUrl(db, {
      artifactUrl: query.url,
      orgId: auth.orgId,
      userId: auth.userId,
    });
    signal.throwIfAborted();
    if (!canAccess) {
      return artifactNotFound();
    }

    await deleteImageEditSnapshotRow(db, {
      artifactUrl: query.url,
      orgId: auth.orgId,
      userId: auth.userId,
    });
    signal.throwIfAborted();

    return { status: 204 as const, body: undefined };
  },
);

export const zeroArtifactsRoutes: readonly RouteEntry[] = [
  {
    route: artifactsContract.list,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-message:read",
      },
      listArtifactsInner$,
    ),
  },
  {
    route: artifactsContract.listFavorites,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-message:read",
      },
      listArtifactFavoritesInner$,
    ),
  },
  {
    route: artifactsContract.favorite,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-message:read",
      },
      favoriteArtifactInner$,
    ),
  },
  {
    route: artifactsContract.unfavorite,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-message:read",
      },
      unfavoriteArtifactInner$,
    ),
  },
  {
    route: artifactsContract.getImageEditSnapshot,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-message:read",
      },
      getImageEditSnapshotInner$,
    ),
  },
  {
    route: artifactsContract.upsertImageEditSnapshot,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-message:read",
      },
      upsertImageEditSnapshotInner$,
    ),
  },
  {
    route: artifactsContract.deleteImageEditSnapshot,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-message:read",
      },
      deleteImageEditSnapshotInner$,
    ),
  },
];
