/**
 * App API - Team Endpoint
 *
 * GET /api/app/team - List all agents in the user's active Clerk org.
 * Unlike /api/agent/composes/list, this endpoint strictly uses the Clerk
 * session orgId and does not fall through to heuristic org resolution.
 */
import { NextResponse } from "next/server";
import { eq, desc } from "drizzle-orm";
import { initServices } from "../../../../src/lib/init-services";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../src/db/schema/agent-compose";
import { getAuthContext } from "../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../src/lib/org/resolve-org";
import { isNotFound, isForbidden } from "../../../../src/lib/errors";

function extractMetadata(content: unknown): {
  displayName: string | null;
  description: string | null;
} {
  const empty = { displayName: null, description: null };
  if (
    content === null ||
    content === undefined ||
    typeof content !== "object"
  ) {
    return empty;
  }
  const record = content as Record<string, unknown>;
  const agents = record["agents"];
  if (agents === null || agents === undefined || typeof agents !== "object") {
    return empty;
  }
  const agentKeys = Object.keys(agents);
  if (agentKeys.length === 0) return empty;
  const agentsRecord = agents as Record<string, unknown>;
  const firstAgent = agentsRecord[agentKeys[0]!];
  if (
    firstAgent === null ||
    firstAgent === undefined ||
    typeof firstAgent !== "object"
  ) {
    return empty;
  }
  const agentRecord = firstAgent as Record<string, unknown>;
  const metadata = agentRecord["metadata"];
  if (
    metadata === null ||
    metadata === undefined ||
    typeof metadata !== "object"
  ) {
    return empty;
  }
  const metadataRecord = metadata as Record<string, unknown>;
  const displayName =
    typeof metadataRecord["displayName"] === "string"
      ? metadataRecord["displayName"]
      : null;
  const description =
    typeof metadataRecord["description"] === "string"
      ? metadataRecord["description"]
      : null;
  return { displayName, description };
}

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
      name: agentComposes.name,
      headVersionId: agentComposes.headVersionId,
      updatedAt: agentComposes.updatedAt,
      headContent: agentComposeVersions.content,
    })
    .from(agentComposes)
    .leftJoin(
      agentComposeVersions,
      eq(agentComposes.headVersionId, agentComposeVersions.id),
    )
    .where(eq(agentComposes.orgId, resolvedOrgId))
    .orderBy(desc(agentComposes.updatedAt));

  return NextResponse.json({
    composes: composes.map((c) => {
      const meta = extractMetadata(c.headContent);
      return {
        id: c.id,
        name: c.name,
        displayName: meta.displayName,
        description: meta.description,
        headVersionId: c.headVersionId,
        updatedAt: c.updatedAt.toISOString(),
        isOwner: true,
      };
    }),
  });
}
