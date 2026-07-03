import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const bb0DeviceCodeSchema = z
  .string()
  .regex(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

export const bleSessionNonceSchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

export const pollTokenSchema = z
  .string()
  .min(32)
  .max(256)
  .regex(/^[A-Za-z0-9._-]+$/);

export const createDeviceTokenRequestSchema = z.object({
  device_type: z.literal("bb0"),
  ble_session_nonce: bleSessionNonceSchema.optional(),
});

export const createDeviceTokenResponseSchema = z.object({
  device_code: bb0DeviceCodeSchema,
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive(),
  poll_token: pollTokenSchema,
});

export const pollDeviceTokenRequestSchema = z.object({
  device_code: bb0DeviceCodeSchema,
  poll_token: pollTokenSchema,
});

export const pollDeviceTokenPendingResponseSchema = z.object({
  status: z.literal("pending"),
  interval: z.number().int().positive(),
});

export const pollDeviceTokenApprovedResponseSchema = z.object({
  status: z.literal("approved"),
  api_token: z.string(),
  thread_id: z.string().uuid(),
});

export const pollDeviceTokenExpiredResponseSchema = z.object({
  status: z.literal("expired"),
});

export const pollDeviceTokenInvalidResponseSchema = z.object({
  status: z.literal("invalid"),
});

export const confirmBb0DeviceRequestSchema = z.object({
  device_code: bb0DeviceCodeSchema,
});

export const confirmBb0DeviceResponseSchema = z.object({
  status: z.literal("approved"),
});

export type CreateDeviceTokenRequest = z.infer<
  typeof createDeviceTokenRequestSchema
>;
export type CreateDeviceTokenResponse = z.infer<
  typeof createDeviceTokenResponseSchema
>;
export type PollDeviceTokenRequest = z.infer<
  typeof pollDeviceTokenRequestSchema
>;
export type PollDeviceTokenPendingResponse = z.infer<
  typeof pollDeviceTokenPendingResponseSchema
>;
export type PollDeviceTokenApprovedResponse = z.infer<
  typeof pollDeviceTokenApprovedResponseSchema
>;
export type PollDeviceTokenExpiredResponse = z.infer<
  typeof pollDeviceTokenExpiredResponseSchema
>;
export type PollDeviceTokenInvalidResponse = z.infer<
  typeof pollDeviceTokenInvalidResponseSchema
>;
export type ConfirmBb0DeviceRequest = z.infer<
  typeof confirmBb0DeviceRequestSchema
>;
export type ConfirmBb0DeviceResponse = z.infer<
  typeof confirmBb0DeviceResponseSchema
>;

export const deviceTokenContract = c.router({
  create: {
    method: "POST",
    path: "/api/device-token",
    body: createDeviceTokenRequestSchema,
    responses: {
      200: createDeviceTokenResponseSchema,
      400: apiErrorSchema,
    },
    summary: "Create a short-lived device code for embedded device onboarding",
  },
  poll: {
    method: "POST",
    path: "/api/device-token/poll",
    body: pollDeviceTokenRequestSchema,
    responses: {
      200: pollDeviceTokenApprovedResponseSchema,
      202: pollDeviceTokenPendingResponseSchema,
      400: apiErrorSchema,
      404: pollDeviceTokenInvalidResponseSchema,
      410: pollDeviceTokenExpiredResponseSchema,
    },
    summary: "Poll a bb0 device code for approval and final credentials",
  },
});

export const bb0DeviceConfirmContract = c.router({
  confirm: {
    method: "POST",
    path: "/api/zero/devices/bb0/confirm",
    headers: authHeadersSchema,
    body: confirmBb0DeviceRequestSchema,
    responses: {
      200: confirmBb0DeviceResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Confirm a bb0 device code for the authenticated user",
  },
});

export type DeviceTokenContract = typeof deviceTokenContract;
export type Bb0DeviceConfirmContract = typeof bb0DeviceConfirmContract;
