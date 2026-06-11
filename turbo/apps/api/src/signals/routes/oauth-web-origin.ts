import { env } from "../../lib/env";

const WEB_ORIGIN_HEADER = "x-vm0-web-origin";

type Vm0HostRole = "api" | "www";

function isVm0Host(hostname: string, role: Vm0HostRole): boolean {
  return (
    hostname === `${role}.vm0.ai` ||
    hostname === `${role}.vm6.ai` ||
    hostname.endsWith(`-${role}.vm6.ai`) ||
    hostname === `${role}.vm7.ai` ||
    hostname.endsWith(`-${role}.vm7.ai`)
  );
}

function isTrustedOrigin(origin: string, role: Vm0HostRole): boolean {
  if (!URL.canParse(origin)) {
    return false;
  }

  const url = new URL(origin);
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return false;
  }

  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    return url.protocol === "http:" || url.protocol === "https:";
  }

  return url.protocol === "https:" && isVm0Host(url.hostname, role);
}

function isTrustedWebOrigin(origin: string): boolean {
  return isTrustedOrigin(origin, "www");
}

function isTrustedApiOrigin(origin: string): boolean {
  return isTrustedOrigin(origin, "api");
}

function canonicalSiblingOriginForHost(
  url: URL,
  fromRole: Vm0HostRole,
  toRole: Vm0HostRole,
): string | null {
  const leadingRole = `${fromRole}.`;
  const delimitedRole = `-${fromRole}.`;
  let hostname: string | null = null;
  if (url.hostname.startsWith(leadingRole)) {
    hostname = `${toRole}.${url.hostname.slice(leadingRole.length)}`;
  } else {
    const roleIndex = url.hostname.indexOf(delimitedRole);
    if (roleIndex !== -1) {
      const prefix = url.hostname.slice(0, roleIndex);
      const suffix = url.hostname.slice(roleIndex + delimitedRole.length);
      hostname = `${prefix}-${toRole}.${suffix}`;
    }
  }

  if (!hostname) {
    return null;
  }

  const siblingUrl = new URL(url.toString());
  siblingUrl.hostname = hostname;
  siblingUrl.protocol = "https:";
  siblingUrl.username = "";
  siblingUrl.password = "";
  siblingUrl.pathname = "/";
  siblingUrl.search = "";
  siblingUrl.hash = "";

  const isTrusted =
    toRole === "api"
      ? isTrustedApiOrigin(siblingUrl.origin)
      : isTrustedWebOrigin(siblingUrl.origin);
  if (!isTrusted) {
    return null;
  }
  return siblingUrl.origin;
}

export function getOAuthWebOrigin(_request: Request): string {
  return new URL(env("VM0_WEB_URL")).origin;
}

export function getOAuthApiOrigin(_request: Request): string {
  const canonicalApiOrigin = canonicalSiblingOriginForHost(
    new URL(env("VM0_WEB_URL")),
    "www",
    "api",
  );
  if (canonicalApiOrigin) {
    return canonicalApiOrigin;
  }

  return new URL(env("VM0_API_URL")).origin;
}

export function getOAuthCanonicalRedirectUrl(request: Request): string | null {
  const webOrigin = request.headers.get(WEB_ORIGIN_HEADER);
  if (webOrigin && isTrustedWebOrigin(webOrigin)) {
    return null;
  }

  const requestUrl = new URL(request.url);
  const canonicalOrigin = canonicalSiblingOriginForHost(
    requestUrl,
    "api",
    "www",
  );
  if (!canonicalOrigin) {
    return null;
  }

  return new URL(
    `${requestUrl.pathname}${requestUrl.search}`,
    canonicalOrigin,
  ).toString();
}
