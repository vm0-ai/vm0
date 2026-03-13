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
import { resolveOrg } from "../../../../../src/lib/org/resolve-org";
import { isNotFound, isForbidden } from "../../../../../src/lib/errors";
import { getEmailSharedAgents } from "../../../../../src/lib/agent/permission-service";

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
    const { userId } = authCtx;

    // Resolve org: use ?org= query param or default org
    let orgId: string;
    try {
      const { org: resolvedOrg } = await resolveOrg(userId, query.org);
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

    // When using default org (no ?org= param), also include email-shared agents
    let sharedComposes: {
      id: string;
      name: string;
      headVersionId: string | null;
      updatedAt: Date;
      orgSlug: string;
    }[] = [];

    if (!query.org) {
      const userEmail = await getUserEmail(userId);
      const shared = await getEmailSharedAgents(userId, userEmail);
      sharedComposes = shared;
    }

    // Combine: own agents first, then shared agents with org/name format
    const allComposes = [
      ...ownComposes.map((c) => {
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
      ...sharedComposes.map((c) => ({
        id: c.id,
        name: `${c.orgSlug}/${c.name}`,
        displayName: null as string | null,
        description: null as string | null,
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
