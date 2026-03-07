import { NextResponse } from "next/server";
import { getConnectorOAuthConfig } from "@vm0/core";
import { env } from "../../../../../src/env";
import { initServices } from "../../../../../src/lib/init-services";
import { getUserIdFromRequest } from "../../../../../src/lib/auth/get-user-id";
import { getOrigin } from "../../../../../src/lib/request/get-origin";
import { resolveScope } from "../../../../../src/lib/scope/resolve-scope";
import { upsertOAuthConnector } from "../../../../../src/lib/connector/connector-service";
import {
  exchangeWixCode,
  decodeWixInstance,
} from "../../../../../src/lib/connector/providers/wix";
import { logger } from "../../../../../src/lib/logger";

const log = logger("api:connectors:wix:link");

/**
 * Wix Connector Link Endpoint
 *
 * GET /api/connectors/wix/link?instance=<JWT>
 *
 * Opened as a popup from the Wix Dashboard extension iFrame (/connector/wix).
 * Requires VM0 authentication (Clerk). Decodes the Wix instance JWT to
 * obtain the instanceId, exchanges it for an access token, and stores
 * the connector. Redirects to /connector/wix/success on completion.
 */
export async function GET(request: Request) {
  initServices();

  const currentEnv = env();
  const origin = getOrigin(request);
  const url = new URL(request.url);

  const userId = await getUserIdFromRequest(request);
  if (!userId) {
    const loginUrl = new URL("/sign-in", origin);
    loginUrl.searchParams.set(
      "redirect_url",
      new URL(url.pathname + url.search, origin).toString(),
    );
    return NextResponse.redirect(loginUrl.toString());
  }

  const instanceJwt = url.searchParams.get("instance");
  if (!instanceJwt) {
    return redirectWithError(origin, "Missing Wix instance parameter");
  }

  let instanceId: string;
  try {
    ({ instanceId } = decodeWixInstance(instanceJwt));
  } catch {
    return redirectWithError(origin, "Invalid Wix instance JWT");
  }

  const clientId = currentEnv.WIX_OAUTH_CLIENT_ID;
  const clientSecret = currentEnv.WIX_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return redirectWithError(origin, "Wix OAuth not configured");
  }

  try {
    const result = await exchangeWixCode(clientId, clientSecret, instanceId);
    const { scope } = await resolveScope(userId);

    await upsertOAuthConnector(
      scope.id,
      userId,
      "wix",
      result.accessToken,
      {
        id: result.userInfo.id,
        username: result.userInfo.username ?? "",
        email: result.userInfo.email,
      },
      getConnectorOAuthConfig("wix")?.scopes ?? [],
      {
        refreshToken: result.refreshToken,
        refreshSecretName: "WIX_REFRESH_TOKEN",
        expiresIn: result.expiresIn,
      },
    );

    log.info("Wix connector linked", {
      userId,
      instanceId,
      username: result.userInfo.username,
    });

    // Redirect to success page that closes the popup
    const successUrl = new URL("/connector/wix/success", origin);
    successUrl.searchParams.set("username", result.userInfo.username ?? "");
    return NextResponse.redirect(successUrl.toString());
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    log.error("Wix link failed", { error: msg, instanceId });
    return redirectWithError(origin, msg);
  }
}

function redirectWithError(origin: string, message: string): NextResponse {
  const errorUrl = new URL("/connector/wix/error", origin);
  errorUrl.searchParams.set("message", message);
  return NextResponse.redirect(errorUrl.toString());
}
