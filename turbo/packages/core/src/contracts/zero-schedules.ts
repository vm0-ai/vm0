import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
  deployScheduleRequestSchema,
  scheduleListResponseSchema,
  deployScheduleResponseSchema,
  scheduleResponseSchema,
} from "./schedules";

const c = initContract();

/**
 * Zero schedules main contract (GET/POST /api/zero/schedules)
 * Proxies to schedulesMainContract
 */
export const zeroSchedulesMainContract = c.router({
  deploy: {
    method: "POST",
    path: "/api/zero/schedules",
    headers: authHeadersSchema,
    body: deployScheduleRequestSchema,
    responses: {
      200: deployScheduleResponseSchema,
      201: deployScheduleResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Deploy schedule (zero proxy)",
  },
  list: {
    method: "GET",
    path: "/api/zero/schedules",
    headers: authHeadersSchema,
    responses: {
      200: scheduleListResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List all schedules (zero proxy)",
  },
});

/**
 * Zero schedules by name contract (DELETE /api/zero/schedules/:name)
 * Proxies to schedulesByNameContract.delete
 */
export const zeroSchedulesByNameContract = c.router({
  delete: {
    method: "DELETE",
    path: "/api/zero/schedules/:name",
    headers: authHeadersSchema,
    pathParams: z.object({
      name: z.string().min(1, "Schedule name required"),
    }),
    query: z.object({
      composeId: z.string().uuid("Compose ID required"),
    }),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Delete schedule (zero proxy)",
  },
});

/**
 * Zero schedules enable/disable contract
 * Proxies to schedulesEnableContract
 */
export const zeroSchedulesEnableContract = c.router({
  enable: {
    method: "POST",
    path: "/api/zero/schedules/:name/enable",
    headers: authHeadersSchema,
    pathParams: z.object({
      name: z.string().min(1, "Schedule name required"),
    }),
    body: z.object({
      composeId: z.string().uuid("Compose ID required"),
    }),
    responses: {
      200: scheduleResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Enable schedule (zero proxy)",
  },
  disable: {
    method: "POST",
    path: "/api/zero/schedules/:name/disable",
    headers: authHeadersSchema,
    pathParams: z.object({
      name: z.string().min(1, "Schedule name required"),
    }),
    body: z.object({
      composeId: z.string().uuid("Compose ID required"),
    }),
    responses: {
      200: scheduleResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Disable schedule (zero proxy)",
  },
});

// Type exports
export type ZeroSchedulesMainContract = typeof zeroSchedulesMainContract;
export type ZeroSchedulesByNameContract = typeof zeroSchedulesByNameContract;
export type ZeroSchedulesEnableContract = typeof zeroSchedulesEnableContract;
