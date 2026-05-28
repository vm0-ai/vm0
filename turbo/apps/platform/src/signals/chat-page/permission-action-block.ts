import {
  isFirewallConnectorType,
  type FirewallConnectorType,
} from "@vm0/connectors/firewalls";

type PermissionAction = "allow" | "deny";

export interface PermissionActionDescriptor {
  agentId: string;
  connectorRef: FirewallConnectorType;
  permission: string;
  action: PermissionAction;
  method: string | null;
  path: string | null;
  reason: string | null;
  search: string;
  originalUrl: string;
}

export type PermissionActionBlock = PermissionActionDescriptor & {
  type: "permission-action";
  id: string;
  href: string;
};

function permissionActionHref(descriptor: PermissionActionDescriptor): string {
  const path = `/agents/${encodeURIComponent(descriptor.agentId)}/permissions`;
  return descriptor.search ? `${path}?${descriptor.search}` : path;
}

const PERMISSION_ACTION_BASE_URL = "https://app.vm0.ai";

function isPermissionAction(value: string): value is PermissionAction {
  return value === "allow" || value === "deny";
}

export function parsePermissionActionUrl(
  value: string,
): PermissionActionDescriptor | null {
  if (!URL.canParse(value, PERMISSION_ACTION_BASE_URL)) {
    return null;
  }

  const url = new URL(value, PERMISSION_ACTION_BASE_URL);
  if (url.origin !== PERMISSION_ACTION_BASE_URL) {
    return null;
  }

  const match = url.pathname.match(/^\/agents\/([^/]+)\/permissions$/);
  const agentId = match?.[1];
  const connectorRef = url.searchParams.get("ref");
  const permission = url.searchParams.get("permission");
  const action = url.searchParams.get("action") ?? "allow";
  const method = url.searchParams.get("method");
  const path = url.searchParams.get("path");
  const reason = url.searchParams.get("reason");

  if (
    !agentId ||
    !connectorRef ||
    !isFirewallConnectorType(connectorRef) ||
    !permission ||
    !isPermissionAction(action)
  ) {
    return null;
  }

  return {
    agentId,
    connectorRef,
    permission,
    action,
    method,
    path,
    reason,
    search: url.searchParams.toString(),
    originalUrl: value,
  };
}

export function createPermissionActionBlock(
  id: string,
  descriptor: PermissionActionDescriptor,
): PermissionActionBlock {
  return {
    type: "permission-action",
    id,
    ...descriptor,
    href: permissionActionHref(descriptor),
  };
}
