import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { initServices } from "../../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../../src/lib/zero/org/resolve-org";
import { sendVerificationCode } from "../../../../../../src/lib/zero/phone/phone-verify-service";
import { logger } from "../../../../../../src/lib/shared/logger";

const log = logger("api:phone:verify:send");

const sendSchema = z.object({
  phoneNumber: z.string().min(1),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  initServices();

  const authCtx = await getAuthContext(
    request.headers.get("authorization") ?? undefined,
  );
  if (!authCtx) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { org } = await resolveOrg(authCtx);

  const parsed = sendSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "phoneNumber is required" },
      { status: 400 },
    );
  }

  const { phoneNumber } = parsed.data;

  // Validate E.164 format
  if (!/^\+[1-9]\d{1,14}$/.test(phoneNumber)) {
    return NextResponse.json(
      {
        error:
          "Invalid phone number format. Use E.164 format (e.g. +14155551234)",
      },
      { status: 400 },
    );
  }

  const result = await sendVerificationCode(
    org.orgId,
    authCtx.userId,
    phoneNumber,
  );
  if (!result.success) {
    log.warn("Verification send failed", {
      error: result.error,
      orgId: org.orgId,
    });
    return NextResponse.json({ error: result.error }, { status: 429 });
  }

  return NextResponse.json({ success: true });
}
