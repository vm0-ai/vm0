import { createHandler, tsr } from "../../../../../../src/lib/ts-rest-handler";
import { chatThreadArtifactsContract } from "@vm0/api-contracts/contracts/chat-threads";
import { createErrorResponse } from "@vm0/api-contracts/contracts/errors";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { initServices } from "../../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../../src/lib/auth/get-auth-context";
import { getChatThreadArtifacts } from "../../../../../../src/lib/zero/chat-thread";
import { loadFeatureSwitchOverrides } from "../../../../../../src/lib/zero/user/feature-switches-service";
import { isNotFound } from "@vm0/api-services/errors";

const router = tsr.router(chatThreadArtifactsContract, {
  list: async ({ params, headers }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const overrides = await loadFeatureSwitchOverrides(
      authCtx.orgId,
      authCtx.userId,
    );
    const enabled = isFeatureEnabled(FeatureSwitchKey.ChatArtifactsDrawer, {
      orgId: authCtx.orgId,
      userId: authCtx.userId,
      overrides,
    });
    if (!enabled) {
      return createErrorResponse("FORBIDDEN", "Chat artifacts are not enabled");
    }

    try {
      const runs = await getChatThreadArtifacts(
        params.threadId,
        authCtx.userId,
      );
      return { status: 200 as const, body: { runs } };
    } catch (error) {
      if (isNotFound(error)) {
        return createErrorResponse("NOT_FOUND", "Chat thread not found");
      }
      throw error;
    }
  },
});

const handler = createHandler(chatThreadArtifactsContract, router, {
  routeName: "zero.chat-threads.artifacts",
});

export { handler as GET };
