import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../src/lib/ts-rest-handler";
import { composesVersionsContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../../src/db/schema/agent-compose";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import { eq, and, like } from "drizzle-orm";

const router = tsr.router(composesVersionsContract, {
  resolveVersion: async ({ query, headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }

    const { composeId, version } = query;

    // Verify compose belongs to user
    const [compose] = await globalThis.services.db
      .select()
      .from(agentComposes)
      .where(
        and(eq(agentComposes.id, composeId), eq(agentComposes.userId, userId)),
      )
      .limit(1);

    if (!compose) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent compose not found", code: "NOT_FOUND" },
        },
      };
    }

    // Handle "latest" tag - return HEAD version
    if (version === "latest") {
      if (!compose.headVersionId) {
        return {
          status: 400 as const,
          body: {
            error: {
              message: "Agent compose has no versions. Run 'vm0 build' first.",
              code: "BAD_REQUEST",
            },
          },
        };
      }

      return {
        status: 200 as const,
        body: {
          versionId: compose.headVersionId,
          tag: "latest",
        },
      };
    }

    // Validate version format (must be hex string, at least 8 chars)
    if (!/^[0-9a-f]{8,64}$/i.test(version)) {
      return {
        status: 400 as const,
        body: {
          error: {
            message:
              "Invalid version format. Must be 8-64 hex characters or 'latest'.",
            code: "BAD_REQUEST",
          },
        },
      };
    }

    // Try exact match first (full 64-char hash)
    // Note: We don't filter by composeId here because version hashes are content-addressable.
    // If compose B's HEAD points to version V (created by compose A with identical content),
    // that's valid - the content is the same. Compose ownership is already verified above.
    if (version.length === 64) {
      const [exactMatch] = await globalThis.services.db
        .select()
        .from(agentComposeVersions)
        .where(eq(agentComposeVersions.id, version))
        .limit(1);

      if (!exactMatch) {
        return {
          status: 404 as const,
          body: {
            error: {
              message: `Version '${version.slice(0, 8)}...' not found`,
              code: "NOT_FOUND",
            },
          },
        };
      }

      return {
        status: 200 as const,
        body: {
          versionId: exactMatch.id,
        },
      };
    }

    // Prefix match for shorter hashes
    // Note: We don't filter by composeId - see comment above for exact match.
    const prefixMatches = await globalThis.services.db
      .select()
      .from(agentComposeVersions)
      .where(like(agentComposeVersions.id, `${version}%`))
      .limit(2); // Get 2 to detect ambiguous matches

    if (prefixMatches.length === 0) {
      return {
        status: 404 as const,
        body: {
          error: {
            message: `Version '${version}' not found`,
            code: "NOT_FOUND",
          },
        },
      };
    }

    if (prefixMatches.length > 1) {
      return {
        status: 400 as const,
        body: {
          error: {
            message: `Ambiguous version prefix '${version}'. Please use more characters.`,
            code: "BAD_REQUEST",
          },
        },
      };
    }

    return {
      status: 200 as const,
      body: {
        versionId: prefixMatches[0]!.id,
      },
    };
  },
});

/**
 * Custom error handler to convert validation errors to API error format
 */
function errorHandler(err: unknown): TsRestResponse | void {
  if (err && typeof err === "object" && "queryError" in err) {
    const validationError = err as {
      queryError: { issues: Array<{ path: string[]; message: string }> } | null;
    };

    if (validationError.queryError) {
      const issue = validationError.queryError.issues[0];
      if (issue) {
        return TsRestResponse.fromJson(
          { error: { message: issue.message, code: "BAD_REQUEST" } },
          { status: 400 },
        );
      }
    }
  }

  return undefined;
}

const handler = createHandler(composesVersionsContract, router, {
  errorHandler,
});

export { handler as GET };
