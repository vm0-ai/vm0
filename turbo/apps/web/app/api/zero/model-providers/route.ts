import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../src/lib/ts-rest-handler";
import {
  zeroModelProvidersMainContract,
  orgModelProvidersMainContract,
  createErrorResponse,
  hasAuthMethods,
  VM0_ORG_SLUG,
  type ModelProviderType,
} from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../src/lib/org/resolve-org";
import {
  listOrgModelProviders,
  upsertOrgModelProvider,
  upsertOrgMultiAuthModelProvider,
  upsertOrgNoSecretModelProvider,
} from "../../../../src/lib/model-provider/model-provider-service";
import { logger } from "../../../../src/lib/logger";
import { isBadRequest } from "../../../../src/lib/errors";

const log = logger("api:zero-model-providers");

/** Shared list implementation used by both new and legacy contracts. */
async function handleList(authorization: string | undefined, request: Request) {
  initServices();

  const authCtx = await requireAuth(authorization);
  if (isAuthError(authCtx)) return authCtx;

  const orgSlug = new URL(request.url).searchParams.get("org");
  const { org } = await resolveOrg(authCtx, orgSlug);
  const providers = await listOrgModelProviders(org.orgId);

  return {
    status: 200 as const,
    body: {
      modelProviders: providers.map((p) => ({
        id: p.id,
        type: p.type,
        framework: p.framework,
        secretName: p.secretName,
        authMethod: p.authMethod ?? null,
        secretNames: p.secretNames ?? null,
        isDefault: p.isDefault,
        selectedModel: p.selectedModel,
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
      })),
    },
  };
}

/** Shared upsert implementation used by both new and legacy contracts. */
async function handleUpsert(
  authorization: string | undefined,
  request: Request,
  body: {
    type: ModelProviderType;
    secret?: string;
    authMethod?: string;
    secrets?: Record<string, string>;
    selectedModel?: string;
  },
) {
  initServices();

  const authCtx = await requireAuth(authorization);
  if (isAuthError(authCtx)) return authCtx;

  const orgSlug = new URL(request.url).searchParams.get("org");
  const { org, member } = await resolveOrg(authCtx, orgSlug);

  if (member.role !== "admin") {
    return createErrorResponse(
      "FORBIDDEN",
      "Only admins can manage org model providers",
    );
  }

  const { type, secret, authMethod, secrets, selectedModel } = body;

  log.debug("upserting org model provider", {
    orgId: org.orgId,
    type,
    selectedModel,
  });

  try {
    let provider;
    let created: boolean;

    if (type === "vm0") {
      if (org.slug !== VM0_ORG_SLUG) {
        return createErrorResponse(
          "FORBIDDEN",
          "VM0 managed provider is only available to the vm0 org",
        );
      }
      const result = await upsertOrgNoSecretModelProvider(
        org.orgId,
        type,
        selectedModel,
      );
      provider = result.provider;
      created = result.created;
    } else if (hasAuthMethods(type)) {
      if (!authMethod || !secrets) {
        return createErrorResponse(
          "BAD_REQUEST",
          `Provider "${type}" requires authMethod and secrets`,
        );
      }
      const result = await upsertOrgMultiAuthModelProvider(
        org.orgId,
        type,
        authMethod,
        secrets,
        selectedModel,
      );
      provider = result.provider;
      created = result.created;
    } else {
      if (!secret) {
        return createErrorResponse(
          "BAD_REQUEST",
          `Provider "${type}" requires a secret`,
        );
      }
      const result = await upsertOrgModelProvider(
        org.orgId,
        type,
        secret,
        selectedModel,
      );
      provider = result.provider;
      created = result.created;
    }

    return {
      status: (created ? 201 : 200) as 200 | 201,
      body: {
        provider: {
          id: provider.id,
          type: provider.type,
          framework: provider.framework,
          secretName: provider.secretName,
          authMethod: provider.authMethod ?? null,
          secretNames: provider.secretNames ?? null,
          isDefault: provider.isDefault,
          selectedModel: provider.selectedModel,
          createdAt: provider.createdAt.toISOString(),
          updatedAt: provider.updatedAt.toISOString(),
        },
        created,
      },
    };
  } catch (error) {
    if (isBadRequest(error)) {
      return createErrorResponse("BAD_REQUEST", "Invalid request");
    }
    throw error;
  }
}

// Primary handler for the new zero contract (GET + POST)
const router = tsr.router(zeroModelProvidersMainContract, {
  list: async ({ headers }, { request }) =>
    handleList(headers.authorization, request),
  upsert: async ({ body, headers }, { request }) =>
    handleUpsert(headers.authorization, request, body),
});

const handler = createHandler(zeroModelProvidersMainContract, router, {
  errorHandler: createSafeErrorHandler("zero-model-providers"),
});

// Backward-compatible PUT handler: the old CLI contract uses PUT for upsert,
// and next.config.js rewrites /api/org/model-providers → this route.
// We register a separate handler using the old contract which expects PUT.
const legacyRouter = tsr.router(orgModelProvidersMainContract, {
  list: async ({ headers }, { request }) =>
    handleList(headers.authorization, request),
  upsert: async ({ body, headers }, { request }) =>
    handleUpsert(headers.authorization, request, body),
});

const legacyHandler = createHandler(
  orgModelProvidersMainContract,
  legacyRouter,
  {
    errorHandler: createSafeErrorHandler("zero-model-providers-legacy"),
  },
);

export { handler as GET, handler as POST, legacyHandler as PUT };
