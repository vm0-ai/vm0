import { z } from "zod";
import { initContract } from "./base";

const c = initContract();

export const appVersionSchema = z
  .string()
  .regex(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u,
    "Expected an app version like 1.229.0",
  );

export const webClientCompatibilityQuerySchema = z.object({
  version: appVersionSchema,
});

export const webClientCompatibilityResponseSchema = z.object({
  minimumSupportedVersion: appVersionSchema,
  supported: z.boolean(),
});

export const webClientCompatibilityContract = c.router({
  get: {
    method: "GET",
    path: "/api/client/compatibility",
    query: webClientCompatibilityQuerySchema,
    responses: {
      200: webClientCompatibilityResponseSchema,
    },
    summary: "Check web client version compatibility",
  },
});

export type WebClientCompatibilityContract =
  typeof webClientCompatibilityContract;
export type WebClientCompatibilityResponse = z.infer<
  typeof webClientCompatibilityResponseSchema
>;
export type WebClientCompatibilityRouteResponse = {
  readonly status: 200;
  readonly body: WebClientCompatibilityResponse;
};
