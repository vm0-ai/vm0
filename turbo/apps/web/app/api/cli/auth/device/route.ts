import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { cliAuthDeviceContract } from "@vm0/api-contracts/contracts/cli-auth";
import { initServices } from "../../../../../src/lib/init-services";
import { deviceCodes } from "@vm0/db/schema/device-codes";
import { generateCode } from "../../../../../src/lib/shared/crypto";

const router = tsr.router(cliAuthDeviceContract, {
  create: async () => {
    initServices();

    const deviceCode = generateCode();
    const expiresAt = new Date(Date.now() + 900 * 1000); // 15 minutes

    await globalThis.services.db.insert(deviceCodes).values({
      code: deviceCode,
      status: "pending",
      expiresAt,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return {
      status: 200 as const,
      body: {
        device_code: deviceCode,
        user_code: deviceCode,
        verification_path: "/cli-auth",
        expires_in: 900, // 15 minutes in seconds
        interval: 5, // Poll every 5 seconds
      },
    };
  },
});

const handler = createHandler(cliAuthDeviceContract, router, {
  routeName: "cli.auth.device",
});

export { handler as POST };
