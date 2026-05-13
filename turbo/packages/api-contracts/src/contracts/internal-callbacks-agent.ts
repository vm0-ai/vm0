import { initContract } from "./base";
import {
  internalCallbackBodySchema,
  internalCallbackErrorSchema,
  internalCallbackHeadersSchema,
  internalCallbackSuccessSchema,
} from "./internal-callbacks-shared";

const c = initContract();

export const internalCallbacksAgentContract = c.router({
  post: {
    method: "POST",
    path: "/api/internal/callbacks/agent",
    headers: internalCallbackHeadersSchema,
    body: internalCallbackBodySchema,
    responses: {
      200: internalCallbackSuccessSchema,
      400: internalCallbackErrorSchema,
      401: internalCallbackErrorSchema,
      404: internalCallbackErrorSchema,
    },
    summary: "Handle terminal callbacks for agent-triggered runs",
  },
});

export type InternalCallbacksAgentContract =
  typeof internalCallbacksAgentContract;
