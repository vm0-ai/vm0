import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";

const c = initContract();

const phoneStatusResponseSchema = z.object({
  userPhone: z.string().nullable(),
  userPhonePending: z.string().nullable(),
  orgPhone: z.string().nullable(),
});

const phoneLinkBodySchema = z.object({
  phoneNumber: z.string(),
});

const phoneSuccessResponseSchema = z.object({
  success: z.literal(true),
});

const phoneSetupResponseSchema = z.object({
  phoneNumber: z.string(),
  agentId: z.string(),
});

// Phone API routes return { error: string } (plain string, not the structured
// ApiError format), so we use a simple error schema here.
const phoneErrorResponseSchema = z.object({
  error: z.string(),
});

export const zeroPhoneStatusContract = c.router({
  getStatus: {
    method: "GET",
    path: "/api/zero/phone/status",
    headers: authHeadersSchema,
    responses: {
      200: phoneStatusResponseSchema,
      401: phoneErrorResponseSchema,
    },
    summary: "Get the current user's phone link status",
  },
});

export const zeroPhoneLinkContract = c.router({
  link: {
    method: "POST",
    path: "/api/zero/phone/link",
    headers: authHeadersSchema,
    body: phoneLinkBodySchema,
    responses: {
      200: phoneSuccessResponseSchema,
      400: phoneErrorResponseSchema,
      401: phoneErrorResponseSchema,
      403: phoneErrorResponseSchema,
    },
    summary: "Link a phone number to the current user",
  },
  unlink: {
    method: "DELETE",
    path: "/api/zero/phone/link",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      200: phoneSuccessResponseSchema,
      401: phoneErrorResponseSchema,
    },
    summary: "Remove the current user's phone link",
  },
});

export const zeroPhoneSetupContract = c.router({
  setup: {
    method: "POST",
    path: "/api/zero/phone/setup",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      200: phoneSetupResponseSchema,
      401: phoneErrorResponseSchema,
      403: phoneErrorResponseSchema,
      409: phoneErrorResponseSchema,
    },
    summary: "Provision a phone number for the org (admin only)",
  },
});

export type PhoneStatusResponse = z.infer<typeof phoneStatusResponseSchema>;
