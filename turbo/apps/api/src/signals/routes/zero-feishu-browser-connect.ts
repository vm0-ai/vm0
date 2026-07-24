import { command } from "ccstate";
import { and, eq, ne } from "drizzle-orm";
import { zeroFeishuBrowserConnectContract } from "@vm0/api-contracts/contracts/zero-feishu-browser-connect";
import { feishuOrgConnections } from "@vm0/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@vm0/db/schema/feishu-org-installation";

import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import {
  organizationAuthContext$,
  requiredAuthContext$,
} from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { request$ } from "../context/hono";
import { bodyResultOf, queryOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import { writeDb$, type Db } from "../external/db";
import { listFeishuChatMessages } from "../external/feishu-client";
import { nowDate } from "../external/time";
import type { RouteEntry } from "../route-entry";
import { feishuBotOpenUrl } from "../services/feishu-config";
import { verifyFeishuConnectToken } from "../services/feishu-connect-token";
import { publishFeishuOrgChanged } from "../services/zero-feishu-realtime.service";
import { notifyFeishuConnect } from "../services/zero-feishu-welcome.service";
import { tapError } from "../utils";

const REDIRECT_STATUS = 307;
const L = logger("FeishuBrowserConnect");

function redirect(url: string): Response {
  return new Response(null, {
    status: REDIRECT_STATUS,
    headers: { location: url },
  });
}

function worksRedirect(params: Readonly<Record<string, string>>): Response {
  return redirect(`${env("APP_URL")}/works?${new URLSearchParams(params)}`);
}

interface FeishuConnectArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly installationId: string;
  readonly openId: string;
  readonly chatId: string;
  readonly ts: number;
  readonly sig: string;
}

type FeishuConnectResult =
  | { readonly kind: "invalid" }
  | { readonly kind: "installation_not_found" }
  | { readonly kind: "wrong_organization" }
  | { readonly kind: "account_in_use" }
  | {
      readonly kind: "success";
      readonly appId: string;
      readonly botName: string | null;
    };

async function loadFeishuUserName(args: {
  readonly db: Db;
  readonly installationId: string;
  readonly chatId: string;
  readonly openId: string;
  readonly signal: AbortSignal;
}): Promise<string | null> {
  const messages = await tapError(
    listFeishuChatMessages({
      db: args.db,
      installationId: args.installationId,
      chatId: args.chatId,
      pageSize: 20,
      signal: args.signal,
    }),
    (error) => {
      L.warn("Failed to resolve Feishu user name from chat history", {
        error,
        installationId: args.installationId,
        openId: args.openId,
      });
    },
  );
  args.signal.throwIfAborted();
  const name = messages?.find((message) => {
    return message.sender?.id === args.openId;
  })?.sender?.sender_name;
  return name?.trim() || null;
}

const connectFeishuAccount$ = command(
  async (
    { set },
    args: FeishuConnectArgs,
    signal: AbortSignal,
  ): Promise<FeishuConnectResult> => {
    const { installationId, openId, chatId, ts, sig } = args;
    if (
      !verifyFeishuConnectToken({
        installationId,
        openId,
        chatId,
        timestamp: ts,
        signature: sig,
      })
    ) {
      return { kind: "invalid" };
    }

    const db = set(writeDb$);
    const [installation] = await db
      .select()
      .from(feishuOrgInstallations)
      .where(eq(feishuOrgInstallations.id, installationId))
      .limit(1);
    signal.throwIfAborted();
    if (!installation) {
      return { kind: "installation_not_found" };
    }
    if (args.orgId !== installation.orgId) {
      return { kind: "wrong_organization" };
    }

    const userName = await loadFeishuUserName({
      db,
      installationId,
      chatId,
      openId,
      signal,
    });
    const [inserted] = await db
      .insert(feishuOrgConnections)
      .values({
        feishuOpenId: openId,
        feishuUserName: userName,
        installationId,
        vm0UserId: args.userId,
      })
      .onConflictDoNothing({
        target: [
          feishuOrgConnections.feishuOpenId,
          feishuOrgConnections.installationId,
        ],
      })
      .returning({
        id: feishuOrgConnections.id,
        vm0UserId: feishuOrgConnections.vm0UserId,
        dmWelcomeSent: feishuOrgConnections.dmWelcomeSent,
      });
    signal.throwIfAborted();
    let connectionId = inserted?.id;
    let shouldNotify = inserted ? !inserted.dmWelcomeSent : false;
    if (!inserted) {
      const [existing] = await db
        .select({
          id: feishuOrgConnections.id,
          vm0UserId: feishuOrgConnections.vm0UserId,
          dmWelcomeSent: feishuOrgConnections.dmWelcomeSent,
        })
        .from(feishuOrgConnections)
        .where(
          and(
            eq(feishuOrgConnections.installationId, installationId),
            eq(feishuOrgConnections.feishuOpenId, openId),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (!existing || existing.vm0UserId !== args.userId) {
        return { kind: "account_in_use" };
      }
      connectionId = existing.id;
      shouldNotify = !existing.dmWelcomeSent;
      if (userName) {
        await db
          .update(feishuOrgConnections)
          .set({ feishuUserName: userName, updatedAt: nowDate() })
          .where(
            and(
              eq(feishuOrgConnections.installationId, installationId),
              eq(feishuOrgConnections.feishuOpenId, openId),
            ),
          );
        signal.throwIfAborted();
      }
    }
    await db
      .delete(feishuOrgConnections)
      .where(
        and(
          eq(feishuOrgConnections.installationId, installationId),
          eq(feishuOrgConnections.vm0UserId, args.userId),
          ne(feishuOrgConnections.feishuOpenId, openId),
        ),
      );
    signal.throwIfAborted();
    await publishFeishuOrgChanged(
      db,
      installation.orgId,
      installation.ownerUserId,
      [args.userId],
    );
    signal.throwIfAborted();
    if (connectionId && shouldNotify) {
      const backgroundSignal = new AbortController().signal;
      waitUntil(
        tapError(
          notifyFeishuConnect({
            db,
            installationId,
            connectionId,
            openId,
            signal: backgroundSignal,
          }),
          (error) => {
            L.warn("Failed to send Feishu connect welcome", {
              error,
              installationId,
              openId,
            });
          },
        ),
      );
    }
    return {
      kind: "success",
      appId: installation.appId,
      botName: installation.botName,
    };
  },
);

function legacyConnectResult(result: FeishuConnectResult): Response {
  switch (result.kind) {
    case "invalid":
      return worksRedirect({ feishuError: "Invalid or expired connect link" });
    case "installation_not_found":
      return worksRedirect({ feishuError: "Feishu installation not found" });
    case "wrong_organization":
      return worksRedirect({
        feishuError:
          "Switch to the organization connected to this Feishu tenant",
      });
    case "account_in_use":
      return worksRedirect({
        feishuError: "This Feishu account is already connected",
      });
    case "success":
      return worksRedirect({ feishu: "connected" });
  }
}

const connect$ = command(async ({ get, set }, signal: AbortSignal) => {
  const request = get(request$);
  const auth = await set(requiredAuthContext$, {}, signal);
  if ("status" in auth) {
    const signIn = new URL("/sign-in", env("APP_URL"));
    signIn.searchParams.set("redirect_url", request.url);
    return redirect(signIn.toString());
  }
  const query = get(queryOf(zeroFeishuBrowserConnectContract.connect));
  const { installationId, openId, chatId, ts, sig } = query;
  if (!installationId || !openId || !chatId || ts === undefined || !sig) {
    return worksRedirect({ feishuError: "Invalid or expired connect link" });
  }
  if (!auth.orgId) {
    return worksRedirect({
      feishuError: "Switch to the organization connected to this Feishu tenant",
    });
  }
  const result = await set(
    connectFeishuAccount$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      installationId,
      openId,
      chatId,
      ts,
      sig,
    },
    signal,
  );
  return legacyConnectResult(result);
});

const connectFromApp$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(
    bodyResultOf(zeroFeishuBrowserConnectContract.connectFromApp),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const result = await set(
    connectFeishuAccount$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      ...bodyResult.data,
    },
    signal,
  );
  signal.throwIfAborted();

  switch (result.kind) {
    case "invalid":
      return badRequestMessage("Invalid or expired Feishu connect link");
    case "installation_not_found":
      return notFound("Feishu installation not found");
    case "wrong_organization":
      return {
        status: 403 as const,
        body: {
          error: {
            message:
              "Switch to the organization connected to this Feishu tenant",
            code: "FORBIDDEN" as const,
          },
        },
      };
    case "account_in_use":
      return conflict("This Feishu account is already connected");
    case "success":
      return {
        status: 200 as const,
        body: {
          success: true as const,
          botName: result.botName,
          openUrl: feishuBotOpenUrl(result.appId),
        },
      };
  }
});

const getStatus$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(zeroFeishuBrowserConnectContract.getStatus));
  if (
    !verifyFeishuConnectToken({
      installationId: query.installationId,
      openId: query.openId,
      chatId: query.chatId,
      timestamp: query.ts,
      signature: query.sig,
    })
  ) {
    return badRequestMessage("Invalid or expired Feishu connect link");
  }

  const db = set(writeDb$);
  const [installation] = await db
    .select({
      orgId: feishuOrgInstallations.orgId,
      appId: feishuOrgInstallations.appId,
      botName: feishuOrgInstallations.botName,
    })
    .from(feishuOrgInstallations)
    .where(eq(feishuOrgInstallations.id, query.installationId))
    .limit(1);
  signal.throwIfAborted();
  if (!installation) {
    return notFound("Feishu installation not found");
  }
  if (installation.orgId !== auth.orgId) {
    return {
      status: 403 as const,
      body: {
        error: {
          message: "Switch to the organization connected to this Feishu tenant",
          code: "FORBIDDEN" as const,
        },
      },
    };
  }
  const [connection] = await db
    .select({ vm0UserId: feishuOrgConnections.vm0UserId })
    .from(feishuOrgConnections)
    .where(
      and(
        eq(feishuOrgConnections.installationId, query.installationId),
        eq(feishuOrgConnections.feishuOpenId, query.openId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (connection && connection.vm0UserId !== auth.userId) {
    return conflict("This Feishu account is already connected");
  }
  return {
    status: 200 as const,
    body: {
      isConnected: connection?.vm0UserId === auth.userId,
      botName: installation.botName,
      openUrl: feishuBotOpenUrl(installation.appId),
    },
  };
});

export const zeroFeishuBrowserConnectRoutes: readonly RouteEntry[] = [
  {
    route: zeroFeishuBrowserConnectContract.connect,
    handler: connect$,
  },
  {
    route: zeroFeishuBrowserConnectContract.connectFromApp,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      connectFromApp$,
    ),
  },
  {
    route: zeroFeishuBrowserConnectContract.getStatus,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      getStatus$,
    ),
  },
];
