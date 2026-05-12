import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";

const c = initContract();

export const connectorsTypeAuthorizeContract = c.router({
  authorize: {
    method: "GET",
    path: "/api/connectors/:type/authorize",
    headers: authHeadersSchema,
    pathParams: z.object({ type: z.string() }),
    query: z.object({ session: z.string().optional() }),
    responses: {
      307: c.noBody(),
      400: z.object({ error: z.string() }),
      500: z.object({ error: z.string() }),
    },
    summary: "Start connector OAuth authorization",
  },
});

export type ConnectorsTypeAuthorizeContract =
  typeof connectorsTypeAuthorizeContract;
