import { NextRequest } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../../src/db/schema/agent-compose";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import {
  successResponse,
  errorResponse,
} from "../../../../../src/lib/api-response";
import {
  BadRequestError,
  NotFoundError,
  UnauthorizedError,
} from "../../../../../src/lib/errors";
import { eq, and, like } from "drizzle-orm";

/**
 * GET /api/agent/composes/versions?composeId={id}&version={hashOrTag}
 * Resolve a version specifier to a full version ID
 *
 * Supports:
 * - "latest": returns HEAD version
 * - Full hash (64 chars): exact match
 * - Hash prefix (8+ chars): prefix match
 */
export async function GET(request: NextRequest) {
  try {
    // Initialize services at serverless function entry
    initServices();

    // Authenticate
    const userId = await getUserId();
    if (!userId) {
      throw new UnauthorizedError("Not authenticated");
    }

    // Get parameters from query
    const { searchParams } = new URL(request.url);
    const composeId = searchParams.get("composeId");
    const version = searchParams.get("version");

    if (!composeId) {
      throw new BadRequestError("Missing composeId query parameter");
    }

    if (!version) {
      throw new BadRequestError("Missing version query parameter");
    }

    // Verify compose belongs to user
    const [compose] = await globalThis.services.db
      .select()
      .from(agentComposes)
      .where(
        and(eq(agentComposes.id, composeId), eq(agentComposes.userId, userId)),
      )
      .limit(1);

    if (!compose) {
      throw new NotFoundError("Agent compose");
    }

    // Handle "latest" tag - return HEAD version
    if (version === "latest") {
      if (!compose.headVersionId) {
        throw new BadRequestError(
          "Agent compose has no versions. Run 'vm0 build' first.",
        );
      }

      return successResponse({
        versionId: compose.headVersionId,
        tag: "latest",
      });
    }

    // Validate version format (must be hex string, at least 8 chars)
    if (!/^[0-9a-f]{8,64}$/i.test(version)) {
      throw new BadRequestError(
        "Invalid version format. Must be 8-64 hex characters or 'latest'.",
      );
    }

    // Try exact match first (full 64-char hash)
    if (version.length === 64) {
      const [exactMatch] = await globalThis.services.db
        .select()
        .from(agentComposeVersions)
        .where(
          and(
            eq(agentComposeVersions.id, version),
            eq(agentComposeVersions.composeId, composeId),
          ),
        )
        .limit(1);

      if (!exactMatch) {
        throw new NotFoundError(`Version '${version.slice(0, 8)}...'`);
      }

      return successResponse({
        versionId: exactMatch.id,
      });
    }

    // Prefix match for shorter hashes
    const prefixMatches = await globalThis.services.db
      .select()
      .from(agentComposeVersions)
      .where(
        and(
          like(agentComposeVersions.id, `${version}%`),
          eq(agentComposeVersions.composeId, composeId),
        ),
      )
      .limit(2); // Get 2 to detect ambiguous matches

    if (prefixMatches.length === 0) {
      throw new NotFoundError(`Version '${version}'`);
    }

    if (prefixMatches.length > 1) {
      throw new BadRequestError(
        `Ambiguous version prefix '${version}'. Please use more characters.`,
      );
    }

    // Safe to access [0] since we checked length === 0 and length > 1 above
    return successResponse({
      versionId: prefixMatches[0]!.id,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
