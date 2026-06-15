import { command } from "ccstate";
import { composesMainContract } from "@vm0/api-contracts/contracts/composes";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { badRequestMessage } from "../../lib/error";
import type { RouteEntry } from "../route";
import { createAgentCompose$ } from "../services/agent-composes-create.service";

const createComposeBody$ = bodyResultOf(composesMainContract.create);

const createComposeInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const bodyResult = await get(createComposeBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    if (!auth.orgId) {
      return badRequestMessage(
        "Explicit org context required — ensure active org in session",
      );
    }

    return await set(
      createAgentCompose$,
      {
        userId: auth.userId,
        orgId: auth.orgId,
        content: bodyResult.data.content,
      },
      signal,
    );
  },
);

export const agentComposesRoutes: readonly RouteEntry[] = [
  {
    route: composesMainContract.create,
    handler: authRoute(
      { acceptAnySandboxCapability: true },
      createComposeInner$,
    ),
  },
];
