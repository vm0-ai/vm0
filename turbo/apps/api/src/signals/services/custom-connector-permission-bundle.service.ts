import {
  connectorSlugSchema,
  type ConnectorSlug,
} from "@vm0/api-contracts/contracts/connector-identity";
import type { CustomConnectorPermissionBundleRef } from "@vm0/api-contracts/contracts/zero-custom-connectors";
import type {
  ExpandedFirewallConfig,
  FirewallPolicyValue,
} from "@vm0/connectors/firewall-types";

import type { ConnectorRuntimeSnapshot } from "./connector-catalog-runtime.service";
import {
  FEISHU_CUSTOM_CONNECTOR_DEFAULT_POLICIES,
  FEISHU_CUSTOM_CONNECTOR_PERMISSION_BUNDLE_REF,
  FEISHU_CUSTOM_CONNECTOR_PERMISSIONS,
} from "./feishu-custom-connector-permissions";

const PERMISSION_BUNDLE_REF_PATTERN = /^builtin:([^@]+)@1$/u;

type FirewallPermissions = NonNullable<
  ExpandedFirewallConfig["apis"][number]["permissions"]
>;

export interface CustomConnectorPermissionBundle {
  readonly ref: CustomConnectorPermissionBundleRef;
  readonly connectorSlug: ConnectorSlug;
  readonly permissionNames: ReadonlySet<string>;
  readonly permissions: FirewallPermissions;
  readonly defaultPolicies: Readonly<Record<string, FirewallPolicyValue>>;
}

function customConnectorPermissionBundleSlug(
  ref: string,
): ConnectorSlug | null {
  const match = PERMISSION_BUNDLE_REF_PATTERN.exec(ref);
  const parsed = connectorSlugSchema.safeParse(match?.[1]);
  return parsed.success ? parsed.data : null;
}

export async function loadCustomConnectorPermissionBundle(args: {
  readonly snapshot: ConnectorRuntimeSnapshot;
  readonly ref: CustomConnectorPermissionBundleRef;
}): Promise<CustomConnectorPermissionBundle | null> {
  if (args.ref === FEISHU_CUSTOM_CONNECTOR_PERMISSION_BUNDLE_REF) {
    return {
      ref: args.ref,
      connectorSlug: "feishu",
      permissionNames: new Set(
        FEISHU_CUSTOM_CONNECTOR_PERMISSIONS.map((permission) => {
          return permission.name;
        }),
      ),
      permissions: [...FEISHU_CUSTOM_CONNECTOR_PERMISSIONS],
      defaultPolicies: FEISHU_CUSTOM_CONNECTOR_DEFAULT_POLICIES,
    };
  }

  const connectorSlug = customConnectorPermissionBundleSlug(args.ref);
  if (!connectorSlug || !args.snapshot.serverFirewalls.has(connectorSlug)) {
    return null;
  }

  const [permissionIndex, routingMetadata] = await Promise.all([
    args.snapshot.serverFirewalls.loadPermissionIndex(connectorSlug),
    args.snapshot.serverFirewalls.loadRoutingMetadata(connectorSlug),
  ]);
  if (!permissionIndex || !routingMetadata) {
    return null;
  }

  const rulesByPermission = new Map<string, Set<string>>(
    [...permissionIndex.permissionNames].map((permissionName) => {
      return [permissionName, new Set<string>()];
    }),
  );
  for (const api of routingMetadata.apis) {
    for (const route of api.routes) {
      rulesByPermission.get(route.permissionName)?.add(route.rule);
    }
  }

  const permissionNames = new Set(
    [...permissionIndex.permissionNames].sort((left, right) => {
      return left.localeCompare(right);
    }),
  );
  const permissions: FirewallPermissions = [...permissionNames].map((name) => {
    const description = permissionIndex.permissionDescription(name);
    return {
      name,
      ...(description ? { description } : {}),
      rules: [...(rulesByPermission.get(name) ?? [])].sort((left, right) => {
        return left.localeCompare(right);
      }),
    };
  });
  return {
    ref: args.ref,
    connectorSlug,
    permissionNames,
    permissions,
    defaultPolicies: Object.fromEntries(
      [...permissionNames].map((permissionName) => {
        return [permissionName, "deny" as const];
      }),
    ),
  };
}
