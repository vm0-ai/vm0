import { createHmac, hkdfSync } from "node:crypto";

import {
  ZERO_CAPABILITIES,
  ZeroCapability,
} from "@vm0/api-contracts/contracts/composes";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { z } from "zod";

import { env } from "../../lib/env";
import { now } from "../external/time";
import { safeJsonParse } from "../utils";
import {
  CliAuth,
  ComposeJobAuth,
  SandboxAuth,
  ZeroAuth,
} from "../../types/auth";
import { singleton } from "../../lib/singleton";

const SANDBOX_TOKEN_PREFIX = "vm0_sandbox_";
const PAT_TOKEN_PREFIX = "vm0_pat_";

const CONDITIONAL_CAPABILITIES = [
  ["computer-use:write", FeatureSwitchKey.ComputerUse],
  ["host:read", FeatureSwitchKey.HostedSites],
  ["host:write", FeatureSwitchKey.HostedSites],
  ["local-agent:read", FeatureSwitchKey.LocalAgentConnector],
  ["local-agent:write", FeatureSwitchKey.LocalAgentConnector],
  ["maps:read", FeatureSwitchKey.ZeroMaps],
] as const satisfies readonly (readonly [ZeroCapability, FeatureSwitchKey])[];

const AGENT_EXCLUDED_CAPABILITIES = [
  "schedule:delete",
  "agent-run:write",
  "agent:delete",
] as const satisfies readonly ZeroCapability[];

const jwtBaseSchema = z.object({
  userId: z.string().min(1),
  scope: z.string(),
  iat: z.number(),
  exp: z.number(),
});

const sandboxTokenPayloadSchema = jwtBaseSchema.extend({
  scope: z.literal("sandbox"),
  runId: z.string().min(1),
  orgId: z.string().min(1),
});

const zeroCapabilitySchema = z.custom<ZeroCapability>((value) => {
  return (
    typeof value === "string" &&
    ZERO_CAPABILITIES.some((capability) => {
      return capability === value;
    })
  );
});

const zeroTokenPayloadSchema = jwtBaseSchema.extend({
  scope: z.literal("zero"),
  runId: z.string().min(1),
  orgId: z.string().min(1),
  capabilities: z.array(zeroCapabilitySchema).readonly(),
});

const cliTokenPayloadSchema = jwtBaseSchema.extend({
  scope: z.literal("cli"),
  orgId: z.string().min(1),
  tokenId: z.string().min(1),
});

const composeJobTokenPayloadSchema = jwtBaseSchema.extend({
  scope: z.literal("compose-job"),
  jobId: z.string().min(1),
});

type JwtPayload =
  | z.infer<typeof sandboxTokenPayloadSchema>
  | z.infer<typeof zeroTokenPayloadSchema>
  | z.infer<typeof cliTokenPayloadSchema>
  | z.infer<typeof composeJobTokenPayloadSchema>;

function base64UrlEncode(data: Buffer | string): string {
  const buffer = typeof data === "string" ? Buffer.from(data) : data;
  return buffer.toString("base64url");
}

function base64UrlDecode(data: string): Buffer {
  return Buffer.from(data, "base64url");
}

function deriveJwtKey(): Buffer {
  const masterKey = Buffer.from(env("SECRETS_ENCRYPTION_KEY"), "hex");
  return Buffer.from(
    hkdfSync("sha256", masterKey, "", "jwt-sandbox-signing", 32),
  );
}

const getJwtKey = singleton((): Buffer => {
  return deriveJwtKey();
});

function signJwt(payload: JwtPayload): string {
  const header = { alg: "HS256", typ: "JWT" };
  const headerEncoded = base64UrlEncode(JSON.stringify(header));
  const payloadEncoded = base64UrlEncode(JSON.stringify(payload));
  const data = `${headerEncoded}.${payloadEncoded}`;
  const signature = createHmac("sha256", getJwtKey()).update(data).digest();
  return `${data}.${base64UrlEncode(signature)}`;
}

function verifyJwtPayload(rawJwt: string): unknown {
  const parts = rawJwt.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const [headerEncoded, payloadEncoded, signatureEncoded] = parts;
  if (!headerEncoded || !payloadEncoded || !signatureEncoded) {
    return null;
  }

  const data = `${headerEncoded}.${payloadEncoded}`;
  const expectedSignature = createHmac("sha256", getJwtKey())
    .update(data)
    .digest();
  const actualSignature = base64UrlDecode(signatureEncoded);

  if (
    expectedSignature.length !== actualSignature.length ||
    !expectedSignature.equals(actualSignature)
  ) {
    return null;
  }

  const parsed = safeJsonParse(base64UrlDecode(payloadEncoded).toString());
  if (parsed === undefined) {
    return null;
  }

  const base = jwtBaseSchema.safeParse(parsed);
  if (!base.success || base.data.exp < Math.floor(now() / 1000)) {
    return null;
  }
  return parsed;
}

function verifyPrefixedToken(token: string, prefix: string): unknown {
  if (!token.startsWith(prefix)) {
    return null;
  }

  return verifyJwtPayload(token.slice(prefix.length));
}

export function isSandboxToken(token: string): boolean {
  return token.startsWith(SANDBOX_TOKEN_PREFIX);
}

export function isPatToken(token: string): boolean {
  return token.startsWith(PAT_TOKEN_PREFIX);
}

export function verifySandboxToken(token: string): SandboxAuth | null {
  const parsed = sandboxTokenPayloadSchema.safeParse(
    verifyPrefixedToken(token, SANDBOX_TOKEN_PREFIX),
  );

  if (!parsed.success) {
    return null;
  }

  return {
    userId: parsed.data.userId,
    runId: parsed.data.runId,
    orgId: parsed.data.orgId,
  };
}

export function verifyZeroToken(token: string): ZeroAuth | null {
  const parsed = zeroTokenPayloadSchema.safeParse(
    verifyPrefixedToken(token, SANDBOX_TOKEN_PREFIX),
  );

  if (!parsed.success) {
    return null;
  }

  return {
    userId: parsed.data.userId,
    runId: parsed.data.runId,
    orgId: parsed.data.orgId,
    capabilities: parsed.data.capabilities,
  };
}

export function verifyComposeJobToken(token: string): ComposeJobAuth | null {
  const parsed = composeJobTokenPayloadSchema.safeParse(
    verifyPrefixedToken(token, SANDBOX_TOKEN_PREFIX),
  );

  if (!parsed.success) {
    return null;
  }

  return {
    userId: parsed.data.userId,
    jobId: parsed.data.jobId,
  };
}

export function verifyCliToken(token: string): CliAuth | null {
  const parsed = cliTokenPayloadSchema.safeParse(
    verifyPrefixedToken(token, PAT_TOKEN_PREFIX),
  );

  if (!parsed.success) {
    return null;
  }

  return {
    userId: parsed.data.userId,
    orgId: parsed.data.orgId,
    tokenId: parsed.data.tokenId,
  };
}

export function generateSandboxToken(
  userId: string,
  runId: string,
  orgId: string,
): string {
  const nowSeconds = Math.floor(now() / 1000);
  const payload: z.infer<typeof sandboxTokenPayloadSchema> = {
    scope: "sandbox",
    userId,
    runId,
    orgId,
    iat: nowSeconds,
    exp: nowSeconds + 2 * 60 * 60,
  };

  return SANDBOX_TOKEN_PREFIX + signJwt(payload);
}

export function generateZeroToken(
  userId: string,
  runId: string,
  orgId: string,
  overrides?: Partial<Record<FeatureSwitchKey, boolean>>,
): string {
  const nowSeconds = Math.floor(now() / 1000);
  const capabilities: ZeroCapability[] = [];
  for (const capability of ZERO_CAPABILITIES) {
    if (
      AGENT_EXCLUDED_CAPABILITIES.some((excludedCapability) => {
        return excludedCapability === capability;
      })
    ) {
      continue;
    }
    const conditionalCapability = CONDITIONAL_CAPABILITIES.find((entry) => {
      return entry[0] === capability;
    });
    const flag = conditionalCapability?.[1];
    if (
      flag === undefined ||
      isFeatureEnabled(flag, { userId, orgId, overrides })
    ) {
      capabilities.push(capability);
    }
  }

  const payload: z.infer<typeof zeroTokenPayloadSchema> = {
    scope: "zero",
    userId,
    runId,
    orgId,
    capabilities,
    iat: nowSeconds,
    exp: nowSeconds + 2 * 60 * 60,
  };

  return SANDBOX_TOKEN_PREFIX + signJwt(payload);
}

export function generateCliToken(
  userId: string,
  orgId: string,
  tokenId: string,
): string {
  const nowSeconds = Math.floor(now() / 1000);
  const payload: z.infer<typeof cliTokenPayloadSchema> = {
    scope: "cli",
    userId,
    orgId,
    tokenId,
    iat: nowSeconds,
    exp: nowSeconds + 90 * 24 * 60 * 60,
  };

  return PAT_TOKEN_PREFIX + signJwt(payload);
}

export function signSandboxJwtForTests(payload: JwtPayload): string {
  return SANDBOX_TOKEN_PREFIX + signJwt(payload);
}

export function signPatJwtForTests(
  payload: z.infer<typeof cliTokenPayloadSchema>,
): string {
  return PAT_TOKEN_PREFIX + signJwt(payload);
}
