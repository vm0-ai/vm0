import { NextResponse } from "next/server";
import { z } from "zod";
import { isTestEndpointAllowed } from "../../../../../src/lib/auth/test-endpoint-guard";
import { TEST_OAUTH_CLIENT_ID } from "@vm0/connectors/oauth-providers/providers/test-oauth";
import {
  mintAuthCode,
  TEST_OAUTH_SCENARIOS,
  type TestOAuthScenario,
} from "../_lib/token-helpers";

const scenarioSchema = z.enum(TEST_OAUTH_SCENARIOS);

/**
 * GET /api/test/oauth-provider/authorize
 *
 * Fake OAuth 2.0 authorize endpoint. Validates client_id against the
 * configured TEST_OAUTH_CLIENT_ID, mints a code that carries the scenario
 * statelessly, and 302s back to redirect_uri with ?code=...&state=....
 *
 * The scenario is encoded into the code itself — the token endpoint decodes
 * it — because on Vercel there's no shared in-memory state across instances.
 */
export async function GET(request: Request): Promise<Response> {
  if (!isTestEndpointAllowed(request)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const url = new URL(request.url);
  const clientId = url.searchParams.get("client_id");
  const redirectUri = url.searchParams.get("redirect_uri");
  const state = url.searchParams.get("state");
  const rawScenario = url.searchParams.get("scenario");

  if (!clientId || !redirectUri || !state) {
    return NextResponse.json(
      { error: "client_id, redirect_uri, and state are required" },
      { status: 400 },
    );
  }

  if (clientId !== TEST_OAUTH_CLIENT_ID) {
    return NextResponse.json({ error: "invalid_client" }, { status: 400 });
  }

  let scenario: TestOAuthScenario = "success";
  if (rawScenario) {
    const parsed = scenarioSchema.safeParse(rawScenario);
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_scenario" }, { status: 400 });
    }
    scenario = parsed.data;
  }

  const code = mintAuthCode(scenario);

  const destination = new URL(redirectUri);
  destination.searchParams.set("code", code);
  destination.searchParams.set("state", state);

  return NextResponse.redirect(destination, 302);
}
