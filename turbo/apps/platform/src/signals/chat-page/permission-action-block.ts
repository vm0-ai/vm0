import type { UserPermissionGrantExpiresIn } from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import {
  resolvePlatformOriginForTarget,
  rewritePlatformHostname,
} from "../api-base.ts";
import { parseUserPermissionGrantExpiresIn } from "../permission-allow/permission-grant-expiration.ts";
import {
  chatActionCallbackFromUrl,
  type ChatActionCallback,
} from "./action-callback.ts";

type PermissionAction = "allow" | "deny";

export interface PermissionActionDescriptor {
  scope: "agent";
  agentId: string;
  connectorSlug: string;
  permission: string;
  action: PermissionAction;
  method: string | null;
  path: string | null;
  reason: string | null;
  expiresIn: UserPermissionGrantExpiresIn | null;
  search: string;
  originalUrl: string;
  callbackPrompt: ChatActionCallback["callbackPrompt"];
  threadId: ChatActionCallback["threadId"];
}

export function permissionActionResourceKey(
  descriptor: PermissionActionDescriptor,
): string {
  const path = `/agents/${encodeURIComponent(descriptor.agentId)}/permissions`;
  return descriptor.search ? `${path}?${descriptor.search}` : path;
}

function browserOrigin(): string | null {
  if (typeof location === "undefined" || !location.origin) {
    return null;
  }
  return location.origin;
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

  addPermissionActionOriginVariants(origins, browserOrigin());
  addPermissionActionOriginVariants(
    origins,
    resolvePlatformOriginForTarget("api"),
  );

  return origins;
}

function permissionActionBaseUrl(): string | null {
  return browserOrigin() ?? resolvePlatformOriginForTarget("api");
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
  scope: "agent";
  agentId: string;
};

function parsePermissionActionPath(
  pathname: string,
): ParsedPermissionActionPath | null {
  const agentMatch = pathname.match(/^\/agents\/([^/]+)\/permissions$/);
  if (!agentMatch) {
    return null;
  }

  return {
    scope: "agent",
    agentId: agentMatch[1] ?? "",
  };
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
  // TODO(#23823): Remove the legacy serialized-action query fallback.
  const connectorSlug =
    url.searchParams.get("connectorSlug") ?? url.searchParams.get("ref");
  const permission = url.searchParams.get("permission");
  const action = url.searchParams.get("action") ?? "allow";
  const method = url.searchParams.get("method");
  const requestPath = url.searchParams.get("path");
  const reason = url.searchParams.get("reason");
  const expiresIn =
    action === "allow"
      ? parseUserPermissionGrantExpiresIn(url.searchParams.get("expiresIn"))
      : null;
  const actionCallback = chatActionCallbackFromUrl(url);

  if (
    !path.agentId ||
    !connectorSlug ||
    !permission ||
    !isPermissionAction(action)
  ) {
    return null;
  }

  return {
    scope: path.scope,
    agentId: path.agentId,
    connectorSlug,
    permission,
    action,
    method,
    path: requestPath,
    reason,
    expiresIn,
    search: url.searchParams.toString(),
    originalUrl: value,
    ...actionCallback,
  };
}
