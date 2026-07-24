import { command } from "ccstate";
import { and, eq, ne } from "drizzle-orm";
import { zeroFeishuBrowserConnectContract } from "@vm0/api-contracts/contracts/zero-feishu-browser-connect";
import { feishuOrgConnections } from "@vm0/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@vm0/db/schema/feishu-org-installation";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { requiredAuthContext$ } from "../auth/auth-context";
import { request$ } from "../context/hono";
import { queryOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
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
  if (
    !installationId ||
    !openId ||
    !chatId ||
    ts === undefined ||
    !sig ||
    !verifyFeishuConnectToken({
      installationId,
      openId,
      chatId,
      timestamp: ts,
      signature: sig,
    })
  ) {
    return worksRedirect({ feishuError: "Invalid or expired connect link" });
  }

  const db = set(writeDb$);
  const [installation] = await db
    .select()
    .from(feishuOrgInstallations)
    .where(eq(feishuOrgInstallations.id, installationId))
    .limit(1);
  signal.throwIfAborted();
  if (!installation) {
    return worksRedirect({ feishuError: "Feishu installation not found" });
  }
  if (!auth.orgId || auth.orgId !== installation.orgId) {
    return worksRedirect({
      feishuError: "Switch to the organization connected to this Feishu tenant",
    });
  }

  const [inserted] = await db
    .insert(feishuOrgConnections)
    .values({
      feishuOpenId: openId,
      installationId,
      vm0UserId: auth.userId,
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
    });
  signal.throwIfAborted();
  if (!inserted) {
    const [existing] = await db
      .select({ vm0UserId: feishuOrgConnections.vm0UserId })
      .from(feishuOrgConnections)
      .where(
        and(
          eq(feishuOrgConnections.installationId, installationId),
          eq(feishuOrgConnections.feishuOpenId, openId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (existing?.vm0UserId !== auth.userId) {
      return worksRedirect({
        feishuError: "This Feishu account is already connected",
      });
    }
  }
  await db
    .delete(feishuOrgConnections)
    .where(
      and(
        eq(feishuOrgConnections.installationId, installationId),
        eq(feishuOrgConnections.vm0UserId, auth.userId),
        ne(feishuOrgConnections.feishuOpenId, openId),
      ),
    );
  signal.throwIfAborted();
  await publishFeishuOrgChanged(
    db,
    installation.orgId,
    installation.ownerUserId,
    [auth.userId],
  );
  signal.throwIfAborted();
  if (inserted) {
    waitUntil(
      tapError(
        notifyFeishuConnect({
          db,
          installationId,
          connectionId: inserted.id,
          openId,
          signal,
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
  return worksRedirect({ feishu: "connected" });
});

export const zeroFeishuBrowserConnectRoutes: readonly RouteEntry[] = [
  {
    route: zeroFeishuBrowserConnectContract.connect,
    handler: connect$,
  },
];
