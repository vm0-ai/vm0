type WindowOpenDecision =
  | { readonly action: "allow-in-app" }
  | { readonly action: "open-external"; readonly url: string }
  | { readonly action: "deny" };

const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const CLERK_DEVELOPMENT_HOST_SUFFIX = ".clerk.accounts.dev";
const SAME_SITE_AUTH_SUBDOMAINS = new Set(["accounts", "auth", "clerk"]);
const DEDICATED_AUTH_HOSTS = new Set([
  "accounts.google.com",
  "appleid.apple.com",
  "auth.atlassian.com",
  "login.live.com",
  "login.microsoft.com",
  "login.microsoftonline.com",
]);
const AUTH_REDIRECT_PARAM_NAMES = [
  "redirect",
  "redirect_uri",
  "redirect_url",
  "redirectUrl",
  "return_to",
  "returnUrl",
] as const;
const GENERAL_AUTH_HOST_PATH_PREFIXES = new Map<string, readonly string[]>([
  ["github.com", ["/login", "/login/oauth"]],
  ["gitlab.com", ["/oauth", "/users/sign_in"]],
  ["slack.com", ["/oauth", "/openid", "/signin", "/sign_in"]],
]);

function parseUrl(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

function hostnameMatchesSuffix(hostname: string, suffix: string): boolean {
  return hostname === suffix.slice(1) || hostname.endsWith(suffix);
}

function rootDomain(hostname: string): string | null {
  const labels = hostname.split(".");
  if (labels.length < 2) {
    return null;
  }
  return labels.slice(-2).join(".");
}

function isAllowedSameSiteAuthHost(
  url: URL,
  allowedAppOrigins: ReadonlySet<string>,
): boolean {
  const [subdomain] = url.hostname.split(".");
  if (!subdomain || !SAME_SITE_AUTH_SUBDOMAINS.has(subdomain)) {
    return false;
  }

  const urlRootDomain = rootDomain(url.hostname);
  if (!urlRootDomain) {
    return false;
  }

  return [...allowedAppOrigins].some((origin) => {
    const allowedUrl = parseUrl(origin);
    return (
      allowedUrl?.protocol === "https:" &&
      rootDomain(allowedUrl.hostname) === urlRootDomain
    );
  });
}

function isClerkFrontendUrl(
  url: URL,
  allowedAppOrigins: ReadonlySet<string>,
): boolean {
  return (
    url.protocol === "https:" &&
    (hostnameMatchesSuffix(url.hostname, CLERK_DEVELOPMENT_HOST_SUFFIX) ||
      isAllowedSameSiteAuthHost(url, allowedAppOrigins))
  );
}

function isAllowedAuthRedirectValue(
  rawRedirectUrl: string,
  allowedAppOrigins: ReadonlySet<string>,
): boolean {
  const redirectUrl = parseUrl(rawRedirectUrl);
  if (!redirectUrl) {
    return false;
  }

  return (
    allowedAppOrigins.has(redirectUrl.origin) ||
    isClerkFrontendUrl(redirectUrl, allowedAppOrigins)
  );
}

function hasAllowedAuthRedirect(
  url: URL,
  allowedAppOrigins: ReadonlySet<string>,
): boolean {
  return AUTH_REDIRECT_PARAM_NAMES.some((paramName) => {
    const redirectValue = url.searchParams.get(paramName);
    return (
      redirectValue !== null &&
      isAllowedAuthRedirectValue(redirectValue, allowedAppOrigins)
    );
  });
}

function hasOAuthHint(url: URL): boolean {
  return (
    url.searchParams.has("client_id") ||
    url.searchParams.has("scope") ||
    url.searchParams.has("state") ||
    url.searchParams.has("return_to") ||
    url.pathname.includes("oauth") ||
    url.pathname.includes("oidc") ||
    url.pathname.includes("sso")
  );
}

function isKnownAuthProviderUrl(url: URL): boolean {
  if (DEDICATED_AUTH_HOSTS.has(url.hostname)) {
    return true;
  }

  const pathPrefixes = GENERAL_AUTH_HOST_PATH_PREFIXES.get(url.hostname);
  if (!pathPrefixes || !hasOAuthHint(url)) {
    return false;
  }

  return pathPrefixes.some(
    (pathPrefix) =>
      url.pathname === pathPrefix || url.pathname.startsWith(`${pathPrefix}/`),
  );
}

function isAuthFlowUrl(
  url: URL,
  allowedAppOrigins: ReadonlySet<string>,
): boolean {
  return (
    isClerkFrontendUrl(url, allowedAppOrigins) ||
    hasAllowedAuthRedirect(url, allowedAppOrigins) ||
    (url.protocol === "https:" && isKnownAuthProviderUrl(url))
  );
}

export function isAllowedAppNavigation(
  rawUrl: string,
  allowedAppOrigins: ReadonlySet<string>,
): boolean {
  const url = parseUrl(rawUrl);
  if (!url) {
    return false;
  }
  return (
    allowedAppOrigins.has(url.origin) || isAuthFlowUrl(url, allowedAppOrigins)
  );
}

export function decideWindowOpen(
  rawUrl: string,
  allowedAppOrigins: ReadonlySet<string>,
): WindowOpenDecision {
  const url = parseUrl(rawUrl);
  if (!url) {
    return { action: "deny" };
  }

  if (allowedAppOrigins.has(url.origin)) {
    return { action: "allow-in-app" };
  }

  if (isAuthFlowUrl(url, allowedAppOrigins)) {
    return { action: "allow-in-app" };
  }

  if (EXTERNAL_PROTOCOLS.has(url.protocol)) {
    return { action: "open-external", url: url.toString() };
  }

  return { action: "deny" };
}
