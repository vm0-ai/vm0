import { createHmac } from "crypto";
import { NextResponse } from "next/server";
import { eq, desc } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { env } from "../../../../../src/env";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import { telegramUserLinks } from "../../../../../src/db/schema/telegram-user-link";
import { telegramInstallations } from "../../../../../src/db/schema/telegram-installation";

/** Link token expiry: 10 minutes */
const LINK_TOKEN_TTL_MS = 10 * 60 * 1000;

interface LinkTokenPayload {
  vm0UserId: string;
  installationId: string;
  exp: number;
}

/**
 * Create a signed link token (base64url-encoded payload + HMAC signature).
 */
function createLinkToken(payload: LinkTokenPayload, secret: string): string {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

/**
 * Verify and decode a link token. Returns null if invalid or expired.
 */
export function verifyLinkToken(
  token: string,
  secret: string,
): LinkTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [data, sig] = parts;
  if (!data || !sig) return null;

  const expectedSig = createHmac("sha256", secret)
    .update(data)
    .digest("base64url");

  // Timing-safe comparison
  if (expectedSig.length !== sig.length) return null;
  let result = 0;
  for (let i = 0; i < expectedSig.length; i++) {
    result |= expectedSig.charCodeAt(i) ^ sig.charCodeAt(i);
  }
  if (result !== 0) return null;

  const payload = JSON.parse(
    Buffer.from(data, "base64url").toString(),
  ) as LinkTokenPayload;

  if (Date.now() > payload.exp) return null;

  return payload;
}

/**
 * GET /api/integrations/telegram/link
 *
 * Check if the authenticated user is linked to a Telegram bot.
 */
export async function GET(request: Request) {
  initServices();

  const authHeader = request.headers.get("authorization");
  const userId = await getUserId(authHeader ?? undefined);

  if (!userId) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  // Find user's most recent Telegram link
  const [userLink] = await globalThis.services.db
    .select({
      telegramUserId: telegramUserLinks.telegramUserId,
      installationId: telegramUserLinks.installationId,
    })
    .from(telegramUserLinks)
    .where(eq(telegramUserLinks.vm0UserId, userId))
    .orderBy(desc(telegramUserLinks.createdAt))
    .limit(1);

  if (!userLink) {
    return NextResponse.json({ linked: false });
  }

  return NextResponse.json({
    linked: true,
    telegramUserId: userLink.telegramUserId,
  });
}

/**
 * POST /api/integrations/telegram/link
 *
 * Generate a deep link token for account linking via Telegram.
 * Body: { installationId: string }
 */
export async function POST(request: Request) {
  initServices();

  const authHeader = request.headers.get("authorization");
  const userId = await getUserId(authHeader ?? undefined);

  if (!userId) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const body = (await request.json()) as { installationId?: string };
  if (!body.installationId) {
    return NextResponse.json(
      {
        error: {
          message: "installationId is required",
          code: "BAD_REQUEST",
        },
      },
      { status: 400 },
    );
  }

  // Look up installation to get botUsername
  const [installation] = await globalThis.services.db
    .select({
      id: telegramInstallations.id,
      botUsername: telegramInstallations.botUsername,
    })
    .from(telegramInstallations)
    .where(eq(telegramInstallations.id, body.installationId))
    .limit(1);

  if (!installation) {
    return NextResponse.json(
      { error: { message: "Installation not found", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  const { SECRETS_ENCRYPTION_KEY } = env();

  const token = createLinkToken(
    {
      vm0UserId: userId,
      installationId: installation.id,
      exp: Date.now() + LINK_TOKEN_TTL_MS,
    },
    SECRETS_ENCRYPTION_KEY,
  );

  const deepLink = installation.botUsername
    ? `https://t.me/${installation.botUsername}?start=${token}`
    : null;

  return NextResponse.json({ token, deepLink });
}
