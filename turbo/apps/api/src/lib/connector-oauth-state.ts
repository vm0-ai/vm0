import { nowDate } from "./time";

const CONNECTOR_OAUTH_STATE_COOKIE_NAME = "connector_oauth_state";
const CONNECTOR_OAUTH_PKCE_COOKIE_NAME = "connector_oauth_pkce";
const CONNECTOR_OAUTH_CONTEXT_COOKIE_NAME = "connector_oauth_context";
const CONNECTOR_OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

const CONNECTOR_OAUTH_REDIRECT_STATUS = 307;

export function generateConnectorOAuthState(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => {
    return byte.toString(16).padStart(2, "0");
  }).join("");
}

export function connectorOAuthStateExpiresAt(): Date {
  return new Date(nowDate().getTime() + CONNECTOR_OAUTH_STATE_TTL_MS);
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
    buildDeleteConnectorOAuthCookieHeader(CONNECTOR_OAUTH_PKCE_COOKIE_NAME),
  );
  response.headers.append(
    "Set-Cookie",
    buildDeleteConnectorOAuthCookieHeader(CONNECTOR_OAUTH_CONTEXT_COOKIE_NAME),
  );
}
