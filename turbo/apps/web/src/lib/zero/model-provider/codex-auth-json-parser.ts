import { z } from "zod";

/**
 * Server-side parser for the contents of `~/.codex/auth.json` produced by
 * `codex login`. Validates shape via zod, decodes the access_token + id_token
 * JWTs to derive `tokenExpiresAt`, `accountId`, `planType`, and
 * `workspaceName`, and rejects free-plan accounts with a typed error.
 *
 * The raw `CODEX_AUTH_JSON` blob this parser consumes is NEVER persisted —
 * the route handler discards it after parsing and only the four derived
 * `CHATGPT_*` fields are stored as secrets (per #7365 / Epic #11974).
 *
 * The JWT/claims helpers and zod schemas below are intentionally inlined
 * here (rather than imported from connector/providers/codex-oauth.ts) so that
 * #11979's deletion of the OAuth-flow code can drop those duplicates without
 * a cross-PR coupling. This file owns its dependencies.
 */

// JWT payload decode without signature verification: the access_token and
// id_token are validated cryptographically by the upstream ChatGPT backend
// and the user's TLS-secured `codex login` flow. Codex CLI itself does not
// verify locally either.
function decodeJwtPayload(token: string): unknown {
  const parts = token.split(".");
  const payload = parts[1];
  if (parts.length !== 3 || !payload) {
    throw new Error("Invalid JWT structure");
  }
  const padded = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padding =
    padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const json = Buffer.from(padded + padding, "base64").toString("utf-8");
  return JSON.parse(json);
}

const chatgptAuthClaimsSchema = z
  .object({
    chatgpt_account_id: z.string().optional(),
    chatgpt_plan_type: z.string().optional(),
    organization: z
      .object({ title: z.string().optional() })
      .partial()
      .optional(),
    workspace: z.object({ name: z.string().optional() }).partial().optional(),
    chatgpt_workspace_name: z.string().optional(),
  })
  .passthrough();

const chatgptIdTokenClaimsSchema = z
  .object({
    exp: z.number().optional(),
    "https://api.openai.com/auth": chatgptAuthClaimsSchema.optional(),
  })
  .passthrough();

type ChatgptAuthClaims = z.infer<typeof chatgptAuthClaimsSchema>;

function extractWorkspaceName(authClaims: ChatgptAuthClaims): string | null {
  return (
    authClaims.organization?.title ??
    authClaims.workspace?.name ??
    authClaims.chatgpt_workspace_name ??
    null
  );
}

const MAX_AUTH_JSON_BYTES = 16 * 1024;

const codexAuthJsonSchema = z
  .object({
    tokens: z.object({
      access_token: z.string().min(1),
      refresh_token: z.string().min(1),
      account_id: z.string().min(1),
      id_token: z.string().min(1),
    }),
  })
  .passthrough();

const expSchema = z.object({ exp: z.number() }).passthrough();

/**
 * Typed error thrown when the pasted auth.json is malformed JSON, fails the
 * shape schema, or omits required claims. Matches the project pattern
 * (Error with `name`-tagged narrowing) from `codex-oauth.ts`. Not exported —
 * callers narrow via the `isCodexAuthJsonShapeError` type guard.
 */
interface CodexAuthJsonShapeError extends Error {
  readonly name: "CodexAuthJsonShapeError";
}

interface CodexAuthJsonFreePlanError extends Error {
  readonly name: "CodexAuthJsonFreePlanError";
}

function createCodexAuthJsonShapeError(
  message: string,
): CodexAuthJsonShapeError {
  const err = new Error(message);
  err.name = "CodexAuthJsonShapeError";
  return err as CodexAuthJsonShapeError;
}

function createCodexAuthJsonFreePlanError(): CodexAuthJsonFreePlanError {
  const err = new Error(
    "ChatGPT free plan is not supported — upgrade to Plus, Pro, Business, Edu, or Enterprise",
  );
  err.name = "CodexAuthJsonFreePlanError";
  return err as CodexAuthJsonFreePlanError;
}

export function isCodexAuthJsonShapeError(
  v: unknown,
): v is CodexAuthJsonShapeError {
  return v instanceof Error && v.name === "CodexAuthJsonShapeError";
}

export function isCodexAuthJsonFreePlanError(
  v: unknown,
): v is CodexAuthJsonFreePlanError {
  return v instanceof Error && v.name === "CodexAuthJsonFreePlanError";
}

interface ParsedCodexAuth {
  accessToken: string;
  refreshToken: string;
  /**
   * Always sourced from `id_token`'s `chatgpt_account_id` claim — NOT from the
   * plain `tokens.account_id` field. The id_token claim is cryptographically
   * tied to the upstream session; the plain JSON field is informational.
   */
  accountId: string;
  idToken: string;
  tokenExpiresAt: Date;
  workspaceName: string | null;
  planType: string;
}

function readJwtExp(token: string): number | null {
  let payload: unknown;
  try {
    payload = decodeJwtPayload(token);
  } catch {
    return null;
  }
  const parsed = expSchema.safeParse(payload);
  return parsed.success ? parsed.data.exp : null;
}

export function parseCodexAuthJson(raw: string): ParsedCodexAuth {
  if (raw.length > MAX_AUTH_JSON_BYTES) {
    throw createCodexAuthJsonShapeError(
      "auth.json is unexpectedly large — paste only the contents of ~/.codex/auth.json",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw createCodexAuthJsonShapeError("auth.json is not valid JSON");
  }

  const shape = codexAuthJsonSchema.safeParse(parsed);
  if (!shape.success) {
    throw createCodexAuthJsonShapeError(
      "auth.json shape unrecognized — your codex CLI may need updating",
    );
  }
  const { tokens } = shape.data;

  // Decode id_token first — its claims drive both account_id (cryptographically
  // signed source of truth) and the plan-type rejection. Match the OAuth
  // callback's ordering: shape errors win over free-plan errors.
  let idClaims: z.infer<typeof chatgptIdTokenClaimsSchema>;
  try {
    idClaims = chatgptIdTokenClaimsSchema.parse(
      decodeJwtPayload(tokens.id_token),
    );
  } catch {
    throw createCodexAuthJsonShapeError("auth.json id_token claims unparsable");
  }
  const auth = idClaims["https://api.openai.com/auth"];
  if (!auth?.chatgpt_account_id || !auth.chatgpt_plan_type) {
    throw createCodexAuthJsonShapeError(
      "auth.json id_token missing required claims",
    );
  }
  if (auth.chatgpt_plan_type === "free") {
    throw createCodexAuthJsonFreePlanError();
  }

  // tokenExpiresAt: prefer access_token.exp (the artifact that actually expires
  // for inference), fall back to id_token.exp if the access_token is opaque.
  const tokenExp = readJwtExp(tokens.access_token) ?? idClaims.exp ?? null;
  if (tokenExp === null) {
    throw createCodexAuthJsonShapeError(
      "auth.json access_token has no exp claim",
    );
  }

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    accountId: auth.chatgpt_account_id,
    idToken: tokens.id_token,
    tokenExpiresAt: new Date(tokenExp * 1000),
    workspaceName: extractWorkspaceName(auth),
    planType: auth.chatgpt_plan_type,
  };
}
