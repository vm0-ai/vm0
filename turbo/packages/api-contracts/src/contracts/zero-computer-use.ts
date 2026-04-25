import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Response schema for register endpoint
 */
const registerResponseSchema = z.object({
  id: z.string(),
  domain: z.string(),
  token: z.string(),
  ngrokToken: z.string(),
  endpointPrefix: z.string(),
});

/**
 * Response schema for host discovery endpoint
 */
const hostResponseSchema = z.object({
  domain: z.string(),
  token: z.string(),
});

/**
 * Contract for POST /api/zero/computer-use/register
 * Host registers for computer-use, returns ngrok credentials
 */
export const zeroComputerUseRegisterContract = c.router({
  register: {
    method: "POST",
    path: "/api/zero/computer-use/register",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      200: registerResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Register a computer-use host",
  },
});

/**
 * Contract for DELETE /api/zero/computer-use/unregister
 * Host deregisters and cleans up ngrok resources
 */
export const zeroComputerUseUnregisterContract = c.router({
  unregister: {
    method: "DELETE",
    path: "/api/zero/computer-use/unregister",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Unregister a computer-use host",
  },
});

/**
 * Contract for GET /api/zero/computer-use/host
 * Agent discovers available host for the current org/user
 */
export const zeroComputerUseHostContract = c.router({
  getHost: {
    method: "GET",
    path: "/api/zero/computer-use/host",
    headers: authHeadersSchema,
    responses: {
      200: hostResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get computer-use host for the current user",
  },
});

export type ZeroComputerUseRegisterContract =
  typeof zeroComputerUseRegisterContract;
export type ZeroComputerUseUnregisterContract =
  typeof zeroComputerUseUnregisterContract;
export type ZeroComputerUseHostContract = typeof zeroComputerUseHostContract;
