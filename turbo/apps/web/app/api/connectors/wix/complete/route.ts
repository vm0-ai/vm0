import { NextResponse } from "next/server";
import { getConnectorOAuthConfig } from "@vm0/core";
import { env } from "../../../../../src/env";
import { initServices } from "../../../../../src/lib/init-services";
import { getUserIdFromRequest } from "../../../../../src/lib/auth/get-user-id";
import { getOrigin } from "../../../../../src/lib/request/get-origin";
import { resolveScope } from "../../../../../src/lib/scope/resolve-scope";
import { upsertOAuthConnector } from "../../../../../src/lib/connector/connector-service";
import { exchangeWixCode } from "../../../../../src/lib/connector/providers/wix";
import { logger } from "../../../../../src/lib/logger";

const log = logger("api:connectors:wix:complete");

/**
 * Wix Connection Completion Endpoint
 *
 * GET /api/connectors/wix/complete?instanceId=XXX
 *
 * Receives the Wix instanceId, exchanges it for an access token via
 * client_credentials, stores the connector, and redirects to the
 * success page.
 *
 * This endpoint requires authentication (Clerk session cookies).
 * It is called either:
 * - From the setup page form submission (via navigation)
 * - From the Wix Dashboard iFrame "Complete Connection" link
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

  const instanceId = url.searchParams.get("instanceId");
  if (!instanceId) {
    return redirectWithError(origin, "Missing Instance ID");
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

    log.info("Wix connector created via complete endpoint", {
      userId,
      instanceId,
      username: result.userInfo.username,
    });

    const successUrl = new URL("/connector/success", origin);
    successUrl.searchParams.set("type", "wix");
    successUrl.searchParams.set("username", result.userInfo.username ?? "");
    return NextResponse.redirect(successUrl.toString());
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    log.error("Wix complete failed", { error: msg, instanceId });
    return redirectWithError(origin, msg);
  }
}

function redirectWithError(origin: string, message: string): NextResponse {
  const errorUrl = new URL("/connector/error", origin);
  errorUrl.searchParams.set("type", "wix");
  errorUrl.searchParams.set("message", message);
  return NextResponse.redirect(errorUrl.toString());
}
