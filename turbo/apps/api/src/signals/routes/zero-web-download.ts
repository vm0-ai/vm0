import { computed } from "ccstate";
import { zeroWebFilesContract } from "@vm0/api-contracts/contracts/zero-web-files";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import { notFound, badRequestMessage } from "../../lib/error";
import { zeroWebDownloadFile } from "../services/zero-web-download.service";
import type { RouteEntry } from "../route-entry";

const downloadFileInner$ = computed(async (get) => {
  const auth = get(authContext$);
  const params = get(queryOf(zeroWebFilesContract.download));

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
  headers.set("Cache-Control", "private, no-store");

  return new Response(new Uint8Array(result.buffer), {
    status: 200,
    headers,
  });
});

export const zeroWebDownloadRoutes: readonly RouteEntry[] = [
  {
    route: zeroWebFilesContract.download,
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
