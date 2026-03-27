/**
 * Zero API - Team Endpoint
 *
 * GET /api/zero/team - List all agents in the user's active Clerk org.
 * Unlike /api/agent/composes/list, this endpoint strictly uses the Clerk
 * session orgId and does not fall through to heuristic org resolution.
 */
import { NextResponse } from "next/server";
import { eq, desc } from "drizzle-orm";
import { initServices } from "../../../../src/lib/init-services";
import { agentComposes } from "../../../../src/db/schema/agent-compose";
import { zeroAgents } from "../../../../src/db/schema/zero-agent";
import { getAuthContext } from "../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../src/lib/org/resolve-org";
import { isNotFound, isForbidden } from "../../../../src/lib/errors";

export async function GET() {
  initServices();

  const authCtx = await getAuthContext();

  if (!authCtx) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  if (!authCtx.orgId) {
    return NextResponse.json(
      {
        error: {
          message: "No active organization. Please select an org.",
          code: "FORBIDDEN",
        },
      },
      { status: 403 },
    );
  }

  // Resolve org via standard path (verifies membership + applies JWT tier)
  let resolvedOrgId: string;
  try {
    const { org } = await resolveOrg(authCtx);
    resolvedOrgId = org.orgId;
  } catch (error) {
    if (isNotFound(error) || isForbidden(error)) {
      return NextResponse.json(
        { error: { message: "Organization not found", code: "NOT_FOUND" } },
        { status: 404 },
      );
    }
    throw error;
  }

  const composes = await globalThis.services.db
    .select({
      id: agentComposes.id,
      headVersionId: agentComposes.headVersionId,
      updatedAt: agentComposes.updatedAt,
      displayName: zeroAgents.displayName,
      description: zeroAgents.description,
      sound: zeroAgents.sound,
      avatarUrl: zeroAgents.avatarUrl,
    })
    .from(agentComposes)
    .leftJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
    .where(eq(agentComposes.orgId, resolvedOrgId))
    .orderBy(desc(agentComposes.updatedAt));

  return NextResponse.json(
    composes.map((c) => ({
      id: c.id,
      displayName: c.displayName ?? null,
      description: c.description ?? null,
      sound: c.sound ?? null,
      avatarUrl: c.avatarUrl ?? null,
      headVersionId: c.headVersionId,
      updatedAt: c.updatedAt.toISOString(),
    })),
  );
}
