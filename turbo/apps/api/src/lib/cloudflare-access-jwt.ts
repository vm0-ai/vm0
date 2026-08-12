import { createLocalJWKSet, createRemoteJWKSet, errors, jwtVerify } from "jose";
import { z } from "zod";

import { settle } from "../signals/utils";

import { env } from "./env";
import { testOverride } from "./singleton";

const REMOTE_JWKS_TIMEOUT_MS = 15_000;
const ACCESS_JWT_CLOCK_TOLERANCE_SECONDS = 60;

const accessJwksSchema = z.object({
  keys: z
    .array(
      z.object({
        kty: z.literal("RSA"),
        alg: z.literal("RS256"),
        use: z.literal("sig"),
        kid: z.string().min(1),
        e: z.string().min(1),
        n: z.string().min(1),
      }),
    )
    .min(1),
});

const { get: getLocalAccessJwks, set: setLocalAccessJwks } = testOverride<
  ReturnType<typeof createLocalJWKSet> | undefined
>(() => {
  return undefined;
});

const { get: getRemoteAccessJwks, set: setRemoteAccessJwks } = testOverride<
  ReturnType<typeof createRemoteJWKSet> | undefined
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

function localAccessJwks(): ReturnType<typeof createLocalJWKSet> | undefined {
  const existing = getLocalAccessJwks();
  if (existing) {
    return existing;
  }
  const configured = env("CF_ACCESS_JWKS");
  if (!configured) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(configured);
  const created = createLocalJWKSet(accessJwksSchema.parse(parsed));
  setLocalAccessJwks(created);
  return created;
}

function remoteAccessJwks(): ReturnType<typeof createRemoteJWKSet> {
  const existing = getRemoteAccessJwks();
  if (existing) {
    return existing;
  }
  const created = createRemoteJWKSet(
    new URL(`${accessIssuer()}/cdn-cgi/access/certs`),
    { timeoutDuration: REMOTE_JWKS_TIMEOUT_MS },
  );
  setRemoteAccessJwks(created);
  return created;
}

export async function verifyCloudflareAccessAssertion(
  assertion: string,
): Promise<void> {
  const audience = env("CF_ACCESS_AUD");
  if (!audience) {
    throw new Error("CF_ACCESS_AUD is required in Cloudflare Workers");
  }
  const options = {
    algorithms: ["RS256"],
    audience,
    clockTolerance: ACCESS_JWT_CLOCK_TOLERANCE_SECONDS,
    issuer: accessIssuer(),
  };
  const localJwks = localAccessJwks();
  if (localJwks) {
    const verified = await settle(jwtVerify(assertion, localJwks, options));
    if (verified.ok) {
      return;
    }
    if (!(verified.error instanceof errors.JWKSNoMatchingKey)) {
      throw verified.error;
    }
  }
  await jwtVerify(assertion, remoteAccessJwks(), options);
}
