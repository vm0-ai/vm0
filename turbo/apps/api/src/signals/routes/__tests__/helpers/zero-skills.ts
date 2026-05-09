import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { zeroSkills } from "@vm0/db/schema/zero-skill";
import { eq } from "drizzle-orm";

import { writeDb$ } from "../../../external/db";

export interface SkillsFixture {
  readonly orgId: string;
  readonly userId: string;
}

export const seedSkillsFixture$ = command(
  (_, _input: void, _signal: AbortSignal): Promise<SkillsFixture> => {
    return Promise.resolve({
      orgId: `org_${randomUUID()}`,
      userId: `user_${randomUUID()}`,
    });
  },
);

export const deleteSkillsForFixture$ = command(
  async (
    { set },
    fixture: SkillsFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    await db.delete(zeroSkills).where(eq(zeroSkills.orgId, fixture.orgId));
    signal.throwIfAborted();
  },
);

export const seedSkill$ = command(
  async (
    { set },
    args: {
      orgId: string;
      userId: string;
      name: string;
      displayName?: string | null;
      description?: string | null;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    await db.insert(zeroSkills).values({
      orgId: args.orgId,
      name: args.name,
      displayName: args.displayName ?? null,
      description: args.description ?? null,
      createdBy: args.userId,
    });
    signal.throwIfAborted();
  },
);
