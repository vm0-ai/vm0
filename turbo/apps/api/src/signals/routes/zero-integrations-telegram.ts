import { computed } from "ccstate";
import { initContract } from "@ts-rest/core";
import { z } from "zod";
import { integrationsTelegramBotListContract } from "@vm0/api-contracts/contracts/integrations";
import { authHeadersSchema } from "@vm0/api-contracts/contracts/base";
import { apiErrorSchema } from "@vm0/api-contracts/contracts/errors";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import { shadowCompareRoute } from "../context/shadow-compare";
import { buildFileDownloadUrl, getFile } from "../external/telegram-client";
import {
  zeroTelegramBots,
  zeroTelegramInstallation,
} from "../services/zero-telegram-data.service";
import type { RouteEntry } from "../route";

const c = initContract();

const telegramDownloadFileContract = c.router({
  download: {
    method: "GET",
    path: "/api/zero/integrations/telegram/download-file",
    headers: authHeadersSchema,
    query: z.object({
      file_id: z.string().min(1),
      bot_id: z.string().min(1),
    }),
    responses: {
      200: c.otherResponse({
        contentType: "application/octet-stream",
        body: z.unknown(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary: "Download a Telegram file via org bot token",
  },
});

function errorResponse(
  status: number,
  message: string,
  code: string,
): Response {
  return new Response(JSON.stringify({ error: { message, code } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const getTelegramBotsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const bots = await get(
    zeroTelegramBots({ orgId: auth.orgId, userId: auth.userId }),
  );

  return {
    status: 200 as const,
    body: { bots: [...bots] },
  };
});

const getTelegramDownloadFileInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(telegramDownloadFileContract.download));

  const installation = await get(
    zeroTelegramInstallation({ orgId: auth.orgId, botId: query.bot_id }),
  );
  if (!installation) {
    return errorResponse(404, "Telegram bot not found", "NOT_FOUND");
  }

  return getFile(installation.botToken, query.file_id)
    .then((file) => {
      if (!file.file_path) {
        return errorResponse(
          404,
          "Telegram file does not have a downloadable path",
          "NOT_FOUND",
        );
      }

      const downloadUrl = buildFileDownloadUrl(
        installation.botToken,
        file.file_path,
      );
      return fetch(downloadUrl).then((fileResponse) => {
        if (!fileResponse.ok) {
          return errorResponse(
            502,
            `Failed to download file from Telegram: ${fileResponse.status}`,
            "BAD_GATEWAY",
          );
        }

        const responseContentType =
          fileResponse.headers.get("content-type") ??
          "application/octet-stream";
        const contentLength = fileResponse.headers.get("content-length");
        const fileName = file.file_path!.split("/").pop() ?? query.file_id;

        const headers = new Headers();
        headers.set("Content-Type", responseContentType);
        headers.set("X-File-Name", encodeURIComponent(fileName));
        headers.set("X-File-Mimetype", responseContentType);
        if (contentLength) {
          headers.set("Content-Length", contentLength);
        }

        return new Response(fileResponse.body, { status: 200, headers });
      });
    })
    .catch((error) => {
      return errorResponse(
        502,
        error instanceof Error ? error.message : "Failed to download file",
        "BAD_GATEWAY",
      );
    });
});

const telegramReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "telegram:read",
} as const;

export const zeroIntegrationsTelegramRoutes: readonly RouteEntry[] = [
  {
    route: integrationsTelegramBotListContract.listBots,
    handler: shadowCompareRoute({
      route: integrationsTelegramBotListContract.listBots,
      handler: authRoute(telegramReadAuth, getTelegramBotsInner$),
    }),
  },
  {
    route: telegramDownloadFileContract.download,
    handler: authRoute(telegramReadAuth, getTelegramDownloadFileInner$),
  },
];
