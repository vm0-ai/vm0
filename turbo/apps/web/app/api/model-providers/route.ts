import {
  createHandler,
  tsr,
  validationErrorHandler,
} from "../../../src/lib/ts-rest-handler";
import {
  modelProvidersMainContract,
  createErrorResponse,
  getCredentialNameForType,
} from "@vm0/core";
import { initServices } from "../../../src/lib/init-services";
import { getUserId } from "../../../src/lib/auth/get-user-id";
import {
  listModelProviders,
  upsertModelProvider,
} from "../../../src/lib/model-provider/model-provider-service";
import { logger } from "../../../src/lib/logger";
import { BadRequestError, ConflictError } from "../../../src/lib/errors";

const log = logger("api:model-providers");

const router = tsr.router(modelProvidersMainContract, {
  /**
   * GET /api/model-providers - List all model providers
   */
  list: async () => {
    initServices();

    const userId = await getUserId();
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const providers = await listModelProviders(userId);

    return {
      status: 200 as const,
      body: {
        modelProviders: providers.map((p) => ({
          id: p.id,
          type: p.type,
          framework: p.framework,
          credentialName: p.credentialName,
          isDefault: p.isDefault,
          createdAt: p.createdAt.toISOString(),
          updatedAt: p.updatedAt.toISOString(),
        })),
      },
    };
  },

  /**
   * PUT /api/model-providers - Create or update a model provider
   */
  upsert: async ({ body }) => {
    initServices();

    const userId = await getUserId();
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const { type, credential, convert } = body;

    log.debug("upserting model provider", { userId, type });

    try {
      const { provider, created } = await upsertModelProvider(
        userId,
        type,
        credential,
        convert,
      );

      return {
        status: (created ? 201 : 200) as 200 | 201,
        body: {
          provider: {
            id: provider.id,
            type: provider.type,
            framework: provider.framework,
            credentialName: provider.credentialName,
            isDefault: provider.isDefault,
            createdAt: provider.createdAt.toISOString(),
            updatedAt: provider.updatedAt.toISOString(),
          },
          created,
        },
      };
    } catch (error) {
      if (error instanceof BadRequestError) {
        return createErrorResponse("BAD_REQUEST", error.message);
      }
      if (error instanceof ConflictError) {
        return {
          status: 409 as const,
          body: {
            error: {
              message: error.message,
              code: "CONFLICT",
              credentialName: getCredentialNameForType(type),
            },
          },
        };
      }
      throw error;
    }
  },
});

const handler = createHandler(modelProvidersMainContract, router, {
  errorHandler: validationErrorHandler,
});

export { handler as GET, handler as PUT };
