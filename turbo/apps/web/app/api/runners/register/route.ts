import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { runnersRegisterContract, createErrorResponse } from "@vm0/core";
import { eq, and } from "drizzle-orm";
import { initServices } from "../../../../src/lib/init-services";
import { runners } from "../../../../src/db/schema/runner";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { logger } from "../../../../src/lib/logger";

const log = logger("api:runners:register");

// Force dynamic rendering to prevent any caching
export const dynamic = "force-dynamic";

const router = tsr.router(runnersRegisterContract, {
  register: async ({ body }) => {
    initServices();

    const userId = await getUserId();
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Authentication required");
    }

    const { name, group } = body;

    // Check if runner already exists for this user
    const [existingRunner] = await globalThis.services.db
      .select()
      .from(runners)
      .where(and(eq(runners.userId, userId), eq(runners.name, name)))
      .limit(1);

    if (existingRunner) {
      // Update existing runner
      const updatedRunners = await globalThis.services.db
        .update(runners)
        .set({
          runnerGroup: group,
          status: "online",
          lastHeartbeatAt: new Date(),
        })
        .where(eq(runners.id, existingRunner.id))
        .returning();

      const updatedRunner = updatedRunners[0];
      if (!updatedRunner) {
        return createErrorResponse(
          "INTERNAL_SERVER_ERROR",
          "Failed to update runner",
        );
      }

      log.debug("Updated existing runner", {
        runnerId: updatedRunner.id,
        name,
        group,
      });

      return {
        status: 200 as const,
        body: {
          id: updatedRunner.id,
          name: updatedRunner.name,
          group: updatedRunner.runnerGroup,
          status: updatedRunner.status as "online" | "offline" | "busy",
          lastHeartbeatAt: updatedRunner.lastHeartbeatAt?.toISOString() ?? null,
          createdAt: updatedRunner.createdAt.toISOString(),
        },
      };
    }

    // Create new runner
    const newRunners = await globalThis.services.db
      .insert(runners)
      .values({
        userId,
        name,
        runnerGroup: group,
        status: "online",
        lastHeartbeatAt: new Date(),
      })
      .returning();

    const newRunner = newRunners[0];
    if (!newRunner) {
      return createErrorResponse(
        "INTERNAL_SERVER_ERROR",
        "Failed to create runner",
      );
    }

    log.debug("Registered new runner", {
      runnerId: newRunner.id,
      name,
      group,
    });

    return {
      status: 201 as const,
      body: {
        id: newRunner.id,
        name: newRunner.name,
        group: newRunner.runnerGroup,
        status: newRunner.status as "online" | "offline" | "busy",
        lastHeartbeatAt: newRunner.lastHeartbeatAt?.toISOString() ?? null,
        createdAt: newRunner.createdAt.toISOString(),
      },
    };
  },
});

const handler = createHandler(runnersRegisterContract, router);

export { handler as POST };
