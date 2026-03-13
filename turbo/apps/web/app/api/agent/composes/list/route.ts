import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { composesListContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../../src/db/schema/agent-compose";
import { getAuthContext } from "../../../../../src/lib/auth/get-user-id";
import { getUserEmail } from "../../../../../src/lib/auth/get-user-email";
import { eq, desc } from "drizzle-orm";
import { resolveOrg } from "../../../../../src/lib/scope/resolve-org";
import { isNotFound, isForbidden } from "../../../../../src/lib/errors";
import { getEmailSharedAgents } from "../../../../../src/lib/agent/permission-service";

function extractDisplayName(content: unknown): string | null {
  if (
    content === null ||
    content === undefined ||
    typeof content !== "object"
  ) {
    return null;
  }
  const record = content as Record<string, unknown>;
  const agents = record["agents"];
  if (agents === null || agents === undefined || typeof agents !== "object") {
    return null;
  }
  const agentKeys = Object.keys(agents);
  if (agentKeys.length === 0) return null;
  const agentsRecord = agents as Record<string, unknown>;
  const firstAgent = agentsRecord[agentKeys[0]!];
  if (
    firstAgent === null ||
    firstAgent === undefined ||
    typeof firstAgent !== "object"
  ) {
    return null;
  }
  const agentRecord = firstAgent as Record<string, unknown>;
  const metadata = agentRecord["metadata"];
  if (
    metadata === null ||
    metadata === undefined ||
    typeof metadata !== "object"
  ) {
    return null;
  }
  const metadataRecord = metadata as Record<string, unknown>;
  const displayName = metadataRecord["displayName"];
  if (typeof displayName !== "string") return null;
  return displayName;
}

const router = tsr.router(composesListContract, {
  list: async ({ query, headers }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }
    const { userId, orgId: tokenOrgId } = authCtx;

    // Resolve org: use ?scope= query param or default org
    let orgId: string;
    try {
      const { org: resolvedOrg } = await resolveOrg(
        userId,
        query.scope,
        query.org,
        tokenOrgId,
      );
      orgId = resolvedOrg.orgId;
    } catch (error) {
      if (isNotFound(error)) {
        return {
          status: 400 as const,
          body: {
            error: { message: "Invalid request", code: "BAD_REQUEST" },
          },
        };
      }
      if (isForbidden(error)) {
        return {
          status: 403 as const,
          body: {
            error: {
              message: "You don't have access to this org",
              code: "FORBIDDEN",
            },
          },
        };
      }
      throw error;
    }

    // Query own composes for this org (join head version for displayName)
    const ownComposes = await globalThis.services.db
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
      .where(eq(agentComposes.orgId, orgId))
      .orderBy(desc(agentComposes.updatedAt));

    // When using default org (no ?scope= param), also include email-shared agents
    let sharedComposes: {
      name: string;
      headVersionId: string | null;
      updatedAt: Date;
      orgSlug: string;
    }[] = [];

    if (!query.scope && !query.org) {
      const userEmail = await getUserEmail(userId);
      const shared = await getEmailSharedAgents(userId, userEmail);
      sharedComposes = shared;
    }

    // Combine: own agents first, then shared agents with org/name format
    const allComposes = [
      ...ownComposes.map((c) => ({
        name: c.name,
        displayName: extractDisplayName(c.headContent),
        headVersionId: c.headVersionId,
        updatedAt: c.updatedAt.toISOString(),
        isOwner: true,
      })),
      ...sharedComposes.map((c) => ({
        name: `${c.orgSlug}/${c.name}`,
        displayName: null as string | null,
        headVersionId: c.headVersionId,
        updatedAt: c.updatedAt.toISOString(),
        isOwner: false,
      })),
    ];

    return {
      status: 200 as const,
      body: {
        composes: allComposes,
      },
    };
  },
});

const handler = createHandler(composesListContract, router);

export { handler as GET };
