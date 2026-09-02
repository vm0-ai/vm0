import { z } from "zod";
import { authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";
import { initContract } from "./trpc-contract";

const c = initContract();

export const webFilesContract = c.router({
  download: {
    method: "GET",
    path: "/api/web/download-file",
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
  fileUrl: {
    method: "GET",
    path: "/api/web/file-url",
    headers: authHeadersSchema,
    query: z.object({ file_id: z.string().min(1) }),
    responses: {
      200: z.object({
        url: z.string(),
        /**
         * Stable public artifacts URL for the same object, suitable for a link
         * handed to someone else.
         *
         * Rollout fallback, surface new web/app -> old API: this route also
         * resolves the URL attachments render from, and the contract client
         * rejects a response missing a required field. Keeping `publicUrl`
         * optional means a newly promoted app reaching an API deployed before
         * this field loses only the share action instead of all attachment
         * rendering. Make it required once that API is no longer serving and is
         * no longer retained as a rollback target; follow-up #30847.
         */
        publicUrl: z.string().optional(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Resolve a temporary direct URL for a web-uploaded file",
  },
});
