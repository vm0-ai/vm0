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

export const createDeviceTokenRequestSchema = z.object({
  device_type: z.literal("bb0"),
  ble_session_nonce: bleSessionNonceSchema,
});

export const createDeviceTokenResponseSchema = z.object({
  device_code: bb0DeviceCodeSchema,
  expires_in: z.number().int().positive(),
});

export const bindBb0DeviceRequestSchema = z.object({
  device_code: bb0DeviceCodeSchema,
  ble_session_nonce: bleSessionNonceSchema,
});

export const bindBb0DeviceResponseSchema = z.object({
  api_token: z.string(),
  thread_id: z.string().uuid(),
});

export type CreateDeviceTokenRequest = z.infer<
  typeof createDeviceTokenRequestSchema
>;
export type CreateDeviceTokenResponse = z.infer<
  typeof createDeviceTokenResponseSchema
>;
export type BindBb0DeviceRequest = z.infer<typeof bindBb0DeviceRequestSchema>;
export type BindBb0DeviceResponse = z.infer<typeof bindBb0DeviceResponseSchema>;

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
});

export const bb0DeviceBindContract = c.router({
  bind: {
    method: "POST",
    path: "/api/zero/devices/bb0/bind",
    headers: authHeadersSchema,
    body: bindBb0DeviceRequestSchema,
    responses: {
      200: bindBb0DeviceResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Bind a bb0 device code to the authenticated user",
  },
});

export type DeviceTokenContract = typeof deviceTokenContract;
export type Bb0DeviceBindContract = typeof bb0DeviceBindContract;
