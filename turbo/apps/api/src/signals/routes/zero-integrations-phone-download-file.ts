import { command } from "ccstate";
import { integrationsPhoneDownloadFileContract } from "@vm0/api-contracts/contracts/integrations";
import { agentphoneMessages } from "@vm0/db/schema/agentphone-message";
import { agentphoneUserLinks } from "@vm0/db/schema/agentphone-user-link";
import { and, eq, isNotNull } from "drizzle-orm";

import { inferMimetype } from "../../lib/mimetype";
import { logger } from "../../lib/log";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import { db$ } from "../external/db";
import { agentPhoneFilenameFromMediaUrl } from "../services/zero-agentphone.service";
import type { RouteEntry } from "../route";
import { settle } from "../utils";

const log = logger("api:zero:integrations:phone:download-file");
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;

function jsonResponse(status: number, message: string, code: string): Response {
  return Response.json({ error: { message, code } }, { status });
}

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

const download$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(integrationsPhoneDownloadFileContract.download));
  const db = get(db$);
  const [message] = await db
    .select({ mediaUrl: agentphoneMessages.mediaUrl })
    .from(agentphoneMessages)
    .innerJoin(
      agentphoneUserLinks,
      eq(agentphoneMessages.agentphoneUserLinkId, agentphoneUserLinks.id),
    )
    .where(
      and(
        eq(agentphoneMessages.agentphoneMessageId, query.file_id),
        isNotNull(agentphoneMessages.mediaUrl),
        eq(agentphoneUserLinks.vm0UserId, auth.userId),
        eq(agentphoneUserLinks.orgId, auth.orgId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();

  if (!message?.mediaUrl) {
    return jsonResponse(404, "AgentPhone file not found", "NOT_FOUND");
  }
  const mediaUrl = message.mediaUrl;

  const fileName = agentPhoneFilenameFromMediaUrl(mediaUrl, query.file_id);
  const fallbackMimetype = inferMimetype(fileName);

  const downloadResult = await settle(fetch(mediaUrl, { signal }));
  signal.throwIfAborted();
  if (!downloadResult.ok) {
    log.warn("AgentPhone file download failed", {
      fileId: query.file_id,
      error: downloadResult.error,
    });
    return jsonResponse(
      502,
      "Failed to download file from AgentPhone",
      "BAD_GATEWAY",
    );
  }
  const downloadResponse = downloadResult.value;
  signal.throwIfAborted();
  if (!downloadResponse.ok) {
    log.warn("AgentPhone media download failed", {
      fileId: query.file_id,
      status: downloadResponse.status,
    });
    return jsonResponse(
      502,
      `Failed to download file from AgentPhone: ${downloadResponse.status}`,
      "BAD_GATEWAY",
    );
  }

  const contentLength = downloadResponse.headers.get("content-length");
  const contentLengthBytes = parseContentLength(contentLength);
  if (
    contentLengthBytes !== undefined &&
    contentLengthBytes > MAX_FILE_SIZE_BYTES
  ) {
    return jsonResponse(
      413,
      `File exceeds maximum size of ${MAX_FILE_SIZE_BYTES} bytes`,
      "PAYLOAD_TOO_LARGE",
    );
  }

  const contentType =
    downloadResponse.headers.get("content-type") ?? fallbackMimetype;
  const headers = new Headers();
  headers.set("Content-Type", contentType);
  headers.set("X-File-Name", encodeURIComponent(fileName));
  headers.set("X-File-Mimetype", contentType);
  if (contentLength) {
    headers.set("Content-Length", contentLength);
  }

  return new Response(downloadResponse.body, { status: 200, headers });
});

const phoneReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "phone:read",
} as const;

export const zeroIntegrationsPhoneDownloadFileRoutes: readonly RouteEntry[] = [
  {
    route: integrationsPhoneDownloadFileContract.download,
    handler: authRoute(phoneReadAuth, download$),
  },
];
