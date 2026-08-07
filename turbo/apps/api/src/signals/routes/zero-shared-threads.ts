import { sharedThreadsContract } from "@vm0/api-contracts/contracts/shared-threads";
import { command } from "ccstate";

import { notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import {
  createSharedThread$,
  readSharedThread$,
  readSharedThreadMeta$,
} from "../services/shared-thread.service";
import type { RouteEntry } from "../route-entry";

const createBody$ = bodyResultOf(sharedThreadsContract.create);

const noShareableMessages = Object.freeze({
  status: 400 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "The selection contains no shareable messages",
      code: "NO_SHAREABLE_MESSAGES" as const,
    }),
  }),
});

const sharedThreadTooLarge = Object.freeze({
  status: 413 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "The selected messages are too large to share",
      code: "SHARED_THREAD_TOO_LARGE" as const,
    }),
  }),
});

const createSharedThreadInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const body = await get(createBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const params = get(pathParamsOf(sharedThreadsContract.create));
    const result = await set(
      createSharedThread$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        threadId: params.threadId,
        eventIds: body.data.eventIds,
      },
      signal,
    );
    signal.throwIfAborted();
    if (result.kind === "thread-not-found") {
      return notFound("Chat thread not found");
    }
    if (result.kind === "no-shareable-messages") {
      return noShareableMessages;
    }
    if (result.kind === "too-large") {
      return sharedThreadTooLarge;
    }
    return { status: 201 as const, body: { id: result.id } };
  },
);

const getSharedThread$ = command(async ({ get, set }, signal: AbortSignal) => {
  const params = get(pathParamsOf(sharedThreadsContract.get));
  const row = await set(readSharedThread$, params.id, signal);
  signal.throwIfAborted();
  set(setResHeader$, "Cache-Control", "no-store");
  if (!row) {
    return notFound("Shared conversation not found");
  }
  return { status: 200 as const, body: row };
});

const getSharedThreadMeta$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = get(pathParamsOf(sharedThreadsContract.meta));
    const row = await set(readSharedThreadMeta$, params.id, signal);
    signal.throwIfAborted();
    if (!row) {
      set(setResHeader$, "Cache-Control", "public, max-age=60, s-maxage=60");
      return notFound("Shared conversation not found");
    }
    set(
      setResHeader$,
      "Cache-Control",
      "public, max-age=31536000, s-maxage=31536000, immutable",
    );
    return { status: 200 as const, body: row };
  },
);

export const zeroSharedThreadRoutes: readonly RouteEntry[] = [
  {
    route: sharedThreadsContract.create,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-event:read",
      },
      createSharedThreadInner$,
    ),
  },
  {
    route: sharedThreadsContract.get,
    handler: getSharedThread$,
  },
  {
    route: sharedThreadsContract.meta,
    handler: getSharedThreadMeta$,
  },
];
