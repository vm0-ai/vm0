import { computed, type Computed } from "ccstate";
import type { CustomConnectorResponse } from "@vm0/api-contracts/contracts/zero-custom-connectors";
import type { ZeroAgentCustomSkill } from "@vm0/api-contracts/contracts/zero-agents";
import { orgCustomConnectorSecrets } from "@vm0/db/schema/org-custom-connector-secret";
import { orgCustomConnectors } from "@vm0/db/schema/org-custom-connector";
import { zeroSkills } from "@vm0/db/schema/zero-skill";
import { and, eq } from "drizzle-orm";

import { db$ } from "../external/db";

function stringArray(value: readonly string[] | unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => {
        return typeof item === "string";
      })
    : [];
}

export function zeroSkillList(
  orgId: string,
): Computed<Promise<readonly ZeroAgentCustomSkill[]>> {
  return computed(async (get): Promise<readonly ZeroAgentCustomSkill[]> => {
    const rows = await get(db$)
      .select({
        name: zeroSkills.name,
        displayName: zeroSkills.displayName,
        description: zeroSkills.description,
      })
      .from(zeroSkills)
      .where(eq(zeroSkills.orgId, orgId));

    return rows.map((row) => {
      return {
        name: row.name,
        displayName: row.displayName,
        description: row.description,
      };
    });
  });
}

export function zeroCustomConnectorList(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<Promise<readonly CustomConnectorResponse[]>> {
  return computed(async (get): Promise<readonly CustomConnectorResponse[]> => {
    const db = get(db$);
    const [connectors, secretRows] = await Promise.all([
      db
        .select()
        .from(orgCustomConnectors)
        .where(eq(orgCustomConnectors.orgId, args.orgId))
        .orderBy(orgCustomConnectors.slug),
      db
        .select({ connectorId: orgCustomConnectorSecrets.connectorId })
        .from(orgCustomConnectorSecrets)
        .where(
          and(
            eq(orgCustomConnectorSecrets.orgId, args.orgId),
            eq(orgCustomConnectorSecrets.userId, args.userId),
          ),
        ),
    ]);

    const haveSecret = new Set(
      secretRows.map((row) => {
        return row.connectorId;
      }),
    );

    return connectors.map((connector) => {
      return {
        id: connector.id,
        slug: connector.slug,
        displayName: connector.displayName,
        prefixes: [...stringArray(connector.prefixes)],
        headerName: connector.headerName,
        headerTemplate: connector.headerTemplate,
        createdAt: connector.createdAt.toISOString(),
        updatedAt: connector.updatedAt.toISOString(),
        hasSecret: haveSecret.has(connector.id),
      };
    });
  });
}
