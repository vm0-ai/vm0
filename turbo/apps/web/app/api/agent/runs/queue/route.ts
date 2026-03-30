import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { runsQueueContract, orgTierSchema } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../src/lib/org/resolve-org";
import { getRunQueueStatus } from "../../../../../src/lib/zero/zero-queue-service";

const router = tsr.router(runsQueueContract, {
  getQueue: async ({ headers }, { request }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization, {
      acceptAnySandboxCapability: true,
    });
    if (!authCtx) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }
    const { userId } = authCtx;

    const orgSlug = new URL(request.url).searchParams.get("org");
    const { org } = await resolveOrg(authCtx, orgSlug);
    const orgTier = orgTierSchema.parse(org.tier);

    const result = await getRunQueueStatus(userId, org.orgId, orgTier);
    return { status: 200 as const, body: result };
  },
});

const handler = createHandler(runsQueueContract, router);

export { handler as GET };
