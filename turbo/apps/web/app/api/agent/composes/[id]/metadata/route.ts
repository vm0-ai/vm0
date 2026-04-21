/**
 * PATCH /api/agent/composes/:id/metadata
 *
 * Update agent metadata (displayName, description, sound) directly
 * without triggering a compose job.
 */
import { createHandler, tsr } from "../../../../../../src/lib/ts-rest-handler";
import { composesMetadataContract } from "@vm0/core";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../../src/lib/zero/org/resolve-org";
import { updateComposeMetadata } from "../../../../../../src/lib/zero/zero-compose-service";
import { isNotFound } from "../../../../../../src/lib/shared/errors";

const router = tsr.router(composesMetadataContract, {
  updateMetadata: async ({ params, body, headers }) => {
    initServices();

    const authResult = await requireAuth(headers.authorization, {
      acceptAnySandboxCapability: true,
    });
    if (isAuthError(authResult)) return authResult;
    const { userId } = authResult;

    const { org } = await resolveOrg(authResult);

    try {
      await updateComposeMetadata(params.id, userId, org.orgId, body);
      return { status: 200 as const, body: { ok: true as const } };
    } catch (error) {
      if (isNotFound(error)) {
        return {
          status: 404 as const,
          body: {
            error: { message: error.message, code: "NOT_FOUND" },
          },
        };
      }
      throw error;
    }
  },
});

const handler = createHandler(composesMetadataContract, router, {
  routeName: "agent.composes.metadata",
});

export { handler as PATCH };
