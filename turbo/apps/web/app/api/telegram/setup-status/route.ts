import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { initServices } from "../../../../src/lib/init-services";
import { env } from "../../../../src/env";
import { getAuthContext } from "../../../../src/lib/auth/get-auth-context";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import {
  getMe,
  isTelegramApiError,
} from "../../../../src/lib/zero/telegram/client";
import { checkTelegramDomain } from "../../../../src/lib/zero/telegram/check-domain";
import { logger } from "../../../../src/lib/shared/logger";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";

const log = logger("api:telegram:setup-status");

const setupStatusBodySchema = z.object({
  botToken: z.string().min(1),
  origin: z.string().optional(),
});

function badRequestResponse(message: string) {
  return NextResponse.json(
    { error: { message, code: "BAD_REQUEST" } },
    { status: 400 },
  );
}

function conflictResponse(message: string) {
  return NextResponse.json(
    { error: { message, code: "CONFLICT" } },
    { status: 409 },
  );
}

function resolveProbeOrigin(origin: string | undefined): string {
  if (origin) {
    try {
      const parsed = new URL(origin);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return parsed.origin;
      }
    } catch {
      // Fall back to the configured app URL for malformed client origins.
    }
  }

  return env().NEXT_PUBLIC_APP_URL;
}

function isInvalidTelegramTokenError(error: unknown): boolean {
  if (isTelegramApiError(error)) {
    return (
      error.status === 401 ||
      /unauthorized|not found/i.test(error.description ?? "")
    );
  }

  return false;
}

export async function POST(request: Request) {
  initServices();

  const authHeader = request.headers.get("authorization");
  const authCtx = await getAuthContext(authHeader ?? undefined);
  if (!authCtx) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }
  const { org } = await resolveOrg(authCtx);

  const parseResult = setupStatusBodySchema.safeParse(await request.json());
  if (!parseResult.success) {
    return badRequestResponse("botToken is required");
  }

  const { botToken, origin } = parseResult.data;
  let botInfo: Awaited<ReturnType<typeof getMe>>;
  try {
    botInfo = await getMe(botToken);
  } catch (error) {
    if (!isInvalidTelegramTokenError(error)) {
      log.warn("Unable to verify Telegram setup status", { error });
    }
    return badRequestResponse(
      "Invalid bot token. Please verify your token with @BotFather.",
    );
  }

  const botId = String(botInfo.id);
  const [existing] = await globalThis.services.db
    .select({
      orgId: telegramInstallations.orgId,
      botUsername: telegramInstallations.botUsername,
    })
    .from(telegramInstallations)
    .where(eq(telegramInstallations.telegramBotId, botId))
    .limit(1);

  if (existing) {
    return conflictResponse(
      existing.orgId === org.orgId
        ? `This bot is already installed. Use /connect in Telegram (@${existing.botUsername ?? botId}) to link your account.`
        : "This Telegram bot is already installed in another workspace.",
    );
  }

  const domainConfigured = await checkTelegramDomain(
    botId,
    resolveProbeOrigin(origin),
  );

  return NextResponse.json({
    id: botId,
    username: botInfo.username ?? null,
    domainConfigured,
    privacyDisabled: botInfo.can_read_all_group_messages === true,
  });
}
