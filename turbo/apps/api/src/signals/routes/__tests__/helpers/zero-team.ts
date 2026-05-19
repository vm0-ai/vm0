import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { inArray } from "drizzle-orm";

import { writeDb$ } from "../../../external/db";

export interface TeamComposeFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly composeIds: readonly string[];
}

interface SeedComposeRow {
  readonly displayName?: string | null;
  readonly description?: string | null;
  readonly sound?: string | null;
  readonly avatarUrl?: string | null;
  readonly headVersionId?: string | null;
  readonly ownerId?: string;
  readonly visibility?: "public" | "private";
  readonly withZeroAgent?: boolean;
}

interface SeedTeamComposeValues {
  readonly orgId?: string;
  readonly userId?: string;
  readonly composes?: readonly SeedComposeRow[];
}

export const seedTeamCompose$ = command(
  async (
    { set },
    values: SeedTeamComposeValues,
    signal: AbortSignal,
  ): Promise<TeamComposeFixture> => {
    const orgId = values.orgId ?? `org_${randomUUID()}`;
    const userId = values.userId ?? `user_${randomUUID()}`;
    const writeDb = set(writeDb$);
    const composeRows = values.composes ?? [];
    const composeIds: string[] = [];

    for (const row of composeRows) {
      const composeId = randomUUID();
      composeIds.push(composeId);

      await writeDb.insert(agentComposes).values({
        id: composeId,
        userId,
        orgId,
        name: `agent-${composeId.slice(0, 8)}`,
        headVersionId: row.headVersionId ?? null,
      });
      signal.throwIfAborted();

      if (row.withZeroAgent !== false) {
        await writeDb.insert(zeroAgents).values({
          id: composeId,
          orgId,
          owner: row.ownerId ?? userId,
          name: `agent-${composeId.slice(0, 8)}`,
          displayName: row.displayName ?? null,
          description: row.description ?? null,
          sound: row.sound ?? null,
          avatarUrl: row.avatarUrl ?? null,
          visibility: row.visibility ?? "public",
        });
        signal.throwIfAborted();
      }
    }

    return { orgId, userId, composeIds };
  },
);

export const deleteTeamCompose$ = command(
  async (
    { set },
    fixture: TeamComposeFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    if (fixture.composeIds.length === 0) {
      return;
    }
    const writeDb = set(writeDb$);
    await writeDb
      .delete(zeroAgents)
      .where(inArray(zeroAgents.id, [...fixture.composeIds]));
    signal.throwIfAborted();
    await writeDb
      .delete(agentComposes)
      .where(inArray(agentComposes.id, [...fixture.composeIds]));
    signal.throwIfAborted();
  },
);
