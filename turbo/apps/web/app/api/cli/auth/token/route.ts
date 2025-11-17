import { NextResponse } from "next/server";
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { deviceCodes } from "../../../../../src/db/schema/device-codes";
import { cliTokens } from "../../../../../src/db/schema/cli-tokens";

interface TokenRequest {
  device_code: string;
}

export async function POST(request: Request): Promise<NextResponse> {
  initServices();

  const body = (await request.json()) as TokenRequest;
  const { device_code } = body;

  if (!device_code) {
    return NextResponse.json(
      {
        error: "invalid_request",
        error_description: "device_code is required",
      },
      { status: 400 },
    );
  }

  const [session] = await globalThis.services.db
    .select()
    .from(deviceCodes)
    .where(eq(deviceCodes.code, device_code))
    .limit(1);

  if (!session) {
    return NextResponse.json(
      {
        error: "invalid_request",
        error_description: "Invalid device code",
      },
      { status: 400 },
    );
  }

  // Check if expired
  if (new Date() > session.expiresAt) {
    return NextResponse.json(
      {
        error: "expired_token",
        error_description: "The device code has expired",
      },
      { status: 400 },
    );
  }

  // Check status
  switch (session.status) {
    case "pending":
      return NextResponse.json(
        {
          error: "authorization_pending",
          error_description:
            "The user has not yet completed authorization in the browser",
        },
        { status: 202 },
      );

    case "denied":
      // Clean up
      await globalThis.services.db
        .delete(deviceCodes)
        .where(eq(deviceCodes.code, device_code));

      return NextResponse.json(
        {
          error: "access_denied",
          error_description: "The user denied the authorization request",
        },
        { status: 400 },
      );

    case "authenticated": {
      // Generate CLI token
      const randomBytes = crypto.randomBytes(32);
      const cliToken = `vm0_live_${randomBytes.toString("base64url")}`;
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000); // 90 days

      await globalThis.services.db.insert(cliTokens).values({
        token: cliToken,
        userId: session.userId as string,
        name: "CLI Device Flow Authentication",
        expiresAt,
        createdAt: now,
      });

      // Clean up device code
      await globalThis.services.db
        .delete(deviceCodes)
        .where(eq(deviceCodes.code, device_code));

      return NextResponse.json({
        access_token: cliToken,
        refresh_token: `refresh_${crypto.randomBytes(16).toString("hex")}`,
        token_type: "Bearer",
        expires_in: 90 * 24 * 60 * 60, // 90 days in seconds
      });
    }

    default:
      return NextResponse.json(
        {
          error: "server_error",
          error_description: "Unknown device code status",
        },
        { status: 500 },
      );
  }
}
