import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { authContract } from "@vm0/core";
import { getAuthContext } from "../../../../src/lib/auth/get-user-id";
import { getUserEmail } from "../../../../src/lib/auth/get-user-email";

const router = tsr.router(authContract, {
  me: async ({ headers }) => {
    const authCtx = await getAuthContext(headers.authorization, {
      acceptAnySandboxCapability: true,
    });

    if (!authCtx) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Unauthorized", code: "UNAUTHORIZED" },
        },
      };
    }

    const email = await getUserEmail(authCtx.userId);

    return {
      status: 200 as const,
      body: {
        userId: authCtx.userId,
        email,
      },
    };
  },
});

const handler = createHandler(authContract, router);

export { handler as GET };
