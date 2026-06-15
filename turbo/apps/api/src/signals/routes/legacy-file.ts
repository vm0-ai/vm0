import { initContract } from "@ts-rest/core";
import { computed } from "ccstate";
import { z } from "zod";

import {
  buildArtifactKey,
  buildFileUrl,
  storageUserIdFromFileUrlSegment,
} from "../../lib/file-url";
import { env } from "../../lib/env";
import { generatePresignedGetUrl, s3ObjectExists } from "../external/s3";
import { pathParamsOf } from "../context/request";
import type { RouteEntry } from "../route";

const c = initContract();

const SIGNED_TTL_SECONDS = 300;

const legacyFileContract = c.router({
  get: {
    method: "GET",
    path: "/f/:userId/:id/:filename",
    pathParams: z.object({
      userId: z.string().min(1),
      id: z.string().min(1),
      filename: z.string().min(1),
    }),
    responses: {
      302: c.noBody(),
    },
    summary: "Legacy permanent file URL resolver",
  },
});

/**
 * Legacy permanent file URL resolver.
 *
 * New uploads return CDN URLs directly. This route keeps old
 * `/f/{userIdSegment}/{id}/{filename}` links alive by redirecting to the new
 * public artifact CDN when the migrated object exists. If the artifact object
 * is absent, it falls back to the old user-storage presigned URL convention.
 *
 * Access model: share-by-link. The path itself is the capability.
 *
 * TODO: Observe Axiom traces for one month after this migration before
 * deciding whether to remove this compatibility route.
 */
const legacyFile$ = computed(async (get) => {
  const { userId, id, filename } = get(pathParamsOf(legacyFileContract.get));
  const storageUserId = storageUserIdFromFileUrlSegment(userId);

  const artifactBucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
  const artifactKey = buildArtifactKey(storageUserId, id, filename);
  const artifactUrl = buildFileUrl(storageUserId, id, filename);

  if (await get(s3ObjectExists(artifactBucket, artifactKey))) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: artifactUrl,
        "Cache-Control": "public, max-age=300, must-revalidate",
      },
    });
  }

  const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
  const s3Key = `uploads/${storageUserId}/${id}/${filename}`;
  const signed = await get(
    generatePresignedGetUrl(bucket, s3Key, SIGNED_TTL_SECONDS, undefined, true),
  );

  return new Response(null, {
    status: 302,
    headers: {
      Location: signed,
      "Cache-Control": "private, max-age=60, must-revalidate",
    },
  });
});

export const legacyFileRoutes: readonly RouteEntry[] = [
  {
    route: legacyFileContract.get,
    handler: legacyFile$,
  },
];
