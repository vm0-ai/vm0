import {
  IMAGE_REFERENCE_PREVIEW_URL_TTL_SECONDS,
  imageReferencesContract,
  type ImageReferencePreviewAsset,
} from "@okouai/api-contracts/contracts/image-references";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command, computed } from "ccstate";

import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { nowDate } from "../../lib/time";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { db$ } from "../external/db";
import {
  publishImageReferencesChangedForOrgSafely,
  publishImageReferencesChangedForUserSafely,
} from "../external/realtime";
import { generatePresignedGetUrl } from "../external/s3";
import {
  imageReferencePreviewAssetId,
  imageReferenceResponse,
  listAccessibleImageReferences,
  loadAccessibleImageReference,
  loadAccessibleImageReferencesById,
  parseImageReferencePreviewAssetId,
  type ImageReferenceRow,
} from "../services/image-reference-data.service";
import { createImageReference$ } from "../services/image-reference-create.service";
import { deleteImageReference$ } from "../services/image-reference-delete.service";
import { updateImageReference$ } from "../services/image-reference-update.service";
import { loadUserFeatureSwitchContext } from "../services/feature-switches.service";
import { privateArtifactsBucket } from "../services/private-artifact-storage.service";
import type { RouteEntry } from "../route-entry";

const imageReferenceReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:read",
} as const;

const imageReferenceWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:write",
} as const;

const imageReferencesDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Reference images are not enabled",
      code: "FORBIDDEN" as const,
    }),
  }),
});

const imageReferencesEnabled$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const context = await loadUserFeatureSwitchContext(
    get(db$),
    auth.orgId,
    auth.userId,
  );
  return isFeatureEnabled(FeatureSwitchKey.ReferenceImages, context);
});

function imageReferenceNotFound(referenceId: string) {
  return notFound(`Image reference not found: ${referenceId}`);
}

function resolveImageReferencePreviewAsset(row: ImageReferenceRow) {
  return computed(async (get): Promise<ImageReferencePreviewAsset> => {
    const issuedAt = nowDate();
    const url = await get(
      generatePresignedGetUrl(
        privateArtifactsBucket(),
        row.sourceStorageKey,
        IMAGE_REFERENCE_PREVIEW_URL_TTL_SECONDS,
        undefined,
        true,
      ),
    );
    return {
      previewAssetId: imageReferencePreviewAssetId(row),
      url,
      expiresAt: new Date(
        issuedAt.getTime() + IMAGE_REFERENCE_PREVIEW_URL_TTL_SECONDS * 1000,
      ).toISOString(),
    };
  });
}

async function publishImageReferenceMutation(args: {
  readonly ownerUserId: string;
  readonly orgId: string;
  readonly previousVisibility?: "private" | "public";
  readonly visibility: "private" | "public";
}): Promise<void> {
  if (args.previousVisibility === "public" || args.visibility === "public") {
    await publishImageReferencesChangedForOrgSafely(args.orgId);
    return;
  }
  await publishImageReferencesChangedForUserSafely(args.ownerUserId);
}

const createBody$ = bodyResultOf(imageReferencesContract.create);
const createInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(imageReferencesEnabled$))) {
    return imageReferencesDisabled;
  }
  signal.throwIfAborted();
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(createBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const result = await set(
    createImageReference$,
    {
      orgId: auth.orgId,
      ownerUserId: auth.userId,
      body: bodyResult.data,
    },
    signal,
  );
  signal.throwIfAborted();
  if (result.kind === "rejected") {
    return badRequestMessage(result.message);
  }
  if (result.kind === "conflict") {
    return conflict("The uploaded file already has an image reference");
  }

  const row = await loadAccessibleImageReference(get(db$), {
    orgId: auth.orgId,
    userId: auth.userId,
    referenceId: result.referenceId,
  });
  signal.throwIfAborted();
  if (!row) {
    throw new Error(`Created image reference not found: ${result.referenceId}`);
  }
  const previewAsset = await get(resolveImageReferencePreviewAsset(row));
  signal.throwIfAborted();
  await publishImageReferenceMutation({
    ownerUserId: row.ownerUserId,
    orgId: row.orgId,
    visibility: row.visibility,
  });
  signal.throwIfAborted();
  return {
    status: 201 as const,
    body: imageReferenceResponse({
      row,
      previewAsset,
      userId: auth.userId,
      isOrgAdmin: auth.orgRole === "admin",
    }),
  };
});

const listInner$ = command(async ({ get }, signal: AbortSignal) => {
  if (!(await get(imageReferencesEnabled$))) {
    return imageReferencesDisabled;
  }
  signal.throwIfAborted();
  const auth = get(organizationAuthContext$);
  const rows = await listAccessibleImageReferences(get(db$), {
    orgId: auth.orgId,
    userId: auth.userId,
  });
  signal.throwIfAborted();
  const previewAssets = await Promise.all(
    rows.map((row) => {
      return get(resolveImageReferencePreviewAsset(row));
    }),
  );
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: rows.map((row, index) => {
      const previewAsset = previewAssets[index];
      if (!previewAsset) {
        throw new Error(
          `Preview was not resolved for image reference ${row.id}`,
        );
      }
      return imageReferenceResponse({
        row,
        previewAsset,
        userId: auth.userId,
        isOrgAdmin: auth.orgRole === "admin",
      });
    }),
  };
});

const getParams$ = pathParamsOf(imageReferencesContract.get);
const getInner$ = command(async ({ get }, signal: AbortSignal) => {
  if (!(await get(imageReferencesEnabled$))) {
    return imageReferencesDisabled;
  }
  signal.throwIfAborted();
  const auth = get(organizationAuthContext$);
  const params = get(getParams$);
  const row = await loadAccessibleImageReference(get(db$), {
    orgId: auth.orgId,
    userId: auth.userId,
    referenceId: params.referenceId,
  });
  signal.throwIfAborted();
  if (!row) {
    return imageReferenceNotFound(params.referenceId);
  }
  const previewAsset = await get(resolveImageReferencePreviewAsset(row));
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: imageReferenceResponse({
      row,
      previewAsset,
      userId: auth.userId,
      isOrgAdmin: auth.orgRole === "admin",
    }),
  };
});

const resolvePreviewUrlsBody$ = bodyResultOf(
  imageReferencesContract.resolvePreviewUrls,
);
const resolvePreviewUrlsInner$ = command(
  async ({ get }, signal: AbortSignal) => {
    if (!(await get(imageReferencesEnabled$))) {
      return imageReferencesDisabled;
    }
    signal.throwIfAborted();
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(resolvePreviewUrlsBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const identities = bodyResult.data.previewAssetIds.flatMap(
      (previewAssetId) => {
        const identity = parseImageReferencePreviewAssetId(previewAssetId);
        return identity ? [{ previewAssetId, identity }] : [];
      },
    );
    const rows = await loadAccessibleImageReferencesById(get(db$), {
      orgId: auth.orgId,
      userId: auth.userId,
      referenceIds: identities.map(({ identity }) => {
        return identity.referenceId;
      }),
    });
    signal.throwIfAborted();
    const rowById = new Map(
      rows.map((row) => {
        return [row.id, row];
      }),
    );
    const accessibleRows = [
      ...new Map(
        identities.flatMap(({ previewAssetId, identity }) => {
          const row = rowById.get(identity.referenceId);
          return row && imageReferencePreviewAssetId(row) === previewAssetId
            ? [[previewAssetId, row] as const]
            : [];
        }),
      ).values(),
    ];
    const assets = await Promise.all(
      accessibleRows.map((row) => {
        return get(resolveImageReferencePreviewAsset(row));
      }),
    );
    signal.throwIfAborted();
    return { status: 200 as const, body: { assets } };
  },
);

const updateParams$ = pathParamsOf(imageReferencesContract.update);
const updateBody$ = bodyResultOf(imageReferencesContract.update);
const updateInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(imageReferencesEnabled$))) {
    return imageReferencesDisabled;
  }
  signal.throwIfAborted();
  const auth = get(organizationAuthContext$);
  const params = get(updateParams$);
  const bodyResult = await get(updateBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const mutation = await set(
    updateImageReference$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      isOrgAdmin: auth.orgRole === "admin",
      referenceId: params.referenceId,
      body: bodyResult.data,
    },
    signal,
  );
  signal.throwIfAborted();
  if (!mutation) {
    return imageReferenceNotFound(params.referenceId);
  }

  await publishImageReferenceMutation({
    ownerUserId: mutation.ownerUserId,
    orgId: auth.orgId,
    previousVisibility: mutation.previousVisibility,
    visibility: mutation.visibility,
  });
  signal.throwIfAborted();
  if (mutation.kind === "moderated") {
    return { status: 204 as const, body: undefined };
  }

  const row = await loadAccessibleImageReference(get(db$), {
    orgId: auth.orgId,
    userId: auth.userId,
    referenceId: params.referenceId,
  });
  signal.throwIfAborted();
  if (!row) {
    throw new Error(`Updated image reference not found: ${params.referenceId}`);
  }
  const previewAsset = await get(resolveImageReferencePreviewAsset(row));
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: imageReferenceResponse({
      row,
      previewAsset,
      userId: auth.userId,
      isOrgAdmin: auth.orgRole === "admin",
    }),
  };
});

const deleteParams$ = pathParamsOf(imageReferencesContract.delete);
const deleteInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(imageReferencesEnabled$))) {
    return imageReferencesDisabled;
  }
  signal.throwIfAborted();
  const auth = get(organizationAuthContext$);
  const params = get(deleteParams$);
  const deleted = await set(
    deleteImageReference$,
    {
      orgId: auth.orgId,
      ownerUserId: auth.userId,
      referenceId: params.referenceId,
    },
    signal,
  );
  signal.throwIfAborted();
  if (!deleted) {
    return imageReferenceNotFound(params.referenceId);
  }
  await publishImageReferenceMutation({
    ownerUserId: auth.userId,
    orgId: auth.orgId,
    previousVisibility: deleted.visibility,
    visibility: deleted.visibility,
  });
  signal.throwIfAborted();
  return { status: 204 as const, body: undefined };
});

export const imageReferencesRoutes: readonly RouteEntry[] = [
  {
    route: imageReferencesContract.create,
    handler: authRoute(imageReferenceWriteAuth, createInner$),
  },
  {
    route: imageReferencesContract.list,
    handler: authRoute(imageReferenceReadAuth, listInner$),
  },
  {
    route: imageReferencesContract.resolvePreviewUrls,
    handler: authRoute(imageReferenceReadAuth, resolvePreviewUrlsInner$),
  },
  {
    route: imageReferencesContract.get,
    handler: authRoute(imageReferenceReadAuth, getInner$),
  },
  {
    route: imageReferencesContract.update,
    handler: authRoute(imageReferenceWriteAuth, updateInner$),
  },
  {
    route: imageReferencesContract.delete,
    handler: authRoute(imageReferenceWriteAuth, deleteInner$),
  },
];
