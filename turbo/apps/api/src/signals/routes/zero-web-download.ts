import { initContract } from "@ts-rest/core";
import { z } from "zod";
import { computed } from "ccstate";

import { authHeadersSchema } from "@vm0/api-contracts/contracts/base";
import { apiErrorSchema } from "@vm0/api-contracts/contracts/errors";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import { notFound, badRequestMessage } from "../../lib/error";
import { zeroWebDownloadFile } from "../services/zero-web-download.service";
import type { RouteEntry } from "../route";

const c = initContract();

const downloadFileContract = c.router({
  download: {
    method: "GET",
    path: "/api/zero/web/download-file",
    headers: authHeadersSchema,
    query: z.object({ file_id: z.string().min(1) }),
    responses: {
      200: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Download a web-uploaded file",
  },
});

const downloadFileInner$ = computed(async (get) => {
  const auth = get(authContext$);
  const params = get(queryOf(downloadFileContract.download));

  const fileId = params.file_id;
  if (!fileId) {
    return badRequestMessage("file_id query parameter is required");
  }

  const result = await get(zeroWebDownloadFile(fileId, auth.userId));
  if (!result) {
    return notFound("File not found");
  }

  const headers = new Headers();
  headers.set("Content-Type", result.contentType);
  headers.set("X-File-Name", encodeURIComponent(result.filename));
  headers.set("X-File-Mimetype", result.contentType);
  headers.set("Content-Length", String(result.buffer.length));

  return new Response(new Uint8Array(result.buffer), {
    status: 200,
    headers,
  });
});

export const zeroWebDownloadRoutes: readonly RouteEntry[] = [
  {
    route: downloadFileContract.download,
    handler: authRoute(
      {
        requireOrganization: false,
        missingOrganizationStatus: 401,
        requiredCapability: "file:read",
      },
      downloadFileInner$,
    ),
  },
];
