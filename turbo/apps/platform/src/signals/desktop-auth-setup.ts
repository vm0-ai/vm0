import {
  desktopAuthCallbackSchemeSchema,
  desktopAuthConsumeContract,
  desktopAuthHandoffContract,
  type DesktopAuthCallbackScheme,
} from "@vm0/api-contracts/contracts/desktop-auth";
import { command } from "ccstate";

import { accept } from "../lib/accept.ts";
import { clerk$, resolveWebOrigin } from "./auth.ts";
import { zeroClient$ } from "./api-client.ts";
import { logger } from "./log.ts";
import { detachedNavigateTo$, searchParams$ } from "./route.ts";

const L = logger("DesktopAuth");

const DESKTOP_AUTH_START_PATH = "/desktop-auth/start";
const DESKTOP_AUTH_CALLBACK_PATH = "/desktop-auth/callback";
const DESKTOP_AUTH_CALLBACK_SCHEME_PARAM = "callbackScheme";

function platformUrl(path: string): string {
  return new URL(path, window.location.origin).toString();
}

function desktopAuthCallbackScheme(
  searchParams: URLSearchParams,
): DesktopAuthCallbackScheme | undefined {
  const rawScheme = searchParams.get(DESKTOP_AUTH_CALLBACK_SCHEME_PARAM);
  const parsedScheme = desktopAuthCallbackSchemeSchema.safeParse(rawScheme);
  if (parsedScheme.success) {
    return parsedScheme.data;
  }
  return undefined;
}

function desktopAuthPathWithScheme(
  path: string,
  searchParams: URLSearchParams,
): string {
  const callbackScheme = desktopAuthCallbackScheme(searchParams);
  if (!callbackScheme) {
    return path;
  }

  const url = new URL(path, window.location.origin);
  url.searchParams.set(DESKTOP_AUTH_CALLBACK_SCHEME_PARAM, callbackScheme);
  return `${url.pathname}${url.search}`;
}

function webSignInUrl(callbackPath: string): string {
  const url = new URL("/sign-in", resolveWebOrigin());
  url.searchParams.set("redirect_url", platformUrl(callbackPath));
  return url.toString();
}

export const setupDesktopAuthStartPage$ = command(
  async ({ get }, signal: AbortSignal) => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();

    const callbackPath = desktopAuthPathWithScheme(
      DESKTOP_AUTH_CALLBACK_PATH,
      get(searchParams$),
    );
    if (clerk.user) {
      window.location.replace(callbackPath);
      return;
    }

    window.location.assign(webSignInUrl(callbackPath));
  },
);

export const setupDesktopAuthCallbackPage$ = command(
  async ({ get }, signal: AbortSignal) => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();

    if (!clerk.user) {
      window.location.replace(
        desktopAuthPathWithScheme(DESKTOP_AUTH_START_PATH, get(searchParams$)),
      );
      return;
    }

    const client = get(zeroClient$)(desktopAuthHandoffContract);
    const callbackScheme = desktopAuthCallbackScheme(get(searchParams$));
    const result = await accept(
      client.create({
        body: callbackScheme ? { callbackScheme } : {},
      }),
      [200],
    );
    signal.throwIfAborted();

    window.location.assign(result.body.callbackUrl);
  },
);

export const setupDesktopAuthConsumePage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const code = get(searchParams$).get("code");
    if (!code) {
      L.error("Missing code parameter");
      set(detachedNavigateTo$, "/", { replace: true });
      return;
    }

    const client = get(zeroClient$)(desktopAuthConsumeContract);
    const result = await accept(client.consume({ body: { code } }), [200]);
    signal.throwIfAborted();

    const clerk = await get(clerk$);
    signal.throwIfAborted();

    if (!clerk.client) {
      L.error("Clerk client not available");
      set(detachedNavigateTo$, "/", { replace: true });
      return;
    }

    const signIn = await clerk.client.signIn.create({
      strategy: "ticket",
      ticket: result.body.token,
    });
    signal.throwIfAborted();

    if (signIn.status !== "complete" || !signIn.createdSessionId) {
      L.error("Unexpected sign-in status:", signIn.status);
      set(detachedNavigateTo$, "/", { replace: true });
      return;
    }

    await clerk.setActive({ session: signIn.createdSessionId });
    signal.throwIfAborted();

    window.location.replace("/");
  },
);
