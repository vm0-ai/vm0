import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { computerUseHosts } from "@vm0/db/schema/computer-use-host";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { and, eq } from "drizzle-orm";

import { writeDb$ } from "../../../external/db";
import { now } from "../../../external/time";

interface ScenarioHost {
  readonly domain: string;
  readonly token: string;
  readonly expiresAt?: Date;
}

interface ComputerUseScenarioValues {
  readonly computerUseEnabled: boolean;
  readonly host?: ScenarioHost;
}

export interface ComputerUseScenarioFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly hostId: string | null;
}

export const seedComputerUseScenario$ = command(
  async (
    { set },
    values: ComputerUseScenarioValues,
    signal: AbortSignal,
  ): Promise<ComputerUseScenarioFixture> => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const writeDb = set(writeDb$);

    await writeDb.insert(userFeatureSwitches).values({
      orgId,
      userId,
      switches: { computerUse: values.computerUseEnabled },
    });
    signal.throwIfAborted();

    let hostId: string | null = null;
    if (values.host) {
      hostId = randomUUID();
      await writeDb.insert(computerUseHosts).values({
        id: hostId,
        orgId,
        userId,
        domain: values.host.domain,
        token: values.host.token,
        expiresAt: values.host.expiresAt ?? new Date(now() + 60 * 60 * 1000),
      });
      signal.throwIfAborted();
    }

    return { orgId, userId, hostId };
  },
);

export const deleteComputerUseScenario$ = command(
  async (
    { set },
    fixture: ComputerUseScenarioFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    if (fixture.hostId) {
      await writeDb
        .delete(computerUseHosts)
        .where(eq(computerUseHosts.id, fixture.hostId));
      signal.throwIfAborted();
    }
    await writeDb
      .delete(userFeatureSwitches)
      .where(
        and(
          eq(userFeatureSwitches.orgId, fixture.orgId),
          eq(userFeatureSwitches.userId, fixture.userId),
        ),
      );
    signal.throwIfAborted();
  },
);
