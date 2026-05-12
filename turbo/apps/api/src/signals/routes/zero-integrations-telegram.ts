import { computed } from "ccstate";
import { initContract } from "@ts-rest/core";
import { z } from "zod";
import { integrationsTelegramBotListContract } from "@vm0/api-contracts/contracts/integrations";
import { authHeadersSchema } from "@vm0/api-contracts/contracts/base";
import { apiErrorSchema } from "@vm0/api-contracts/contracts/errors";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import { integrationsTelegramBotIdRoutes } from "./integrations-telegram-bot-id";
import { integrationsTelegramLinkRoutes } from "./integrations-telegram-link";
import { buildFileDownloadUrl, getFile } from "../external/telegram-client";
import {
  getOfficialTelegramBotConfig,
  isOfficialTelegramBotId,
} from "../external/telegram-official";
import {
  zeroTelegramBots,
  zeroTelegramInstallation,
} from "../services/zero-telegram-data.service";
import { inferMimetype } from "../../lib/mimetype";
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
      413: apiErrorSchema,
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

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;

function parseContentLength(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0) {
    return undefined;
  }
  return size;
}

function payloadTooLargeResponse(): Response {
  return errorResponse(
    413,
    `File exceeds maximum size of ${MAX_FILE_SIZE_BYTES} bytes`,
    "PAYLOAD_TOO_LARGE",
  );
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

  let botToken: string | null | undefined;
  if (isOfficialTelegramBotId(query.bot_id)) {
    botToken = getOfficialTelegramBotConfig().botToken;
  } else {
    const installation = await get(
      zeroTelegramInstallation({ orgId: auth.orgId, botId: query.bot_id }),
    );
    botToken = installation?.botToken;
  }

  if (!botToken) {
    return errorResponse(404, "Telegram bot not found", "NOT_FOUND");
  }

  return getFile(botToken, query.file_id)
    .then(async (file) => {
      if (!file.file_path) {
        return errorResponse(
          404,
          "Telegram file does not have a downloadable path",
          "NOT_FOUND",
        );
      }
      if (file.file_size && file.file_size > MAX_FILE_SIZE_BYTES) {
        return payloadTooLargeResponse();
      }

      const fileName = file.file_path.split("/").pop() ?? query.file_id;
      const downloadUrl = buildFileDownloadUrl(botToken, file.file_path);
      const fileResponse = await fetch(downloadUrl);
      if (!fileResponse.ok) {
        return errorResponse(
          502,
          `Failed to download file from Telegram: ${fileResponse.status}`,
          "BAD_GATEWAY",
        );
      }

      const responseContentType =
        fileResponse.headers.get("content-type") ?? "";
      if (responseContentType.includes("text/html")) {
        return errorResponse(
          502,
          "Telegram returned an unexpected response",
          "BAD_GATEWAY",
        );
      }

      const contentLength = fileResponse.headers.get("content-length");
      const contentLengthBytes = parseContentLength(contentLength);
      if (
        contentLengthBytes !== undefined &&
        contentLengthBytes > MAX_FILE_SIZE_BYTES
      ) {
        return payloadTooLargeResponse();
      }

      const mimetype = responseContentType || inferMimetype(fileName);
      const headers = new Headers();
      headers.set("Content-Type", mimetype);
      headers.set("X-File-Name", encodeURIComponent(fileName));
      headers.set("X-File-Mimetype", mimetype);
      if (contentLength) {
        headers.set("Content-Length", contentLength);
      }

      return new Response(fileResponse.body, { status: 200, headers });
    })
    .catch(() => {
      return errorResponse(
        502,
        "Failed to download file from Telegram",
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
  ...integrationsTelegramLinkRoutes,
  ...integrationsTelegramBotIdRoutes,
  {
    route: integrationsTelegramBotListContract.listBots,
    handler: authRoute(telegramReadAuth, getTelegramBotsInner$),
  },
  {
    route: telegramDownloadFileContract.download,
    handler: authRoute(telegramReadAuth, getTelegramDownloadFileInner$),
  },
];
