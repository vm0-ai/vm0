import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const exportJobStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
]);

const userExportJobSchema = z.object({
  id: z.string().uuid(),
  status: exportJobStatusSchema,
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  downloadUrl: z.string().url().nullable(),
  error: z.string().nullable(),
});

const userExportStatusResponseSchema = z.object({
  job: userExportJobSchema.nullable(),
  canExport: z.boolean(),
  nextExportAt: z.string().nullable(),
});

export const userExportContract = c.router({
  get: {
    method: "GET",
    path: "/api/user/export",
    headers: authHeadersSchema,
    responses: {
      200: userExportStatusResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get current user export status",
  },
});

export type UserExportContract = typeof userExportContract;
export type UserExportStatusResponse = z.infer<
  typeof userExportStatusResponseSchema
>;
export type UserExportJob = z.infer<typeof userExportJobSchema>;
