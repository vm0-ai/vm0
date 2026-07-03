import { computed, type Computed } from "ccstate";
import type { SessionResponse } from "@vm0/api-contracts/contracts/sessions";
import { extractAndGroupVariables } from "@vm0/core/variable-expander";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { eq } from "drizzle-orm";

import { db$, type ReadonlyDb } from "../external/db";

interface AgentSessionByIdArgs {
  readonly sessionId: string;
  readonly userId: string;
  readonly orgId: string;
}

type AgentSessionByIdResult =
  | { readonly kind: "not-found" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "ok"; readonly session: SessionResponse };

async function secretNamesForCompose(
  db: ReadonlyDb,
  composeId: string,
): Promise<string[] | null> {
  const [compose] = await db
    .select({ headVersionId: agentComposes.headVersionId })
    .from(agentComposes)
    .where(eq(agentComposes.id, composeId))
    .limit(1);

  if (!compose?.headVersionId) {
    return null;
  }

  const [version] = await db
    .select({ content: agentComposeVersions.content })
    .from(agentComposeVersions)
    .where(eq(agentComposeVersions.id, compose.headVersionId))
    .limit(1);

  if (!version) {
    return null;
  }

  const grouped = extractAndGroupVariables(version.content);
  const names = grouped.secrets.map((ref) => {
    return ref.name;
  });
  return names.length > 0 ? names : null;
}

export function agentSessionById(
  args: AgentSessionByIdArgs,
): Computed<Promise<AgentSessionByIdResult>> {
  return computed(async (get): Promise<AgentSessionByIdResult> => {
    const db = get(db$);
    const [session] = await db
      .select({
        id: agentSessions.id,
        userId: agentSessions.userId,
        orgId: agentSessions.orgId,
        agentComposeId: agentSessions.agentComposeId,
        conversationId: agentSessions.conversationId,
        artifacts: agentSessions.artifacts,
        createdAt: agentSessions.createdAt,
        updatedAt: agentSessions.updatedAt,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, args.sessionId))
      .limit(1);

    if (!session) {
      return { kind: "not-found" };
    }

    if (session.userId !== args.userId) {
      return { kind: "forbidden" };
    }

    if (session.orgId !== args.orgId) {
      return { kind: "not-found" };
    }

    const secretNames = await secretNamesForCompose(db, session.agentComposeId);

    return {
      kind: "ok",
      session: {
        id: session.id,
        agentComposeId: session.agentComposeId,
        conversationId: session.conversationId,
        artifactNames: session.artifacts.map((artifact) => {
          return artifact.name;
        }),
        secretNames,
        createdAt: session.createdAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(),
      },
    };
  });
}
