/**
 * Cookie helpers for the ChatGPT OAuth connect/callback routes.
 *
 * Mirrors the helpers in `app/api/connectors/[type]/{authorize,callback}/route.ts`.
 * If you change one, consider updating the other.
 *
 * Cookie names are namespaced (`chatgpt_oauth_*`) so a user mid-connector-OAuth
 * doesn't collide with a user mid-chatgpt-OAuth.
 */
import { env } from "../../../../../src/env";

export const STATE_COOKIE_NAME = "chatgpt_oauth_state";
export const PKCE_COOKIE_NAME = "chatgpt_oauth_pkce";
export const COOKIE_MAX_AGE = 15 * 60;

export function buildCookieHeader(
  name: string,
  value: string,
  maxAge: number,
): string {
  const parts = [
    `${name}=${value}`,
    `Max-Age=${maxAge}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (env().NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

export function buildDeleteCookieHeader(name: string): string {
  return `${name}=; Max-Age=0; Path=/`;
}

export function getCookie(request: Request, name: string): string | undefined {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return undefined;
  for (const cookie of cookieHeader.split(";")) {
    const trimmed = cookie.trim();
    const [cookieName, ...rest] = trimmed.split("=");
    if (cookieName === name) return rest.join("=");
  }
  return undefined;
}
