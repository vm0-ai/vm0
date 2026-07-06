import { computed, type Computed } from "ccstate";
import type { CustomConnectorResponse } from "@vm0/api-contracts/contracts/zero-custom-connectors";
import { orgCustomConnectorValues } from "@vm0/db/schema/org-custom-connector-value";
import { orgCustomConnectors } from "@vm0/db/schema/org-custom-connector";
import { and, eq } from "drizzle-orm";

import { db$ } from "../external/db";
import {
  normaliseCustomConnectorRow,
  serialiseCustomConnector,
} from "./zero-custom-connector.service";

export function zeroCustomConnectorList(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<Promise<readonly CustomConnectorResponse[]>> {
  return computed(async (get): Promise<readonly CustomConnectorResponse[]> => {
    const db = get(db$);
    const [connectors, valueRows] = await Promise.all([
      db
        .select()
        .from(orgCustomConnectors)
        .where(eq(orgCustomConnectors.orgId, args.orgId))
        .orderBy(orgCustomConnectors.displayName),
      db
        .select({
          connectorId: orgCustomConnectorValues.connectorId,
          kind: orgCustomConnectorValues.kind,
          key: orgCustomConnectorValues.key,
        })
        .from(orgCustomConnectorValues)
        .where(
          and(
            eq(orgCustomConnectorValues.orgId, args.orgId),
            eq(orgCustomConnectorValues.userId, args.userId),
          ),
        ),
    ]);

    const markers = valueRows
      .filter((row) => {
        return row.kind === "secret" || row.kind === "variable";
      })
      .map((row) => {
        return {
          connectorId: row.connectorId,
          kind:
            row.kind === "secret" ? ("secret" as const) : ("variable" as const),
          key: row.key,
        };
      });
    type ValueMarker = (typeof markers)[number];
    const markersByConnectorId = new Map<string, ValueMarker[]>();
    for (const marker of markers) {
      const connectorMarkers =
        markersByConnectorId.get(marker.connectorId) ?? [];
      connectorMarkers.push(marker);
      markersByConnectorId.set(marker.connectorId, connectorMarkers);
    }

    return connectors.map((connector) => {
      return serialiseCustomConnector({
        row: normaliseCustomConnectorRow(connector),
        valueMarkers: markersByConnectorId.get(connector.id) ?? [],
      });
    });
  });
}
