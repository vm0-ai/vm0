import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const reportErrorBodySchema = z.object({
  runId: z.uuid("Run ID must be a valid UUID"),
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
});

const reportErrorResponseSchema = z.object({
  reference: z.string(),
});

export const zeroReportErrorContract = c.router({
  submit: {
    method: "POST",
    path: "/api/zero/report-error",
    headers: authHeadersSchema,
    body: reportErrorBodySchema,
    responses: {
      200: reportErrorResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Submit error report for a failed run",
  },
});

export type ZeroReportErrorContract = typeof zeroReportErrorContract;
export { reportErrorBodySchema, reportErrorResponseSchema };
