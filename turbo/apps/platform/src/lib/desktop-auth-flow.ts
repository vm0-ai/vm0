import { z } from "zod";
import {
  resolveClerkProductionTopology,
  VM0_CLERK_PRIMARY_APP_ORIGIN,
} from "./clerk-production-topology.ts";

const PRODUCTION_APP_ORIGINS = [
  VM0_CLERK_PRIMARY_APP_ORIGIN,
  resolveClerkProductionTopology("app.okou.ai").primaryAppOrigin,
] as const;

const DESKTOP_AUTH_PATHS = [
  "/desktop-auth/start",
  "/desktop-auth/callback",
  "/desktop-auth/consume",
  "/desktop-auth/token",
  "/desktop-auth/select-org",
] as const;

const redirectUrlSchema = z.url();

/** Protocol pages and their Auth v2 continuations own navigation and secrets. */
export function isDesktopAuthFlow(url = new URL(location.href)): boolean {
  if (
    DESKTOP_AUTH_PATHS.some((path) => {
      return path === url.pathname;
    })
  ) {
    return true;
  }
  if (!/^\/sign-(in|up)(\/|$)/u.test(url.pathname)) {
    return false;
  }
  const hashQuery = url.hash.indexOf("?");
  const redirect =
    url.searchParams.get("redirect_url") ??
    new URLSearchParams(url.hash.slice(hashQuery + 1)).get("redirect_url");
  const parsed = redirectUrlSchema.safeParse(redirect);
  if (!parsed.success) {
    return false;
  }
  const destination = new URL(parsed.data);
  return (
    (destination.origin === url.origin ||
      (PRODUCTION_APP_ORIGINS.some((origin) => {
        return origin === url.origin;
      }) &&
        PRODUCTION_APP_ORIGINS.some((origin) => {
          return origin === destination.origin;
        }))) &&
    DESKTOP_AUTH_PATHS.some((path) => {
      return path === destination.pathname;
    })
  );
}
