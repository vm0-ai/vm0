import { createNextHandler, tsr } from "@ts-rest/serverless/next";
import { cliAuthDeviceContract } from "@vm0/core";
import crypto from "crypto";
import { initServices } from "../../../../../src/lib/init-services";
import { deviceCodes } from "../../../../../src/db/schema/device-codes";

// Characters that are easy to read (excluding 0/O, 1/I/L)
const CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function generateDeviceCode(): string {
  const randomBytes = crypto.randomBytes(8);
  let code = "";

  for (let i = 0; i < 8; i++) {
    if (i === 4) code += "-";
    const byte = randomBytes[i];
    if (byte !== undefined) {
      code += CHARS[byte % CHARS.length];
    }
  }

  return code;
}

const router = tsr.router(cliAuthDeviceContract, {
  create: async () => {
    initServices();

    const deviceCode = generateDeviceCode();
    const expiresAt = new Date(Date.now() + 900 * 1000); // 15 minutes

    await globalThis.services.db.insert(deviceCodes).values({
      code: deviceCode,
      status: "pending",
      expiresAt,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Priority: NEXT_PUBLIC_APP_URL > VERCEL_URL (for preview deployments)
    const vercelUrl = process.env.VERCEL_URL;
    const baseUrl =
      process.env.NEXT_PUBLIC_APP_URL ||
      (vercelUrl ? `https://${vercelUrl}` : null);
    if (!baseUrl) {
      throw new Error(
        "NEXT_PUBLIC_APP_URL environment variable is not configured",
      );
    }

    return {
      status: 200 as const,
      body: {
        device_code: deviceCode,
        user_code: deviceCode,
        verification_url: `${baseUrl}/cli-auth`,
        expires_in: 900, // 15 minutes in seconds
        interval: 5, // Poll every 5 seconds
      },
    };
  },
});

const handler = createNextHandler(cliAuthDeviceContract, router, {
  handlerType: "app-router",
  jsonQuery: true,
});

export { handler as POST };
