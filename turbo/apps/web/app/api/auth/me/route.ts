import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { authContract } from "@vm0/core";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { getUserEmail } from "../../../../src/lib/auth/get-user-email";

const router = tsr.router(authContract, {
  me: async ({ headers }) => {
    const userId = await getUserId(headers.authorization);

    if (!userId) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Unauthorized", code: "UNAUTHORIZED" },
        },
      };
    }

    const email = await getUserEmail(userId);

    return {
      status: 200 as const,
      body: {
        userId,
        email,
      },
    };
  },
});

const handler = createHandler(authContract, router);

export { handler as GET };
