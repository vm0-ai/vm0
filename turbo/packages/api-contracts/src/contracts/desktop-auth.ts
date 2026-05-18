import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const desktopAuthHandoffContract = c.router({
  create: {
    method: "POST",
    path: "/api/desktop-auth/handoff",
    headers: authHeadersSchema,
    body: z.object({}).optional(),
    responses: {
      200: z.object({
        callbackUrl: z.string(),
      }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Create a desktop auth handoff code",
  },
});

export const desktopAuthConsumeContract = c.router({
  consume: {
    method: "POST",
    path: "/api/desktop-auth/consume",
    body: z.object({
      code: z.string().min(1, "code is required"),
    }),
    responses: {
      200: z.object({
        token: z.string(),
      }),
      400: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Consume a desktop auth handoff code",
  },
});

export type DesktopAuthHandoffContract = typeof desktopAuthHandoffContract;
export type DesktopAuthConsumeContract = typeof desktopAuthConsumeContract;
