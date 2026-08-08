import { z } from "zod";
import { authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";
import { initContract } from "./trpc-contract";

const c = initContract();

export const zeroWebFilesContract = c.router({
  download: {
    method: "GET",
    path: "/api/zero/web/download-file",
    headers: authHeadersSchema,
    query: z.object({ file_id: z.string().min(1) }),
    responses: {
      200: c.otherResponse({
        contentType: "application/octet-stream",
        body: c.type<Blob>(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Download a web-uploaded file",
  },
});
