import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { initServices } from "../../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../../src/lib/zero/org/resolve-org";
import { confirmVerificationCode } from "../../../../../../src/lib/zero/phone/phone-verify-service";

const confirmSchema = z.object({
  phoneNumber: z.string().min(1),
  code: z.string().min(1),
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

  const parsed = confirmSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "phoneNumber and code are required" },
      { status: 400 },
    );
  }

  const { phoneNumber, code } = parsed.data;

  const result = await confirmVerificationCode(
    org.orgId,
    authCtx.userId,
    phoneNumber,
    code,
  );
  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json({ success: true });
}
