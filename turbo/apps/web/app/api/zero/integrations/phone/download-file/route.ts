import { NextResponse, type NextRequest } from "next/server";
import { and, eq, isNotNull } from "drizzle-orm";
import { agentphoneMessages } from "@vm0/db/schema/agentphone-message";
import { agentphoneUserLinks } from "@vm0/db/schema/agentphone-user-link";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import { inferMimetype } from "../../../../../../src/lib/shared/mimetype";
import { agentPhoneFilenameFromMediaUrl } from "../../../../../../src/lib/zero/agentphone/media";
import { logger } from "../../../../../../src/lib/shared/logger";

const log = logger("api:zero:integrations:phone:download-file");

/** Maximum file size to proxy (100MB). */
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;

function errorResponse(
  status: number,
  message: string,
  code: string,
): NextResponse {
  return NextResponse.json({ error: { message, code } }, { status });
}

function parseContentLength(value: string | null): number | undefined {
  if (!value) return undefined;
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0) return undefined;
  return size;
}

async function resolveAgentPhoneMedia(params: {
  fileId: string;
  userId: string;
  orgId: string;
}): Promise<
  | {
      mediaUrl: string;
      fileName: string;
      mimetype: string;
    }
  | NextResponse
> {
  const [message] = await globalThis.services.db
    .select({
      mediaUrl: agentphoneMessages.mediaUrl,
    })
    .from(agentphoneMessages)
    .innerJoin(
      agentphoneUserLinks,
      eq(agentphoneMessages.agentphoneUserLinkId, agentphoneUserLinks.id),
    )
    .where(
      and(
        eq(agentphoneMessages.agentphoneMessageId, params.fileId),
        isNotNull(agentphoneMessages.mediaUrl),
        eq(agentphoneUserLinks.vm0UserId, params.userId),
        eq(agentphoneUserLinks.orgId, params.orgId),
      ),
    )
    .limit(1);

  if (!message?.mediaUrl) {
    return errorResponse(404, "AgentPhone file not found", "NOT_FOUND");
  }

  const fileName = agentPhoneFilenameFromMediaUrl(
    message.mediaUrl,
    params.fileId,
  );
  return {
    mediaUrl: message.mediaUrl,
    fileName,
    mimetype: inferMimetype(fileName),
  };
}

/**
 * GET /api/zero/integrations/phone/download-file?file_id=<agentphone-message-id>
 *
 * Streams an AgentPhone media attachment for the authenticated linked user.
 * Requires `phone:read` capability. `phone:write` also satisfies this.
 */
export async function GET(request: NextRequest): Promise<Response> {
  initServices();

  const authHeader = request.headers.get("authorization") ?? undefined;
  const authCtx = await requireAuth(authHeader, {
    requiredCapability: "phone:read",
  });
  if (isAuthError(authCtx)) {
    return NextResponse.json(authCtx.body, { status: authCtx.status });
  }

  if (!authCtx.orgId) {
    return errorResponse(401, "Not authenticated", "UNAUTHORIZED");
  }

  const fileId = request.nextUrl.searchParams.get("file_id");
  if (!fileId) {
    return errorResponse(
      400,
      "file_id query parameter is required",
      "BAD_REQUEST",
    );
  }

  try {
    const meta = await resolveAgentPhoneMedia({
      fileId,
      userId: authCtx.userId,
      orgId: authCtx.orgId,
    });
    if (meta instanceof NextResponse) return meta;

    const downloadResponse = await fetch(meta.mediaUrl, {
      signal: request.signal,
    });

    if (!downloadResponse.ok) {
      log.warn("AgentPhone media download failed", {
        fileId,
        status: downloadResponse.status,
      });
      return errorResponse(
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
      return errorResponse(
        413,
        `File exceeds maximum size of ${MAX_FILE_SIZE_BYTES} bytes`,
        "PAYLOAD_TOO_LARGE",
      );
    }

    const responseContentType =
      downloadResponse.headers.get("content-type") ?? "";
    const mimetype = responseContentType || meta.mimetype;
    const headers = new Headers();
    headers.set("Content-Type", mimetype);
    headers.set("X-File-Name", encodeURIComponent(meta.fileName));
    headers.set("X-File-Mimetype", mimetype);
    if (contentLength) {
      headers.set("Content-Length", contentLength);
    }

    return new Response(downloadResponse.body, { status: 200, headers });
  } catch (error) {
    log.warn("AgentPhone file download failed", { fileId, error });
    return errorResponse(
      502,
      "Failed to download file from AgentPhone",
      "BAD_GATEWAY",
    );
  }
}
