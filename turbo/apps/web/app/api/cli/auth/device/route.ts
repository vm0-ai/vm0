import { NextResponse } from "next/server";
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

export async function POST(): Promise<NextResponse> {
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

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

  return NextResponse.json({
    device_code: deviceCode,
    user_code: deviceCode,
    verification_url: `${baseUrl}/cli-auth`,
    expires_in: 900, // 15 minutes in seconds
    interval: 5, // Poll every 5 seconds
  });
}
