import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";

const c = initContract();

export const connectorsTypeCallbackContract = c.router({
  callback: {
    method: "GET",
    path: "/api/connectors/:type/callback",
    headers: authHeadersSchema,
    pathParams: z.object({ type: z.string() }),
    query: z.object({
      code: z.string().optional(),
      state: z.string().optional(),
      error: z.string().optional(),
      error_description: z.string().optional(),
    }),
    responses: {
      307: c.noBody(),
    },
    summary: "Complete connector OAuth authorization",
  },
});

export type ConnectorsTypeCallbackContract =
  typeof connectorsTypeCallbackContract;
