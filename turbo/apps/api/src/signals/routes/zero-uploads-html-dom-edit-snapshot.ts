import { command } from "ccstate";
import { zeroUploadsContract } from "@vm0/api-contracts/contracts/zero-uploads";

import { env } from "../../lib/env";
import { badRequestMessage } from "../../lib/error";
import {
  buildArtifactKey,
  buildFileUrl,
  sanitizeArtifactFilename,
} from "../../lib/file-url";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { putS3Object } from "../external/s3";
import { rejectSuspendedOrg$ } from "../services/zero-org-suspension.service";
import type { RouteEntry } from "../route";

const HTML_DOM_EDIT_CONTENT_TYPE = "text/html";
const MAX_HTML_DOM_EDIT_SNAPSHOT_BYTES = 5 * 1024 * 1024;
const MAX_HTML_DOM_EDIT_SNAPSHOT_LABEL = "5 MB";

const uploadHtmlDomEditSnapshotInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const bodyResult = await get(
      bodyResultOf(zeroUploadsContract.htmlDomEditSnapshot),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const size = new TextEncoder().encode(bodyResult.data.html).byteLength;
    if (size > MAX_HTML_DOM_EDIT_SNAPSHOT_BYTES) {
      return badRequestMessage(
        `HTML snapshot too large (max ${MAX_HTML_DOM_EDIT_SNAPSHOT_LABEL})`,
      );
    }

    if (auth.orgId) {
      const suspended = await set(rejectSuspendedOrg$, auth.orgId, signal);
      if (suspended) {
        return suspended;
      }
    }

    const id = crypto.randomUUID();
    const filename = sanitizeArtifactFilename(bodyResult.data.filename);
    const s3Key = buildArtifactKey(auth.userId, id, filename);
    const bucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");

    await get(
      putS3Object(
        bucket,
        s3Key,
        bodyResult.data.html,
        HTML_DOM_EDIT_CONTENT_TYPE,
      ),
    );
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        id,
        filename,
        contentType: HTML_DOM_EDIT_CONTENT_TYPE,
        size,
        url: buildFileUrl(auth.userId, id, filename),
      },
    };
  },
);

export const zeroUploadsHtmlDomEditSnapshotRoutes: readonly RouteEntry[] = [
  {
    route: zeroUploadsContract.htmlDomEditSnapshot,
    handler: authRoute(
      { requiredCapability: "file:write" },
      uploadHtmlDomEditSnapshotInner$,
    ),
  },
];
