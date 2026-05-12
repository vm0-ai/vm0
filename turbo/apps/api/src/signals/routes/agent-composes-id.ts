import { command } from "ccstate";
import { composesByIdContract } from "@vm0/api-contracts/contracts/composes";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { isConflictResponse, isNotFoundResponse } from "../../lib/error";
import { deleteCompose$ } from "../services/zero-compose-data.service";
import type { RouteEntry } from "../route";

const sandboxDeleteForbidden = {
  status: 403 as const,
  body: {
    error: {
      message: "Agent deletion is not available from sandbox",
      code: "FORBIDDEN",
    },
  },
} as const;

const deleteAgentComposeInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    if (auth.tokenType === "sandbox" || auth.tokenType === "zero") {
      return sandboxDeleteForbidden;
    }

    const params = get(pathParamsOf(composesByIdContract.delete));
    const result = await set(
      deleteCompose$,
      { composeId: params.id, userId: auth.userId },
      signal,
    );
    signal.throwIfAborted();

    if (isNotFoundResponse(result)) {
      return result;
    }
    if (isConflictResponse(result)) {
      return result;
    }
    return { status: 204 as const, body: undefined };
  },
);

export const agentComposesByIdRoutes: readonly RouteEntry[] = [
  {
    route: composesByIdContract.delete,
    handler: authRoute(
      { acceptAnySandboxCapability: true },
      deleteAgentComposeInner$,
    ),
  },
];
