const WEB_ORIGIN_HEADER = "x-vm0-web-origin";

function isLocalhost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

function isVm0WebHost(hostname: string): boolean {
  return (
    hostname === "www.vm0.ai" ||
    hostname === "www.vm6.ai" ||
    hostname.endsWith("-www.vm6.ai") ||
    hostname === "www.vm7.ai" ||
    hostname.endsWith("-www.vm7.ai")
  );
}

function isTrustedWebOrigin(origin: string): boolean {
  if (!URL.canParse(origin)) {
    return false;
  }

  const url = new URL(origin);
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return false;
  }

  if (isLocalhost(url.hostname)) {
    return url.protocol === "http:" || url.protocol === "https:";
  }

  return url.protocol === "https:" && isVm0WebHost(url.hostname);
}

function canonicalWebOriginForApiHost(url: URL): string | null {
  const webHostname = url.hostname.replace(/(^|-)api\./u, "$1www.");
  if (webHostname === url.hostname) {
    return null;
  }

  const webUrl = new URL(url.toString());
  webUrl.hostname = webHostname;
  webUrl.protocol = "https:";
  webUrl.username = "";
  webUrl.password = "";
  webUrl.pathname = "/";
  webUrl.search = "";
  webUrl.hash = "";

  if (!isTrustedWebOrigin(webUrl.origin)) {
    return null;
  }
  return webUrl.origin;
}

export function getConnectorOAuthOrigin(request: Request): string {
  const webOrigin = request.headers.get(WEB_ORIGIN_HEADER);
  if (webOrigin && isTrustedWebOrigin(webOrigin)) {
    return new URL(webOrigin).origin;
  }

  return new URL(request.url).origin;
}

export function getConnectorOAuthCanonicalRedirectUrl(
  request: Request,
): string | null {
  const webOrigin = request.headers.get(WEB_ORIGIN_HEADER);
  if (webOrigin && isTrustedWebOrigin(webOrigin)) {
    return null;
  }

  const requestUrl = new URL(request.url);
  const canonicalOrigin = canonicalWebOriginForApiHost(requestUrl);
  if (!canonicalOrigin) {
    return null;
  }

  return new URL(
    `${requestUrl.pathname}${requestUrl.search}`,
    canonicalOrigin,
  ).toString();
}
