import {
  isFirewallMetadataConnectorType,
  type FirewallMetadataConnectorType,
} from "@vm0/connectors/firewall-metadata";
import type { UserPermissionGrantExpiresIn } from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import { parseUserPermissionGrantExpiresIn } from "../permission-allow/permission-grant-expiration.ts";

type PermissionAction = "allow" | "deny";
type PlatformHostTarget = "api" | "www" | "app" | "platform";

export interface PermissionActionDescriptor {
  scope: "agent" | "workflow";
  agentId: string;
  workflowId: string | null;
  triggerId: string | null;
  connectorRef: FirewallMetadataConnectorType;
  permission: string;
  action: PermissionAction;
  method: string | null;
  path: string | null;
  reason: string | null;
  expiresIn: UserPermissionGrantExpiresIn | null;
  search: string;
  originalUrl: string;
}

export type PermissionActionBlock = PermissionActionDescriptor & {
  type: "permission-action";
  id: string;
  href: string;
};

function permissionActionHref(descriptor: PermissionActionDescriptor): string {
  const path =
    descriptor.scope === "workflow" && descriptor.workflowId
      ? `/agents/${encodeURIComponent(descriptor.agentId)}/workflows/${encodeURIComponent(descriptor.workflowId)}/permissions`
      : `/agents/${encodeURIComponent(descriptor.agentId)}/permissions`;
  return descriptor.search ? `${path}?${descriptor.search}` : path;
}

function browserOrigin(): string | null {
  if (typeof location === "undefined" || !location.origin) {
    return null;
  }
  return location.origin;
}

function rewritePlatformHostname(
  hostname: string,
  target: PlatformHostTarget,
): string {
  return hostname.replace(/(^|-)(platform|app|www|api)\./, `$1${target}.`);
}

function addPermissionActionOriginVariants(
  origins: Set<string>,
  baseUrl: string | null,
) {
  if (!baseUrl || !URL.canParse(baseUrl)) {
    return;
  }

  const parsed = new URL(baseUrl);
  origins.add(parsed.origin);

  for (const target of ["api", "www", "app", "platform"] as const) {
    const variant = new URL(parsed);
    variant.hostname = rewritePlatformHostname(variant.hostname, target);
    origins.add(variant.origin);
  }
}

function permissionActionOrigins(): Set<string> {
  const origins = new Set<string>();
  const configuredApiUrl = import.meta.env.VITE_API_URL as string | undefined;

  addPermissionActionOriginVariants(origins, browserOrigin());
  addPermissionActionOriginVariants(origins, configuredApiUrl ?? null);

  return origins;
}

function permissionActionBaseUrl(): string | null {
  const configuredApiUrl = import.meta.env.VITE_API_URL as string | undefined;
  return browserOrigin() ?? configuredApiUrl ?? null;
}

function stripUrlParserIgnoredPrefix(value: string): string {
  let index = 0;
  while (index < value.length && value.charCodeAt(index) <= 0x20) {
    index += 1;
  }
  return value.slice(index);
}

function hasExplicitUrlOrigin(value: string): boolean {
  return (
    URL.canParse(value) || stripUrlParserIgnoredPrefix(value).startsWith("//")
  );
}

function isPlatformPermissionHostname(hostname: string): boolean {
  const isPlatformDomain = ["vm0.ai", "vm6.ai", "vm7.ai"].some((suffix) => {
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  });
  if (!isPlatformDomain) {
    return false;
  }

  return /(^|-)(platform|app|www|api)\./.test(hostname);
}

function isHttpUrl(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}

function isAllowedPermissionActionUrl(url: URL, sourceUrl: string): boolean {
  const explicitOrigin = hasExplicitUrlOrigin(sourceUrl);
  if (explicitOrigin && !isHttpUrl(url)) {
    return false;
  }

  return (
    !explicitOrigin ||
    permissionActionOrigins().has(url.origin) ||
    isPlatformPermissionHostname(url.hostname)
  );
}

function parseUrl(value: string): URL | null {
  const baseUrl = permissionActionBaseUrl();
  if (baseUrl) {
    if (!URL.canParse(value, baseUrl)) {
      return null;
    }
    return new URL(value, baseUrl);
  }

  if (!URL.canParse(value)) {
    return null;
  }
  return new URL(value);
}

function isPermissionAction(value: string): value is PermissionAction {
  return value === "allow" || value === "deny";
}

type ParsedPermissionActionPath = {
  scope: "agent" | "workflow";
  agentId: string;
  workflowId: string | null;
  triggerId: string | null;
};

function parsePermissionActionPath(
  pathname: string,
): ParsedPermissionActionPath | null {
  const workflowMatch = pathname.match(
    /^\/agents\/([^/]+)\/workflows\/([^/]+)(?:\/triggers\/([^/]+))?\/permissions$/,
  );
  if (workflowMatch) {
    return {
      scope: "workflow",
      agentId: workflowMatch[1] ?? "",
      workflowId: workflowMatch[2] ?? "",
      triggerId: workflowMatch[3] ?? null,
    };
  }

  const agentMatch = pathname.match(/^\/agents\/([^/]+)\/permissions$/);
  if (!agentMatch) {
    return null;
  }

  return {
    scope: "agent",
    agentId: agentMatch[1] ?? "",
    workflowId: null,
    triggerId: null,
  };
}

function normalizedPermissionActionSearch(
  url: URL,
  triggerId: string | null,
): string {
  const normalizedSearchParams = new URLSearchParams(url.searchParams);
  if (triggerId && !normalizedSearchParams.has("triggerId")) {
    normalizedSearchParams.set("triggerId", triggerId);
  }
  return normalizedSearchParams.toString();
}

export function parsePermissionActionUrl(
  value: string,
): PermissionActionDescriptor | null {
  const url = parseUrl(value);
  if (!url) {
    return null;
  }

  if (!isAllowedPermissionActionUrl(url, value)) {
    return null;
  }

  const path = parsePermissionActionPath(url.pathname);
  if (!path) {
    return null;
  }
  const triggerId = path.triggerId ?? url.searchParams.get("triggerId");
  const connectorRef = url.searchParams.get("ref");
  const permission = url.searchParams.get("permission");
  const action = url.searchParams.get("action") ?? "allow";
  const method = url.searchParams.get("method");
  const requestPath = url.searchParams.get("path");
  const reason = url.searchParams.get("reason");
  const expiresIn =
    action === "allow"
      ? parseUserPermissionGrantExpiresIn(url.searchParams.get("expiresIn"))
      : null;

  if (
    !path.agentId ||
    !connectorRef ||
    !isFirewallMetadataConnectorType(connectorRef) ||
    !permission ||
    !isPermissionAction(action)
  ) {
    return null;
  }

  return {
    scope: path.scope,
    agentId: path.agentId,
    workflowId: path.workflowId,
    triggerId,
    connectorRef,
    permission,
    action,
    method,
    path: requestPath,
    reason,
    expiresIn,
    search: normalizedPermissionActionSearch(url, triggerId),
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
