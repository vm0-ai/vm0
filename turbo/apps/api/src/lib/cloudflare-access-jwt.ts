import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";

import { env } from "./env";
import { testOverride } from "./singleton";
import { now } from "./time";

const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedJwks {
  readonly expiresAt: number;
  readonly value: JSONWebKeySet;
}

const { get: getCachedJwks, set: setCachedJwks } = testOverride<
  CachedJwks | undefined
>(() => {
  return undefined;
});

function accessIssuer(): string {
  const configured = env("CF_ACCESS_TEAM_DOMAIN");
  if (!configured) {
    throw new Error("CF_ACCESS_TEAM_DOMAIN is required in Cloudflare Workers");
  }
  const url = new URL(
    configured.includes("://") ? configured : `https://${configured}`,
  );
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "CF_ACCESS_TEAM_DOMAIN must be an HTTPS origin or hostname",
    );
  }
  return url.origin;
}

function isJsonWebKeySet(value: unknown): value is JSONWebKeySet {
  if (!value || typeof value !== "object") {
    return false;
  }
  const keys = (value as { readonly keys?: unknown }).keys;
  return (
    Array.isArray(keys) &&
    keys.every((key) => {
      return key !== null && typeof key === "object" && !Array.isArray(key);
    })
  );
}

async function accessJwks(): Promise<JSONWebKeySet> {
  const cachedJwks = getCachedJwks();
  if (cachedJwks && cachedJwks.expiresAt > now()) {
    return cachedJwks.value;
  }

  const response = await fetch(`${accessIssuer()}/cdn-cgi/access/certs`, {
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`Cloudflare Access JWKS returned ${response.status}`);
  }
  const value: unknown = await response.json();
  if (!isJsonWebKeySet(value)) {
    throw new Error("Cloudflare Access JWKS returned an invalid response");
  }
  setCachedJwks({ expiresAt: now() + JWKS_CACHE_TTL_MS, value });
  return value;
}

export async function verifyCloudflareAccessAssertion(
  assertion: string,
): Promise<void> {
  const audience = env("CF_ACCESS_AUD");
  if (!audience) {
    throw new Error("CF_ACCESS_AUD is required in Cloudflare Workers");
  }
  const keySet = createLocalJWKSet(await accessJwks());
  await jwtVerify(assertion, keySet, {
    algorithms: ["RS256"],
    audience,
    issuer: accessIssuer(),
  });
}
