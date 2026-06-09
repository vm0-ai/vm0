import {
  isFirewallConnectorType,
  type FirewallConnectorType,
} from "@vm0/connectors/firewalls";
import type { UserPermissionGrantExpiresIn } from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import { parseUserPermissionGrantExpiresIn } from "../permission-allow/permission-grant-expiration.ts";

type PermissionAction = "allow" | "deny";
type PlatformHostTarget = "api" | "www" | "app" | "platform";

export interface PermissionActionDescriptor {
  agentId: string;
  connectorRef: FirewallConnectorType;
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
  const path = `/agents/${encodeURIComponent(descriptor.agentId)}/permissions`;
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

  const match = url.pathname.match(/^\/agents\/([^/]+)\/permissions$/);
  const agentId = match?.[1];
  const connectorRef = url.searchParams.get("ref");
  const permission = url.searchParams.get("permission");
  const action = url.searchParams.get("action") ?? "allow";
  const method = url.searchParams.get("method");
  const path = url.searchParams.get("path");
  const reason = url.searchParams.get("reason");
  const expiresIn =
    action === "allow"
      ? parseUserPermissionGrantExpiresIn(url.searchParams.get("expiresIn"))
      : null;

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
    expiresIn,
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
