import { command, computed } from "ccstate";
import { and, eq } from "drizzle-orm";
import { chatThreadArtifactsContract } from "@vm0/api-contracts/contracts/chat-threads";
import { htmlArtifactEditDrafts } from "@vm0/db/schema/html-artifact-edit-draft";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroAgents } from "@vm0/db/schema/zero-agent";

import { env } from "../../lib/env";
import { badRequestMessage, notFound } from "../../lib/error";
import { buildFileUrlFromKey } from "../../lib/file-url";
import { nowDate } from "../../lib/time";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { putS3Object } from "../external/s3";
import { db$, writeDb$ } from "../external/db";
import { rejectSuspendedOrg$ } from "../services/zero-org-suspension.service";
import type { RouteEntry } from "../route-entry";

const HTML_ARTIFACT_EDIT_CONTENT_TYPE = "text/html";
const MAX_HTML_ARTIFACT_EDIT_SNAPSHOT_BYTES = 5 * 1024 * 1024;
const MAX_HTML_ARTIFACT_EDIT_SNAPSHOT_LABEL = "5 MB";

function threadNotFound() {
  return notFound("Chat thread not found");
}

function snapshotObjectKey(draftId: string): string {
  return ["artifacts", "html-edit-drafts", `${draftId}.html`].join("/");
}

function versionedSnapshotUrl(key: string, updatedAt: Date): string {
  return `${buildFileUrlFromKey(key)}?v=${String(updatedAt.getTime())}`;
}

const ownedThread$ = computed(async (get) => {
  const auth = get(authContext$);
  const params = get(
    pathParamsOf(chatThreadArtifactsContract.getHtmlEditSnapshot),
  );
  const [thread] = await get(db$)
    .select({
      id: chatThreads.id,
      orgId: zeroAgents.orgId,
    })
    .from(chatThreads)
    .innerJoin(zeroAgents, eq(zeroAgents.id, chatThreads.agentComposeId))
    .where(
      and(
        eq(chatThreads.id, params.threadId),
        eq(chatThreads.userId, auth.userId),
      ),
    )
    .limit(1);

  return thread ?? null;
});

const getHtmlArtifactEditSnapshotInner$ = computed(async (get) => {
  const params = get(
    pathParamsOf(chatThreadArtifactsContract.getHtmlEditSnapshot),
  );
  const query = get(queryOf(chatThreadArtifactsContract.getHtmlEditSnapshot));
  const thread = await get(ownedThread$);
  if (!thread) {
    return threadNotFound();
  }

  const [draft] = await get(db$)
    .select({
      id: htmlArtifactEditDrafts.id,
      artifactUrl: htmlArtifactEditDrafts.artifactUrl,
      updatedAt: htmlArtifactEditDrafts.updatedAt,
    })
    .from(htmlArtifactEditDrafts)
    .where(
      and(
        eq(htmlArtifactEditDrafts.chatThreadId, params.threadId),
        eq(htmlArtifactEditDrafts.artifactUrl, query.url),
      ),
    )
    .limit(1);

  return {
    status: 200 as const,
    body: {
      snapshot: draft
        ? {
            artifactUrl: draft.artifactUrl,
            snapshotUrl: versionedSnapshotUrl(
              snapshotObjectKey(draft.id),
              draft.updatedAt,
            ),
            updatedAt: draft.updatedAt.toISOString(),
          }
        : null,
    },
  };
});

const upsertHtmlArtifactEditSnapshotInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = get(
      pathParamsOf(chatThreadArtifactsContract.upsertHtmlEditSnapshot),
    );
    const bodyResult = await get(
      bodyResultOf(chatThreadArtifactsContract.upsertHtmlEditSnapshot),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const thread = await get(ownedThread$);
    signal.throwIfAborted();
    if (!thread) {
      return threadNotFound();
    }

    const suspended = await set(rejectSuspendedOrg$, thread.orgId, signal);
    if (suspended) {
      return suspended;
    }

    const size = new TextEncoder().encode(bodyResult.data.html).byteLength;
    if (size > MAX_HTML_ARTIFACT_EDIT_SNAPSHOT_BYTES) {
      return badRequestMessage(
        `HTML artifact edit snapshot too large (max ${MAX_HTML_ARTIFACT_EDIT_SNAPSHOT_LABEL})`,
      );
    }

    const [draft] = await set(writeDb$)
      .insert(htmlArtifactEditDrafts)
      .values({
        chatThreadId: params.threadId,
        artifactUrl: bodyResult.data.url,
      })
      .onConflictDoUpdate({
        target: [
          htmlArtifactEditDrafts.chatThreadId,
          htmlArtifactEditDrafts.artifactUrl,
        ],
        set: {
          artifactUrl: bodyResult.data.url,
        },
      })
      .returning({
        id: htmlArtifactEditDrafts.id,
      });
    signal.throwIfAborted();

    if (!draft) {
      throw new Error("Failed to prepare HTML artifact edit draft");
    }

    const key = snapshotObjectKey(draft.id);
    await get(
      putS3Object(
        env("R2_USER_ARTIFACTS_BUCKET_NAME"),
        key,
        bodyResult.data.html,
        HTML_ARTIFACT_EDIT_CONTENT_TYPE,
      ),
    );
    signal.throwIfAborted();

    const updatedAt = nowDate();
    const [saved] = await set(writeDb$)
      .update(htmlArtifactEditDrafts)
      .set({ updatedAt })
      .where(eq(htmlArtifactEditDrafts.id, draft.id))
      .returning({
        artifactUrl: htmlArtifactEditDrafts.artifactUrl,
        updatedAt: htmlArtifactEditDrafts.updatedAt,
      });
    signal.throwIfAborted();

    if (!saved) {
      throw new Error("Failed to save HTML artifact edit draft");
    }

    return {
      status: 200 as const,
      body: {
        artifactUrl: saved.artifactUrl,
        snapshotUrl: versionedSnapshotUrl(key, saved.updatedAt),
        updatedAt: saved.updatedAt.toISOString(),
      },
    };
  },
);

const deleteHtmlArtifactEditSnapshotInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = get(
      pathParamsOf(chatThreadArtifactsContract.deleteHtmlEditSnapshot),
    );
    const query = get(
      queryOf(chatThreadArtifactsContract.deleteHtmlEditSnapshot),
    );
    const thread = await get(ownedThread$);
    signal.throwIfAborted();
    if (!thread) {
      return threadNotFound();
    }

    await set(writeDb$)
      .delete(htmlArtifactEditDrafts)
      .where(
        and(
          eq(htmlArtifactEditDrafts.chatThreadId, params.threadId),
          eq(htmlArtifactEditDrafts.artifactUrl, query.url),
        ),
      );
    signal.throwIfAborted();

    return { status: 204 as const, body: undefined };
  },
);

export const zeroChatThreadsHtmlArtifactEditSnapshotRoutes: readonly RouteEntry[] =
  [
    {
      route: chatThreadArtifactsContract.getHtmlEditSnapshot,
      handler: authRoute(
        { requireOrganization: true, missingOrganizationStatus: 401 },
        getHtmlArtifactEditSnapshotInner$,
      ),
    },
    {
      route: chatThreadArtifactsContract.upsertHtmlEditSnapshot,
      handler: authRoute(
        { requireOrganization: true, missingOrganizationStatus: 401 },
        upsertHtmlArtifactEditSnapshotInner$,
      ),
    },
    {
      route: chatThreadArtifactsContract.deleteHtmlEditSnapshot,
      handler: authRoute(
        { requireOrganization: true, missingOrganizationStatus: 401 },
        deleteHtmlArtifactEditSnapshotInner$,
      ),
    },
  ];
