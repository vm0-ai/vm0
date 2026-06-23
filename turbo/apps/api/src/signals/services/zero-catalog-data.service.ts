import { computed, type Computed } from "ccstate";
import type { CustomConnectorResponse } from "@vm0/api-contracts/contracts/zero-custom-connectors";
import { orgCustomConnectorSecrets } from "@vm0/db/schema/org-custom-connector-secret";
import { orgCustomConnectorValues } from "@vm0/db/schema/org-custom-connector-value";
import { orgCustomConnectors } from "@vm0/db/schema/org-custom-connector";
import { and, eq } from "drizzle-orm";

import { db$ } from "../external/db";
import {
  normaliseCustomConnectorRow,
  serialiseCustomConnector,
} from "./zero-custom-connector.service";

function valueMarkerKey(args: { readonly kind: string; readonly key: string }) {
  return `${args.kind}:${args.key}`;
}

export function zeroCustomConnectorList(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<Promise<readonly CustomConnectorResponse[]>> {
  return computed(async (get): Promise<readonly CustomConnectorResponse[]> => {
    const db = get(db$);
    const [connectors, valueRows, legacySecretRows] = await Promise.all([
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
    const seen = new Set(
      markers.map((marker) => {
        return `${marker.connectorId}:${valueMarkerKey(marker)}`;
      }),
    );
    for (const row of legacySecretRows) {
      const marker = {
        connectorId: row.connectorId,
        kind: "secret" as const,
        key: "secret",
      };
      const key = `${marker.connectorId}:${valueMarkerKey(marker)}`;
      if (!seen.has(key)) {
        markers.push(marker);
        seen.add(key);
      }
    }

    return connectors.map((connector) => {
      return serialiseCustomConnector({
        row: normaliseCustomConnectorRow(connector),
        valueMarkers: markers,
      });
    });
  });
}
