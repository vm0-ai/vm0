import { createErrorResponse } from "@vm0/api-contracts/contracts/errors";
import type {
  ModelProviderType,
  ModelProviderFramework,
} from "@vm0/api-contracts/contracts/model-providers";

import {
  parseCodexAuthJson,
  isCodexAuthJsonShapeError,
  isCodexAuthJsonFreePlanError,
} from "./codex-auth-json-parser";
import { logger } from "../../lib/log";
import { throwIfAbort } from "../utils";

/**
 * Shape of an upserted provider row that the paste handler serializes into the
 * REST response. Subset of the internal `ModelProviderInfo` (drops `userId`,
 * `tokenExpiresAt`) — kept here so both org and personal routes share one DTO.
 */
interface UpsertedProvider {
  id: string;
  type: ModelProviderType;
  framework: ModelProviderFramework;
  secretName: string | null;
  authMethod?: string | null;
  secretNames?: string[] | null;
  isDefault: boolean;
  selectedModel: string | null;
  workspaceName: string | null;
  planType: string | null;
  needsReconnect: boolean;
  lastRefreshErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Serialize an upserted model-provider row into the REST DTO shape (Date →
 * ISO string). Shared between org and personal paste handlers so the wire
 * format cannot drift.
 */
function serializeUpsertedProvider(provider: UpsertedProvider) {
  return {
    id: provider.id,
    type: provider.type,
    framework: provider.framework,
    secretName: provider.secretName,
    authMethod: provider.authMethod ?? null,
    secretNames: provider.secretNames ?? null,
    isDefault: provider.isDefault,
    selectedModel: provider.selectedModel,
    workspaceName: provider.workspaceName,
    planType: provider.planType,
    needsReconnect: provider.needsReconnect,
    lastRefreshErrorCode: provider.lastRefreshErrorCode,
    createdAt: provider.createdAt.toISOString(),
    updatedAt: provider.updatedAt.toISOString(),
  };
}

/**
 * Caller-supplied upsert. Org route binds this to
 * `upsertOrgMultiAuthModelProvider`, personal route binds it to a closure
 * over `upsertUserMultiAuthModelProvider(orgId, userId, ...)`. Both signatures
 * normalize to the same shape from the handler's perspective.
 */
type UpsertCodexProvider = (args: {
  authMethod: "auth_json";
  secretValues: {
    CHATGPT_ACCESS_TOKEN: string;
    CHATGPT_REFRESH_TOKEN: string;
    CHATGPT_ACCOUNT_ID: string;
    CHATGPT_ID_TOKEN: string;
  };
  selectedModel: string | undefined;
  metadata: {
    tokenExpiresAt: Date | null;
    workspaceName: string | null;
    planType: string | null;
  };
}) => Promise<{ provider: UpsertedProvider; created: boolean }>;

/**
 * Common args shared by both scopes. Split out so the discriminated union
 * below can intersect each scope's identity fields onto the same payload
 * without repeating the paste-flow inputs.
 */
interface CodexAuthJsonPasteCommonArgs {
  rawAuthJson: string;
  selectedModel: string | undefined;
  upsert: UpsertCodexProvider;
}

/**
 * Discriminated union over the calling scope. The org variant carries only
 * `orgId`; the personal variant additionally requires `userId`. Encoded in
 * the type system (rather than as a doc-comment on a `userId?: string`) so
 * the personal call site cannot compile without a real userId.
 */
type CodexAuthJsonPasteArgs =
  | ({ scope: "org"; orgId: string } & CodexAuthJsonPasteCommonArgs)
  | ({
      scope: "personal";
      orgId: string;
      userId: string;
    } & CodexAuthJsonPasteCommonArgs);

/**
 * Handle the codex-oauth-token + auth_json paste-based connect flow.
 *
 * Parses the raw `~/.codex/auth.json` server-side and persists the four
 * derived `CHATGPT_*` fields via the caller-supplied upsert. The raw
 * `CODEX_AUTH_JSON` blob is NEVER persisted (per Epic #11974 / #7365).
 *
 * Shared implementation for API org and personal model-provider paste routes.
 */
export async function handleCodexAuthJsonPaste(args: CodexAuthJsonPasteArgs) {
  const log = logger(
    args.scope === "personal"
      ? "api:zero-me-model-providers"
      : "api:zero-model-providers",
  );
  const logContext =
    args.scope === "personal"
      ? { orgId: args.orgId, userId: args.userId }
      : { orgId: args.orgId };

  // eslint-disable-next-line no-restricted-syntax -- centralized try/catch for typed CodexAuthJsonShapeError / CodexAuthJsonFreePlanError narrowing; abort propagates via isAbortError check
  try {
    const parsed = parseCodexAuthJson(args.rawAuthJson);

    const { provider, created } = await args.upsert({
      authMethod: "auth_json",
      secretValues: {
        CHATGPT_ACCESS_TOKEN: parsed.accessToken,
        CHATGPT_REFRESH_TOKEN: parsed.refreshToken,
        CHATGPT_ACCOUNT_ID: parsed.accountId,
        CHATGPT_ID_TOKEN: parsed.idToken,
      },
      selectedModel: args.selectedModel,
      metadata: {
        tokenExpiresAt: parsed.tokenExpiresAt,
        workspaceName: parsed.workspaceName,
        planType: parsed.planType,
      },
    });

    log.debug(
      args.scope === "personal"
        ? "personal codex provider connected via auth_json paste"
        : "codex provider connected via auth_json paste",
      {
        ...logContext,
        workspaceName: parsed.workspaceName,
        planType: parsed.planType,
      },
    );

    return {
      status: (created ? 201 : 200) as 200 | 201,
      body: { provider: serializeUpsertedProvider(provider), created },
    };
  } catch (error) {
    throwIfAbort(error);
    if (isCodexAuthJsonFreePlanError(error)) {
      log.debug(
        args.scope === "personal"
          ? "rejected personal codex auth_json paste: free plan"
          : "rejected codex auth_json paste: free plan",
        logContext,
      );
      return createErrorResponse(
        "CODEX_FREE_PLAN_REJECTED",
        "ChatGPT free plan is not supported — upgrade to Plus or higher.",
      );
    }
    if (isCodexAuthJsonShapeError(error)) {
      log.warn(
        args.scope === "personal"
          ? "rejected personal codex auth_json paste: shape"
          : "rejected codex auth_json paste: shape",
        { ...logContext, errorMessage: error.message },
      );
      return createErrorResponse(
        "CODEX_AUTH_JSON_SHAPE_INVALID",
        error.message,
      );
    }
    throw error;
  }
}
