import type { CustomConnectorPermissionBundleResponse } from "@okouai/api-contracts/contracts/custom-connectors";

import { getAgentCustomConnectorGrants } from "../../lib/api/domains/agents";
import {
  getCustomConnector,
  getCustomConnectorPermissionBundle,
} from "../../lib/api/domains/connectors";

type CustomConnectorAuthorization =
  | { readonly state: "enabled"; readonly permissionNames: readonly string[] }
  | { readonly state: "not-enabled" }
  | { readonly state: "unavailable" };

type CustomConnectorPermissionModel =
  | { readonly kind: "connector" }
  | {
      readonly kind: "bundle";
      readonly bundle: CustomConnectorPermissionBundleResponse;
    }
  | { readonly kind: "unavailable" };

export interface CustomConnectorPermissionInfo {
  readonly authorization: CustomConnectorAuthorization;
  readonly model: CustomConnectorPermissionModel;
}

async function loadCustomConnectorPermissionModel(
  connectorId: string,
): Promise<CustomConnectorPermissionModel> {
  try {
    const definition = await getCustomConnector(connectorId);
    if (!definition || definition.id !== connectorId) {
      return { kind: "unavailable" };
    }
    if (definition.kind === "mcp" || definition.permissionBundleRef === null) {
      return { kind: "connector" };
    }
    if (definition.permissionBundleRef === undefined) {
      return { kind: "unavailable" };
    }

    const bundle = await getCustomConnectorPermissionBundle(connectorId);
    if (!bundle || bundle.ref !== definition.permissionBundleRef) {
      return { kind: "unavailable" };
    }
    return { kind: "bundle", bundle };
  } catch {
    // A failed metadata read must not discard this target's Agent grant or
    // the independently available information for other run targets.
    return { kind: "unavailable" };
  }
}

export async function loadCustomConnectorPermissionInfos(args: {
  readonly agentId: string;
  readonly customConnectorIds: readonly string[];
}): Promise<Map<string, CustomConnectorPermissionInfo>> {
  if (args.customConnectorIds.length === 0) return new Map();

  const [grants, models] = await Promise.all([
    getAgentCustomConnectorGrants(args.agentId).catch(() => {
      return null;
    }),
    Promise.all(
      args.customConnectorIds.map(async (connectorId) => {
        return [
          connectorId,
          await loadCustomConnectorPermissionModel(connectorId),
        ] as const;
      }),
    ),
  ]);
  const grantsById =
    grants === null
      ? null
      : new Map(
          grants.map((grant) => {
            return [grant.customConnectorId, grant];
          }),
        );

  return new Map(
    models.map(([connectorId, model]) => {
      const grant = grantsById?.get(connectorId);
      const authorization: CustomConnectorAuthorization =
        grantsById === null
          ? { state: "unavailable" }
          : grant
            ? { state: "enabled", permissionNames: grant.permissionNames }
            : { state: "not-enabled" };
      return [connectorId, { authorization, model }];
    }),
  );
}
