import { command, computed, type Command } from "ccstate";
import {
  anonymousPrivacyTokenSchema,
  privacyChoicesContract,
  type PrivacyChoiceState,
} from "@okouai/api-contracts/contracts/privacy-choices";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import {
  badRequestMessage,
  conflict,
  notFound,
  notConfigured,
} from "../../lib/error";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { authorization$, request$, setResHeader$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  anonymousPrivacyChoice$,
  associatePrivacyChoice$,
  createAnonymousPrivacyChoice$,
  userPrivacyChoice$,
} from "../services/privacy-choices.service";

function responseFor(
  result:
    | { readonly ok: true; readonly state: PrivacyChoiceState }
    | {
        readonly ok: false;
        readonly reason: "missing" | "stale" | "linked" | "session";
      },
) {
  if (result.ok) {
    return { status: 200 as const, body: result.state };
  }
  switch (result.reason) {
    case "session": {
      return {
        status: 403 as const,
        body: {
          error: {
            code: "FORBIDDEN",
            message:
              "Sign in to grant personal marketing consent. Anonymous withdrawal remains available.",
          },
        },
      };
    }
    case "missing": {
      return notFound("Privacy receipt is unavailable");
    }
    case "stale": {
      return conflict(
        "Privacy choice changed. Read the latest choice; do not retry an old grant automatically.",
      );
    }
    case "linked": {
      return conflict(
        "Privacy receipt is already associated. Create a new browser receipt for this account.",
      );
    }
  }
}

function privacyRoute<T>(handler: Command<Promise<T>, [AbortSignal]>) {
  return command(async ({ set }, signal: AbortSignal) => {
    set(setResHeader$, "Cache-Control", "no-store");
    if (!isFeatureEnabled(FeatureSwitchKey.PrivacyChoices, {})) {
      return notConfigured("Privacy choices are unavailable");
    }
    return await set(handler, signal);
  });
}

const anonymousToken$ = computed((get) => {
  const header = get(authorization$);
  return anonymousPrivacyTokenSchema.safeParse(
    header?.startsWith("Bearer ") ? header.slice(7) : undefined,
  );
});

const missingToken = Object.freeze({
  status: 401 as const,
  body: {
    error: { code: "UNAUTHORIZED", message: "A privacy receipt is required" },
  },
});

const createAnonymous$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(bodyResultOf(privacyChoicesContract.createAnonymous));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  if (
    body.data.choice?.source === "explicit" &&
    body.data.choice.expectedRevision !== null
  ) {
    return badRequestMessage(
      "A new privacy receipt must use a null expectedRevision",
    );
  }
  const created = await set(
    createAnonymousPrivacyChoice$,
    {
      choice: body.data.choice,
      gpc: get(request$).header("Sec-GPC") === "1",
    },
    signal,
  );
  if (!created.result.ok) {
    return responseFor(created.result);
  }
  return {
    status: 200 as const,
    body: { token: created.token, state: created.result.state },
  };
});

const getAnonymous$ = command(async ({ get, set }, signal: AbortSignal) => {
  const token = get(anonymousToken$);
  if (!token.success) {
    return missingToken;
  }
  return responseFor(
    await set(
      anonymousPrivacyChoice$,
      { token: token.data, gpc: get(request$).header("Sec-GPC") === "1" },
      signal,
    ),
  );
});

const updateAnonymous$ = command(async ({ get, set }, signal: AbortSignal) => {
  const token = get(anonymousToken$);
  if (!token.success) {
    return missingToken;
  }
  const body = await get(bodyResultOf(privacyChoicesContract.updateAnonymous));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  return responseFor(
    await set(
      anonymousPrivacyChoice$,
      {
        token: token.data,
        update: body.data,
        gpc: get(request$).header("Sec-GPC") === "1",
      },
      signal,
    ),
  );
});

const getUser$ = command(async ({ get, set }, signal: AbortSignal) => {
  return responseFor(
    await set(
      userPrivacyChoice$,
      {
        userId: get(authContext$).userId,
        gpc: get(request$).header("Sec-GPC") === "1",
      },
      signal,
    ),
  );
});

const updateUser$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(bodyResultOf(privacyChoicesContract.update));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  return responseFor(
    await set(
      userPrivacyChoice$,
      {
        userId: get(authContext$).userId,
        update: body.data,
        gpc: get(request$).header("Sec-GPC") === "1",
      },
      signal,
    ),
  );
});

const associate$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(bodyResultOf(privacyChoicesContract.associate));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  return responseFor(
    await set(
      associatePrivacyChoice$,
      {
        userId: get(authContext$).userId,
        token: body.data.anonymousToken,
        gpc: get(request$).header("Sec-GPC") === "1",
      },
      signal,
    ),
  );
});

const sessionOnly = { accept: ["session"] } as const;
export const privacyChoicesRoutes: readonly RouteEntry[] = [
  {
    route: privacyChoicesContract.createAnonymous,
    handler: privacyRoute(createAnonymous$),
  },
  {
    route: privacyChoicesContract.getAnonymous,
    handler: privacyRoute(getAnonymous$),
  },
  {
    route: privacyChoicesContract.updateAnonymous,
    handler: privacyRoute(updateAnonymous$),
  },
  {
    route: privacyChoicesContract.get,
    handler: privacyRoute(authRoute(sessionOnly, getUser$)),
  },
  {
    route: privacyChoicesContract.update,
    handler: privacyRoute(authRoute(sessionOnly, updateUser$)),
  },
  {
    route: privacyChoicesContract.associate,
    handler: privacyRoute(authRoute(sessionOnly, associate$)),
  },
];
