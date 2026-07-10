import {
  type TestArtifactPreviewStateActionBody,
  testArtifactPreviewStateContract,
} from "@vm0/api-contracts/contracts/test-artifact-preview-state";
import { runUploadedFiles } from "@vm0/db/schema/run-uploaded-file";
import { command } from "ccstate";
import { and, eq, or, sql } from "drizzle-orm";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const actionBody$ = bodyResultOf(testArtifactPreviewStateContract.action);

function actionOk(extra: Record<string, unknown> = {}) {
  return {
    status: 200 as const,
    body: { ok: true as const, ...extra },
  };
}

type ArtifactPreviewStateAction = TestArtifactPreviewStateActionBody["action"];
type ArtifactPreviewStateActionResponse = ReturnType<typeof actionOk>;
type ArtifactPreviewStateActionHandler = (
  db: Db,
  body: TestArtifactPreviewStateActionBody,
  signal: AbortSignal,
) => Promise<ArtifactPreviewStateActionResponse>;

const actionHandlers = {
  async "mark-preview-cron-eligible"(db, body, signal) {
    const metadataPatch = body.generated_by
      ? {
          metadata: sql`${runUploadedFiles.metadata} || ${JSON.stringify({
            generatedBy: body.generated_by,
          })}::jsonb`,
        }
      : {};
    const rows = await db
      .update(runUploadedFiles)
      .set({
        ...metadataPatch,
        previewImageUrl: null,
        updatedAt: sql`now() - interval '3 minutes'`,
      })
      .where(
        and(
          eq(runUploadedFiles.runId, body.run_id),
          or(
            eq(runUploadedFiles.externalId, body.url),
            eq(runUploadedFiles.url, body.url),
          ),
        ),
      )
      .returning({ id: runUploadedFiles.id });
    signal.throwIfAborted();
    return actionOk({
      ids: rows.map((row) => {
        return row.id;
      }),
      updated: rows.length,
    });
  },
} satisfies Record<
  ArtifactPreviewStateAction,
  ArtifactPreviewStateActionHandler
>;

const mutateTestArtifactPreviewState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const db = set(writeDb$);
    const handler = actionHandlers[bodyResult.data.action];
    return await handler(db, bodyResult.data, signal);
  },
);

export const testArtifactPreviewStateRoutes: readonly RouteEntry[] = [
  {
    route: testArtifactPreviewStateContract.action,
    handler: mutateTestArtifactPreviewState$,
  },
];
