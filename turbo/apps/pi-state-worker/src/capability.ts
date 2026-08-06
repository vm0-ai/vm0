import { isNonEmptyString, isRecord, isStringArray } from "./guards";

interface CapabilityClaims {
  readonly threadKey: string;
  readonly runId: string;
  readonly scopes: readonly string[];
}

const TOKEN_ISSUER = "vm0-api";
const TOKEN_AUDIENCE = "vm0-pi-state";
const MAX_TOKEN_LIFETIME_SECONDS = 7200;

let cachedVerificationKey: {
  readonly pem: string;
  readonly key: CryptoKey;
} | null = null;

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> | null {
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const padding = (4 - (normalized.length % 4)) % 4;
  let binary: string;
  try {
    binary = atob(normalized + "=".repeat(padding));
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function decodeJsonSegment(segment: string): unknown {
  const bytes = base64UrlToBytes(segment);
  if (!bytes) {
    return undefined;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

async function importVerificationKey(publicKeyPem: string): Promise<CryptoKey> {
  if (cachedVerificationKey && cachedVerificationKey.pem === publicKeyPem) {
    return cachedVerificationKey.key;
  }
  const base64 = publicKeyPem
    .replace("-----BEGIN PUBLIC KEY-----", "")
    .replace("-----END PUBLIC KEY-----", "")
    .replace(/\s/gu, "");
  const der = base64UrlToBytes(base64);
  if (!der) {
    throw new Error("TOKEN_PUBLIC_KEY is not a valid PEM public key");
  }
  const key = await crypto.subtle.importKey(
    "spki",
    der,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  cachedVerificationKey = { pem: publicKeyPem, key };
  return key;
}

function parseTokenPayload(
  payload: unknown,
  nowSeconds: number,
): CapabilityClaims | null {
  if (!isRecord(payload)) {
    return null;
  }
  if (payload.iss !== TOKEN_ISSUER || payload.aud !== TOKEN_AUDIENCE) {
    return null;
  }
  if (!isNonEmptyString(payload.sub) || !isNonEmptyString(payload.runId)) {
    return null;
  }
  if (!isStringArray(payload.scopes)) {
    return null;
  }
  const { iat, exp, nbf } = payload;
  if (typeof iat !== "number" || typeof exp !== "number") {
    return null;
  }
  if (exp <= nowSeconds) {
    return null;
  }
  if (nbf !== undefined && (typeof nbf !== "number" || nbf > nowSeconds)) {
    return null;
  }
  if (exp - iat > MAX_TOKEN_LIFETIME_SECONDS) {
    return null;
  }
  return {
    threadKey: payload.sub,
    runId: payload.runId,
    scopes: payload.scopes,
  };
}

export async function verifyCapabilityToken(
  token: string,
  publicKeyPem: string,
  nowSeconds: number,
): Promise<CapabilityClaims | null> {
  const segments = token.split(".");
  if (segments.length !== 3) {
    return null;
  }
  const [headerSegment, payloadSegment, signatureSegment] = segments;
  if (!headerSegment || !payloadSegment || !signatureSegment) {
    return null;
  }
  const header = decodeJsonSegment(headerSegment);
  if (!isRecord(header) || header.alg !== "ES256") {
    return null;
  }
  const signature = base64UrlToBytes(signatureSegment);
  if (!signature) {
    return null;
  }
  const key = await importVerificationKey(publicKeyPem);
  const signedData = new TextEncoder().encode(
    `${headerSegment}.${payloadSegment}`,
  );
  const validSignature = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    signature,
    signedData,
  );
  if (!validSignature) {
    return null;
  }
  return parseTokenPayload(decodeJsonSegment(payloadSegment), nowSeconds);
}
