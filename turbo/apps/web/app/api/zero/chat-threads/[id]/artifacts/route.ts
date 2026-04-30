import { createHandler, tsr } from "../../../../../../src/lib/ts-rest-handler";
import { chatThreadArtifactsContract } from "@vm0/api-contracts/contracts/chat-threads";
import { createErrorResponse } from "@vm0/api-contracts/contracts/errors";
import { initServices } from "../../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../../src/lib/auth/get-auth-context";
import { getChatThreadArtifacts } from "../../../../../../src/lib/zero/chat-thread";
import {
  resolveOrg,
  resolveOrgOrNull,
} from "../../../../../../src/lib/zero/org/resolve-org";
import {
  applyGoogleDriveArtifactSyncStatuses,
  getGoogleDriveArtifactStatusLookup,
  syncArtifactToGoogleDrive,
} from "../../../../../../src/lib/zero/chat-thread/artifact-google-drive-sync";
import {
  isBadRequest,
  isForbidden,
  isNotFound,
} from "@vm0/api-services/errors";

const router = tsr.router(chatThreadArtifactsContract, {
  list: async ({ params, headers }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const googleDriveStatusLookup = resolveOrgOrNull(authCtx).then(
      async (org) => {
        return org
          ? await getGoogleDriveArtifactStatusLookup({
              threadId: params.threadId,
              orgId: org.orgId,
              userId: authCtx.userId,
            })
          : { type: "disconnected" as const };
      },
      () => {
        return { type: "disconnected" as const };
      },
    );

    try {
      const runs = await getChatThreadArtifacts(
        params.threadId,
        authCtx.userId,
      );
      return {
        status: 200 as const,
        body: {
          runs: applyGoogleDriveArtifactSyncStatuses(
            runs,
            await googleDriveStatusLookup,
          ),
        },
      };
    } catch (error) {
      if (isNotFound(error)) {
        return createErrorResponse("NOT_FOUND", "Chat thread not found");
      }
      throw error;
    }
  },
  syncGoogleDrive: async ({ params, body, headers }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    try {
      const { org } = await resolveOrg(authCtx);
      const result = await syncArtifactToGoogleDrive({
        threadId: params.threadId,
        runId: body.runId,
        fileId: body.fileId,
        orgId: org.orgId,
        userId: authCtx.userId,
      });
      return { status: 200 as const, body: result };
    } catch (error) {
      if (isNotFound(error)) {
        return createErrorResponse("NOT_FOUND", error.message);
      }
      if (isBadRequest(error)) {
        return createErrorResponse("BAD_REQUEST", error.message);
      }
      if (isForbidden(error)) {
        return createErrorResponse("FORBIDDEN", error.message);
      }
      throw error;
    }
  },
});

const handler = createHandler(chatThreadArtifactsContract, router, {
  routeName: "zero.chat-threads.artifacts",
});

export { handler as GET, handler as POST };
