import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { authContract } from "@vm0/core";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { getUserEmail } from "../../../../src/lib/auth/get-user-email";

const router = tsr.router(authContract, {
  me: async ({ headers }) => {
    const authCtx = await requireAuth(headers.authorization, {
      acceptAnySandboxCapability: true,
    });
    if (isAuthError(authCtx)) return authCtx;

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

const handler = createHandler(authContract, router, {
  routeName: "auth.me",
});

export { handler as GET };
