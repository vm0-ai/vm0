import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema, type ApiErrorResponse } from "./errors";

const c = initContract();

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
});

export const healthContract = c.router({
  check: {
    method: "GET",
    path: "/health",
    responses: {
      200: healthResponseSchema,
    },
    summary: "Check API health",
  },
});

export const healthAuthContract = c.router({
  check: {
    method: "GET",
    path: "/health/auth",
    headers: authHeadersSchema,
    responses: {
      200: healthResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Check authenticated API health",
  },
});

export type HealthContract = typeof healthContract;
export type HealthAuthContract = typeof healthAuthContract;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type HealthRouteResponse = {
  readonly status: 200;
  readonly body: HealthResponse;
};
export type HealthAuthRouteResponse =
  | HealthRouteResponse
  | {
      readonly status: 401;
      readonly body: ApiErrorResponse;
    };
