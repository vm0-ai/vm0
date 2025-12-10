import { createNextHandler, tsr } from "@ts-rest/serverless/next";
import { authContract } from "@vm0/core";
import { clerkClient } from "@clerk/nextjs/server";
import { getUserId } from "../../../../src/lib/auth/get-user-id";

const router = tsr.router(authContract, {
  me: async () => {
    const userId = await getUserId();

    if (!userId) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Unauthorized", code: "UNAUTHORIZED" },
        },
      };
    }

    try {
      const client = await clerkClient();
      const user = await client.users.getUser(userId);

      if (!user) {
        return {
          status: 404 as const,
          body: {
            error: { message: "User not found", code: "NOT_FOUND" },
          },
        };
      }

      const email = user.emailAddresses.find(
        (e) => e.id === user.primaryEmailAddressId,
      )?.emailAddress;

      return {
        status: 200 as const,
        body: {
          userId: user.id,
          email: email || "",
        },
      };
    } catch (error) {
      console.error("Failed to get user info:", error);
      return {
        status: 500 as const,
        body: {
          error: { message: "Internal server error", code: "INTERNAL_ERROR" },
        },
      };
    }
  },
});

const handler = createNextHandler(authContract, router, {
  handlerType: "app-router",
  jsonQuery: true,
});

export { handler as GET };
