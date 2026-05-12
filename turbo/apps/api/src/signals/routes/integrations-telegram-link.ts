import { command, type Setter } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import {
  OFFICIAL_TELEGRAM_BOT_ID,
  zeroIntegrationsTelegramContract,
} from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { telegramOfficialUserLinks } from "@vm0/db/schema/telegram-official-user-link";
import { telegramUserLinks } from "@vm0/db/schema/telegram-user-link";
import type { z } from "zod";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { waitUntil } from "../context/wait-until";
import { bodyResultOf, queryOf } from "../context/request";
import { writeDb$ } from "../external/db";
import {
  getOfficialTelegramBotConfig,
  isOfficialTelegramBotId,
} from "../external/telegram-official";
import { sendMessage } from "../external/telegram-client";
import { publishUserSignal } from "../external/realtime";
import { logger } from "../../lib/log";
import { safeAsync } from "../utils";
import {
  ensureTelegramArtifactStorage$,
  formatTelegramUserDisplayName,
  linkOfficialTelegramUserToVm0User$,
  linkTelegramUserToVm0User$,
  telegramInstallationForLink,
  type TelegramInstallationForLink,
  verifyConnectSignature,
  verifyTelegramLogin,
  type LinkOfficialTelegramUserResult,
  type LinkTelegramUserResult,
} from "../services/zero-telegram-link.service";
import type { AuthContext } from "../../types/auth";
import type { RouteEntry } from "../route";

const log = logger("api:telegram:link");

type TelegramLinkBody = z.infer<
  typeof zeroIntegrationsTelegramContract.link.body
>;
type OrganizationAuth = AuthContext & { readonly orgId: string };
type ErrorStatus = 400 | 403 | 404 | 409;
type LinkTelegramUserConflictReason = Extract<
  LinkTelegramUserResult,
  { readonly ok: false }
>["reason"];
type LinkOfficialTelegramUserConflictReason = Extract<
  LinkOfficialTelegramUserResult,
  { readonly ok: false }
>["reason"];

function errorResult(status: ErrorStatus, message: string, code: string) {
  return {
    status,
    body: {
      error: { message, code },
    },
  };
}

function orgMismatchResponse() {
  return errorResult(
    403,
    "This Telegram bot belongs to a different organization. Switch to the bot's organization to connect.",
    "FORBIDDEN",
  );
}

function missingAuthMethodResponse() {
  return errorResult(
    400,
    "Either telegramAuth or connectSignature is required",
    "BAD_REQUEST",
  );
}

function invalidTelegramAuthResponse() {
  return errorResult(400, "Invalid Telegram authorization", "BAD_REQUEST");
}

function invalidConnectSignatureResponse() {
  return errorResult(
    400,
    "Invalid or expired connect link. Please use /connect again in Telegram.",
    "BAD_REQUEST",
  );
}

function linkConflictResponse(reason: LinkTelegramUserConflictReason) {
  const message =
    reason === "telegram-user-linked"
      ? "This Telegram account is already connected to another VM0 account for this bot. Disconnect it before connecting a different account."
      : reason === "vm0-user-linked"
        ? "Your VM0 account is already connected to another Telegram account for this bot. Disconnect it before connecting a different Telegram account."
        : "This Telegram account link already exists. Disconnect it first and try again.";

  return errorResult(409, message, "CONFLICT");
}

function officialLinkConflictResponse(
  reason: LinkOfficialTelegramUserConflictReason,
) {
  const message =
    reason === "telegram-user-linked"
      ? "This Telegram account is already connected to another VM0 organization through the official Zero bot. Disconnect it before connecting a different account."
      : reason === "vm0-org-linked"
        ? "Your VM0 account is already connected to another Telegram account for the official Zero bot in this organization. Disconnect it before connecting a different Telegram account."
        : "This official Telegram account link already exists. Disconnect it first and try again.";

  return errorResult(409, message, "CONFLICT");
}

function linkSuccessResponse(botUsername: string, telegramUserId: string) {
  return {
    status: 200 as const,
    body: {
      botUsername,
      telegramUserId,
    },
  };
}

function sendConnectSuccessMessage(args: {
  readonly botToken: string;
  readonly telegramUserId: string;
  readonly official: boolean;
}): void {
  const text = args.official
    ? "✅ Account linked.\nSend me a message to start chatting with Zero."
    : "✅ Account linked.\nSend me a message to start chatting with your agent.";

  waitUntil(
    sendMessage(args.botToken, args.telegramUserId, text)
      .then((result) => {
        if (result.kind === "telegram-error") {
          log.warn("Failed to send Telegram connect success message", {
            telegramUserId: args.telegramUserId,
            status: result.status,
            description: result.description,
          });
        }
      })
      .catch((error: unknown) => {
        log.warn("Failed to send Telegram connect success message", {
          telegramUserId: args.telegramUserId,
          error,
        });
      }),
  );
}

function noLinkedTelegramAccountResponse() {
  return {
    status: 404 as const,
    body: {
      error: {
        message: "No linked Telegram account",
        code: "NOT_FOUND" as const,
      },
    },
  };
}

async function publishTelegramUserChanged(userId: string): Promise<void> {
  const publishResult = await safeAsync(() => {
    return publishUserSignal([userId], "telegram:changed");
  });
  if ("error" in publishResult) {
    log.warn("Failed to publish Telegram user change", {
      error: publishResult.error,
    });
  }
}

const unlinkInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const { botId } = get(queryOf(zeroIntegrationsTelegramContract.unlink));
  const writeDb = set(writeDb$);

  if (botId === OFFICIAL_TELEGRAM_BOT_ID) {
    const deleted = await writeDb
      .delete(telegramOfficialUserLinks)
      .where(
        and(
          eq(telegramOfficialUserLinks.vm0UserId, auth.userId),
          eq(telegramOfficialUserLinks.orgId, auth.orgId),
        ),
      )
      .returning({ id: telegramOfficialUserLinks.id });
    signal.throwIfAborted();

    if (deleted.length === 0) {
      return noLinkedTelegramAccountResponse();
    }

    await publishTelegramUserChanged(auth.userId);
    signal.throwIfAborted();
    return { status: 204 as const, body: undefined };
  }

  const orgInstallations = writeDb
    .select({ telegramBotId: telegramInstallations.telegramBotId })
    .from(telegramInstallations)
    .where(eq(telegramInstallations.orgId, auth.orgId));

  const deleted = await writeDb
    .delete(telegramUserLinks)
    .where(
      and(
        eq(telegramUserLinks.vm0UserId, auth.userId),
        inArray(telegramUserLinks.installationId, orgInstallations),
        botId ? eq(telegramUserLinks.installationId, botId) : undefined,
      ),
    )
    .returning({ id: telegramUserLinks.id });
  signal.throwIfAborted();

  if (deleted.length === 0) {
    return noLinkedTelegramAccountResponse();
  }

  await publishTelegramUserChanged(auth.userId);
  signal.throwIfAborted();
  return { status: 204 as const, body: undefined };
});

const ensureLinkArtifactStorage$ = command(
  async (
    { set },
    auth: OrganizationAuth,
    signal: AbortSignal,
  ): Promise<void> => {
    await set(
      ensureTelegramArtifactStorage$,
      { orgId: auth.orgId, userId: auth.userId },
      signal,
    );
    signal.throwIfAborted();
  },
);

const linkOfficialInner$ = command(
  async (
    { set },
    args: { readonly auth: OrganizationAuth; readonly body: TelegramLinkBody },
    signal: AbortSignal,
  ) => {
    const config = getOfficialTelegramBotConfig();
    if (!config.botToken) {
      return errorResult(
        404,
        "Official Telegram bot is not configured",
        "NOT_FOUND",
      );
    }

    const telegramAuth = args.body.telegramAuth;
    if (telegramAuth) {
      if (!verifyTelegramLogin(telegramAuth, config.botToken)) {
        return invalidTelegramAuthResponse();
      }

      const telegramUserId = String(telegramAuth.id);
      const result = await set(
        linkOfficialTelegramUserToVm0User$,
        {
          telegramUserId,
          telegramUsername: telegramAuth.username,
          telegramDisplayName: formatTelegramUserDisplayName(telegramAuth),
          vm0UserId: args.auth.userId,
          orgId: args.auth.orgId,
        },
        signal,
      );
      signal.throwIfAborted();

      if (!result.ok) {
        return officialLinkConflictResponse(result.reason);
      }

      await set(ensureLinkArtifactStorage$, args.auth, signal);

      return linkSuccessResponse(config.botUsername ?? "Zero", telegramUserId);
    }

    const connectSignature = args.body.connectSignature;
    if (connectSignature) {
      if (
        !verifyConnectSignature({
          installationId: OFFICIAL_TELEGRAM_BOT_ID,
          telegramUserId: connectSignature.telegramUserId,
          timestamp: connectSignature.timestamp,
          signature: connectSignature.signature,
          botToken: config.botToken,
          telegramUsername: connectSignature.telegramUsername,
          telegramDisplayName: connectSignature.telegramDisplayName,
        })
      ) {
        return invalidConnectSignatureResponse();
      }

      const result = await set(
        linkOfficialTelegramUserToVm0User$,
        {
          telegramUserId: connectSignature.telegramUserId,
          telegramUsername: connectSignature.telegramUsername,
          telegramDisplayName: connectSignature.telegramDisplayName,
          vm0UserId: args.auth.userId,
          orgId: args.auth.orgId,
        },
        signal,
      );
      signal.throwIfAborted();

      if (!result.ok) {
        return officialLinkConflictResponse(result.reason);
      }

      await set(ensureLinkArtifactStorage$, args.auth, signal);

      sendConnectSuccessMessage({
        botToken: config.botToken,
        telegramUserId: connectSignature.telegramUserId,
        official: true,
      });

      return linkSuccessResponse(
        config.botUsername ?? "Zero",
        connectSignature.telegramUserId,
      );
    }

    return missingAuthMethodResponse();
  },
);

async function linkCustomWithTelegramAuth(args: {
  readonly set: Setter;
  readonly auth: OrganizationAuth;
  readonly body: TelegramLinkBody;
  readonly installation: TelegramInstallationForLink;
  readonly signal: AbortSignal;
}) {
  const telegramAuth = args.body.telegramAuth;
  if (!telegramAuth) {
    return missingAuthMethodResponse();
  }

  if (!verifyTelegramLogin(telegramAuth, args.installation.botToken)) {
    return invalidTelegramAuthResponse();
  }

  const telegramUserId = String(telegramAuth.id);
  const result = await args.set(
    linkTelegramUserToVm0User$,
    {
      installationId: args.installation.telegramBotId,
      telegramUserId,
      telegramUsername: telegramAuth.username,
      telegramDisplayName: formatTelegramUserDisplayName(telegramAuth),
      vm0UserId: args.auth.userId,
    },
    args.signal,
  );
  args.signal.throwIfAborted();

  if (!result.ok) {
    return linkConflictResponse(result.reason);
  }

  await args.set(ensureLinkArtifactStorage$, args.auth, args.signal);
  return linkSuccessResponse(
    args.installation.botUsername ?? "Telegram bot",
    telegramUserId,
  );
}

async function linkCustomWithConnectSignature(args: {
  readonly set: Setter;
  readonly auth: OrganizationAuth;
  readonly body: TelegramLinkBody;
  readonly installation: TelegramInstallationForLink;
  readonly signal: AbortSignal;
}) {
  const connectSignature = args.body.connectSignature;
  if (!connectSignature) {
    return missingAuthMethodResponse();
  }

  if (
    !verifyConnectSignature({
      installationId: args.installation.telegramBotId,
      telegramUserId: connectSignature.telegramUserId,
      timestamp: connectSignature.timestamp,
      signature: connectSignature.signature,
      botToken: args.installation.botToken,
      telegramUsername: connectSignature.telegramUsername,
      telegramDisplayName: connectSignature.telegramDisplayName,
    })
  ) {
    return invalidConnectSignatureResponse();
  }

  const result = await args.set(
    linkTelegramUserToVm0User$,
    {
      installationId: args.installation.telegramBotId,
      telegramUserId: connectSignature.telegramUserId,
      telegramUsername: connectSignature.telegramUsername,
      telegramDisplayName: connectSignature.telegramDisplayName,
      vm0UserId: args.auth.userId,
    },
    args.signal,
  );
  args.signal.throwIfAborted();

  if (!result.ok) {
    return linkConflictResponse(result.reason);
  }

  await args.set(ensureLinkArtifactStorage$, args.auth, args.signal);

  sendConnectSuccessMessage({
    botToken: args.installation.botToken,
    telegramUserId: connectSignature.telegramUserId,
    official: false,
  });

  return linkSuccessResponse(
    args.installation.botUsername ?? "Telegram bot",
    connectSignature.telegramUserId,
  );
}

const linkCustomInner$ = command(
  async (
    { get, set },
    args: { readonly auth: OrganizationAuth; readonly body: TelegramLinkBody },
    signal: AbortSignal,
  ) => {
    const installation = await get(
      telegramInstallationForLink({ botId: args.body.telegramBotId }),
    );
    signal.throwIfAborted();

    if (!installation) {
      return errorResult(404, "Installation not found", "NOT_FOUND");
    }
    if (installation.orgId !== args.auth.orgId) {
      return orgMismatchResponse();
    }

    if (args.body.telegramAuth) {
      return linkCustomWithTelegramAuth({
        set,
        auth: args.auth,
        body: args.body,
        installation,
        signal,
      });
    }

    if (args.body.connectSignature) {
      return linkCustomWithConnectSignature({
        set,
        auth: args.auth,
        body: args.body,
        installation,
        signal,
      });
    }

    return missingAuthMethodResponse();
  },
);

const linkInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const body = await get(bodyResultOf(zeroIntegrationsTelegramContract.link));
  signal.throwIfAborted();

  if (!body.ok) {
    return body.response;
  }

  const linkCommand = isOfficialTelegramBotId(body.data.telegramBotId)
    ? linkOfficialInner$
    : linkCustomInner$;
  return set(linkCommand, { auth, body: body.data }, signal);
});

export const integrationsTelegramLinkRoutes: readonly RouteEntry[] = [
  {
    route: zeroIntegrationsTelegramContract.link,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      linkInner$,
    ),
  },
  {
    route: zeroIntegrationsTelegramContract.unlink,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      unlinkInner$,
    ),
  },
];
