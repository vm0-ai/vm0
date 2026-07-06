import { command } from "ccstate";
import { chatThreadArtifactsContract } from "@vm0/api-contracts/contracts/chat-threads";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { request$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import {
  badRequestMessage,
  isBadRequestResponse,
  isNotFoundResponse,
} from "../../lib/error";
import {
  syncArtifactToGoogleDrive$,
  uploadPresentationToGoogleSlides$,
} from "../services/google-drive-artifact-sync.service";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import type { RouteEntry } from "../route-entry";

const syncInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(chatThreadArtifactsContract.syncGoogleDrive));
  signal.throwIfAborted();
  const bodyResult = await get(
    bodyResultOf(chatThreadArtifactsContract.syncGoogleDrive),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const result = await set(
    syncArtifactToGoogleDrive$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      threadId: params.threadId,
      runId: bodyResult.data.runId,
      fileId: bodyResult.data.fileId,
    },
    signal,
  );
  signal.throwIfAborted();

  if (isNotFoundResponse(result)) {
    return result;
  }
  if (isBadRequestResponse(result)) {
    return result;
  }
  return result;
});

function googleSlidesUploadDisabled() {
  return {
    status: 403 as const,
    body: {
      error: {
        message: "Google Slides upload is not available",
        code: "FORBIDDEN" as const,
      },
    },
  };
}

const uploadGoogleSlidesInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const overrides = await get(
      userFeatureSwitchOverrides(auth.orgId, auth.userId),
    );
    signal.throwIfAborted();
    if (
      !isFeatureEnabled(FeatureSwitchKey.PresentationGoogleSlidesUpload, {
        orgId: auth.orgId,
        userId: auth.userId,
        overrides,
      })
    ) {
      return googleSlidesUploadDisabled();
    }

    const params = get(
      pathParamsOf(chatThreadArtifactsContract.uploadGoogleSlides),
    );
    const request = get(request$);
    const formData = await request.raw.formData();
    signal.throwIfAborted();

    const file = formData.get("file");
    if (!(file instanceof File)) {
      return badRequestMessage("No presentation file provided");
    }
    const pptx = Buffer.from(await file.arrayBuffer());
    signal.throwIfAborted();

    const result = await set(
      uploadPresentationToGoogleSlides$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        threadId: params.threadId,
        filename: file.name,
        pptx,
      },
      signal,
    );
    signal.throwIfAborted();

    if (isBadRequestResponse(result)) {
      return result;
    }
    return result;
  },
);

export const zeroChatThreadsArtifactsSyncRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadArtifactsContract.syncGoogleDrive,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      syncInner$,
    ),
  },
  {
    route: chatThreadArtifactsContract.uploadGoogleSlides,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      uploadGoogleSlidesInner$,
    ),
  },
];
