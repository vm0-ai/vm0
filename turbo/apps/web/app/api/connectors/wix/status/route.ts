import { NextResponse } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import { getUserIdFromRequest } from "../../../../../src/lib/auth/get-user-id";
import { resolveScope } from "../../../../../src/lib/scope/resolve-scope";
import { listConnectors } from "../../../../../src/lib/connector/connector-service";

/**
 * Wix Connector Status Endpoint
 *
 * GET /api/connectors/wix/status
 *
 * Called by the Wix Dashboard extension iFrame after the connection popup
 * closes, to verify whether the Wix connector was successfully created.
 */
export async function GET(request: Request) {
  initServices();

  const userId = await getUserIdFromRequest(request);
  if (!userId) {
    return NextResponse.json({ connected: false });
  }

  const { scope } = await resolveScope(userId);
  const connectors = await listConnectors(scope.id, userId);
  const connected = connectors.some((c) => c.type === "wix");

  return NextResponse.json({ connected });
}
