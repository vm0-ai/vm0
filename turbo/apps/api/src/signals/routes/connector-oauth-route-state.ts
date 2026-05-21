import { env } from "../../lib/env";

export const CONNECTOR_OAUTH_STATE_COOKIE_NAME = "connector_oauth_state";
export const CONNECTOR_OAUTH_SESSION_COOKIE_NAME = "connector_oauth_session";
export const CONNECTOR_OAUTH_PKCE_COOKIE_NAME = "connector_oauth_pkce";
export const CONNECTOR_OAUTH_CONTEXT_COOKIE_NAME = "connector_oauth_context";
export const CONNECTOR_OAUTH_COOKIE_MAX_AGE_SECONDS = 15 * 60;

const CONNECTOR_OAUTH_REDIRECT_STATUS = 307;

export function generateConnectorOAuthState(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => {
    return byte.toString(16).padStart(2, "0");
  }).join("");
}

export function buildConnectorOAuthCookieHeader(
  name: string,
  value: string,
  maxAge: number,
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${maxAge}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (env("ENV") === "production") {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function buildDeleteConnectorOAuthCookieHeader(name: string): string {
  return `${name}=; Max-Age=0; Path=/`;
}

export function connectorOAuthRedirectResponse(url: string): Response {
  return new Response(null, {
    status: CONNECTOR_OAUTH_REDIRECT_STATUS,
    headers: { location: url },
  });
}

export function clearConnectorOAuthCookies(response: Response): void {
  response.headers.append(
    "Set-Cookie",
    buildDeleteConnectorOAuthCookieHeader(CONNECTOR_OAUTH_STATE_COOKIE_NAME),
  );
  response.headers.append(
    "Set-Cookie",
    buildDeleteConnectorOAuthCookieHeader(CONNECTOR_OAUTH_SESSION_COOKIE_NAME),
  );
  response.headers.append(
    "Set-Cookie",
    buildDeleteConnectorOAuthCookieHeader(CONNECTOR_OAUTH_PKCE_COOKIE_NAME),
  );
  response.headers.append(
    "Set-Cookie",
    buildDeleteConnectorOAuthCookieHeader(CONNECTOR_OAUTH_CONTEXT_COOKIE_NAME),
  );
}
