import { NextResponse } from "next/server";
import { connectorTypeSchema } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { getUserIdFromRequest } from "../../../../../src/lib/auth/get-user-id";
import { getPlatform } from "../../../../../src/lib/connector/platform/router";
import { getUserScopeByClerkId } from "../../../../../src/lib/scope/scope-service";
import { getNangoIntegrationId } from "../../../../../src/lib/connector/platform/nango";

/**
 * Connector Create Session Endpoint
 *
 * POST /api/connectors/:type/create-session
 *
 * Creates a Nango Connect Session and returns the session token
 * for frontend SDK usage.
 */

export async function POST(
  request: Request,
  { params }: { params: Promise<{ type: string }> },
) {
  initServices();

  const { type } = await params;

  // Validate connector type
  const typeResult = connectorTypeSchema.safeParse(type);
  if (!typeResult.success) {
    return NextResponse.json(
      { error: `Unknown connector type: ${type}` },
      { status: 400 },
    );
  }
  const connectorType = typeResult.data;

  // Verify user is authenticated
  const userId = await getUserIdFromRequest(request);
  if (!userId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Computer connector does not use OAuth
  if (connectorType === "computer") {
    return NextResponse.json(
      { error: "Computer connector does not use OAuth" },
      { status: 400 },
    );
  }

  // Get user scope for building connection ID
  const scope = await getUserScopeByClerkId(userId);
  if (!scope) {
    return NextResponse.json(
      { error: "User scope not found" },
      { status: 500 },
    );
  }

  // Check if this is a Nango connector
  const platform = getPlatform(connectorType);
  if (platform.name !== "nango") {
    return NextResponse.json(
      { error: "This connector does not support Connect Session" },
      { status: 400 },
    );
  }

  try {
    // Generate state for CSRF protection
    const state = generateState();

    // Build connection ID for platform abstraction
    const connectionId = `${scope.id}:${connectorType}`;

    const nango = globalThis.services.nango;

    // Create connect session
    const session = await nango.createConnectSession({
      end_user: {
        id: scope.id,
      },
      allowed_integrations: [getNangoIntegrationId(connectorType)],
      // Store state in tags for verification
      tags: {
        oauth_state: state,
        connection_id: connectionId,
      },
    });

    return NextResponse.json({
      sessionToken: session.data.token,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to create session: ${errorMessage}` },
      { status: 500 },
    );
  }
}

/**
 * Generate a random state string for CSRF protection
 */
function generateState(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}
