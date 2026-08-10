import { createRemoteJWKSet, jwtVerify } from "jose";

import { env } from "./env";
import { testOverride } from "./singleton";

const { get: getAccessJwks, set: setAccessJwks } = testOverride<
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

function accessJwks(): ReturnType<typeof createRemoteJWKSet> {
  const existing = getAccessJwks();
  if (existing) {
    return existing;
  }
  const created = createRemoteJWKSet(
    new URL(`${accessIssuer()}/cdn-cgi/access/certs`),
  );
  setAccessJwks(created);
  return created;
}

export async function verifyCloudflareAccessAssertion(
  assertion: string,
): Promise<void> {
  const audience = env("CF_ACCESS_AUD");
  if (!audience) {
    throw new Error("CF_ACCESS_AUD is required in Cloudflare Workers");
  }
  await jwtVerify(assertion, accessJwks(), {
    algorithms: ["RS256"],
    audience,
    issuer: accessIssuer(),
  });
}
