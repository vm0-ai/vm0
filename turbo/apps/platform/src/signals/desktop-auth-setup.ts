import {
  desktopAuthConsumeContract,
  desktopAuthHandoffContract,
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

function platformUrl(path: string): string {
  return new URL(path, window.location.origin).toString();
}

function webSignInUrl(): string {
  const url = new URL("/sign-in", resolveWebOrigin());
  url.searchParams.set("redirect_url", platformUrl(DESKTOP_AUTH_CALLBACK_PATH));
  return url.toString();
}

export const setupDesktopAuthStartPage$ = command(
  async ({ get }, signal: AbortSignal) => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();

    if (clerk.user) {
      window.location.replace(DESKTOP_AUTH_CALLBACK_PATH);
      return;
    }

    window.location.assign(webSignInUrl());
  },
);

export const setupDesktopAuthCallbackPage$ = command(
  async ({ get }, signal: AbortSignal) => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();

    if (!clerk.user) {
      window.location.replace(DESKTOP_AUTH_START_PATH);
      return;
    }

    const client = get(zeroClient$)(desktopAuthHandoffContract);
    const result = await accept(client.create({ body: {} }), [200]);
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

    set(detachedNavigateTo$, "/", { replace: true });
  },
);
