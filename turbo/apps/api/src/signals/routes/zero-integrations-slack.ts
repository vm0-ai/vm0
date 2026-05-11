import { computed } from "ccstate";
import { initContract } from "@ts-rest/core";
import { z } from "zod";
import {
  slackOrgStatusSchema,
  zeroIntegrationsSlackContract,
} from "@vm0/api-contracts/contracts/zero-integrations-slack";
import { authHeadersSchema } from "@vm0/api-contracts/contracts/base";
import { apiErrorSchema } from "@vm0/api-contracts/contracts/errors";
import { extractAndGroupVariables } from "@vm0/core/variable-expander";
import { getConnectorProvidedSecretNames } from "@vm0/connectors/connector-utils";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { eq } from "drizzle-orm";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import {
  zeroSlackOrgInstallation,
  zeroSlackOrgStatus,
} from "../services/zero-slack-data.service";
import { getFileInfo, isSlackApiClientError } from "../../lib/slack-client";
import {
  fetchSlackFile,
  isSlackFileFetchError,
  MAX_SLACK_FILE_SIZE_BYTES,
} from "../external/slack-file-fetcher";
import { db$ } from "../external/db";
import { zeroConnectorList } from "../services/zero-connector-data.service";
import { userSecrets, userVariables } from "../services/zero-user-data.service";
import type { RouteEntry } from "../route";
import { safeAsync } from "../utils";

const c = initContract();

const slackDownloadFileContract = c.router({
  download: {
    method: "GET",
    path: "/api/zero/integrations/slack/download-file",
    headers: authHeadersSchema,
    query: z.object({
      file_id: z.string().optional(),
    }),
    responses: {
      200: c.otherResponse({
        contentType: "application/octet-stream",
        body: z.unknown(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      413: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary: "Download a Slack file via org bot token",
  },
});

const getSlackEnvironment$ = computed(
  async (get): Promise<z.infer<typeof slackOrgStatusSchema>["environment"]> => {
    const auth = get(organizationAuthContext$);
    const db = get(db$);

    // Three sequential queries to resolve default-agent → compose → version
    // (each depends on the prior result, so a single JOIN is not straightforward).
    const [meta] = await db
      .select({ defaultAgentId: orgMetadata.defaultAgentId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, auth.orgId))
      .limit(1);

    if (!meta?.defaultAgentId) {
      return undefined;
    }

    const [compose] = await db
      .select({ headVersionId: agentComposes.headVersionId })
      .from(agentComposes)
      .where(eq(agentComposes.id, meta.defaultAgentId))
      .limit(1);

    if (!compose?.headVersionId) {
      return undefined;
    }

    const [version] = await db
      .select({ content: agentComposeVersions.content })
      .from(agentComposeVersions)
      .where(eq(agentComposeVersions.id, compose.headVersionId))
      .limit(1);

    if (!version) {
      return undefined;
    }

    const grouped = extractAndGroupVariables(version.content);
    const requiredSecrets = grouped.secrets.map((s) => {
      return s.name;
    });
    const requiredVars = grouped.vars.map((v) => {
      return v.name;
    });

    const [userSecretList, userVarList, userConnectors] = await Promise.all([
      get(userSecrets({ orgId: auth.orgId, userId: auth.userId })),
      get(userVariables({ orgId: auth.orgId, userId: auth.userId })),
      get(zeroConnectorList({ orgId: auth.orgId, userId: auth.userId })),
    ]);

    const connectorProvided = getConnectorProvidedSecretNames(
      userConnectors.connectors.map((c) => {
        return c.type;
      }),
    );
    const existingSecretNames = new Set([
      ...userSecretList.secrets.map((s) => {
        return s.name;
      }),
      ...connectorProvided,
    ]);
    const existingVarNames = new Set(
      userVarList.variables.map((v) => {
        return v.name;
      }),
    );

    const missingSecrets = requiredSecrets.filter((name) => {
      return !existingSecretNames.has(name);
    });
    const missingVars = requiredVars.filter((name) => {
      return !existingVarNames.has(name);
    });

    return {
      requiredSecrets,
      requiredVars,
      missingSecrets,
      missingVars,
    };
  },
);

const getSlackStatusInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const status = await get(
    zeroSlackOrgStatus({
      orgId: auth.orgId,
      userId: auth.userId,
      orgRole: auth.orgRole,
    }),
  );

  const environment = status.isConnected
    ? await get(getSlackEnvironment$)
    : undefined;

  const body: z.infer<typeof slackOrgStatusSchema> = {
    isConnected: status.isConnected,
    isInstalled: status.isInstalled,
    isAdmin: status.isAdmin,
    ...(status.isConnected
      ? {
          workspaceName: status.workspaceName,
          defaultAgentName: status.defaultAgentName,
          agentOrgSlug: status.agentOrgSlug,
          ...(environment !== undefined && { environment }),
        }
      : {
          installUrl: status.installUrl,
          connectUrl: status.connectUrl,
        }),
    ...(status.scopeMismatch !== null && {
      scopeMismatch: status.scopeMismatch,
      reinstallUrl: status.reinstallUrl,
    }),
  };

  return { status: 200 as const, body };
});

function jsonErrorResponse(
  status: number,
  message: string,
  code: string,
): Response {
  return new Response(JSON.stringify({ error: { message, code } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function slackApiErrorResponse(error: unknown): Response | null {
  if (!isSlackApiClientError(error)) {
    return null;
  }

  if (error.method === "files.info" && error.code === "file_not_found") {
    return jsonErrorResponse(
      404,
      `Slack file not found: ${error.code}`,
      "NOT_FOUND",
    );
  }

  return jsonErrorResponse(
    400,
    `Slack API error: ${error.code}`,
    "SLACK_ERROR",
  );
}

function slackFileFetchErrorResponse(error: unknown): Response | null {
  if (!isSlackFileFetchError(error)) {
    return null;
  }

  switch (error.code) {
    case "invalid-url": {
      return jsonErrorResponse(
        400,
        "Invalid Slack download URL",
        "BAD_REQUEST",
      );
    }
    case "too-large": {
      return jsonErrorResponse(
        413,
        `File exceeds maximum size of ${MAX_SLACK_FILE_SIZE_BYTES} bytes`,
        "PAYLOAD_TOO_LARGE",
      );
    }
    case "download-failed": {
      return jsonErrorResponse(
        502,
        `Failed to download file from Slack: ${error.statusCode ?? "unknown"}`,
        "BAD_GATEWAY",
      );
    }
    case "html-response": {
      return jsonErrorResponse(
        502,
        "Slack returned an unexpected response (likely expired token)",
        "BAD_GATEWAY",
      );
    }
  }

  return null;
}

const getSlackDownloadFileInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(slackDownloadFileContract.download));
  const fileId = query.file_id;

  if (!fileId) {
    return jsonErrorResponse(
      400,
      "file_id query parameter is required",
      "BAD_REQUEST",
    );
  }

  const installation = await get(
    zeroSlackOrgInstallation({ orgId: auth.orgId }),
  );
  if (!installation) {
    return jsonErrorResponse(
      404,
      "No Slack installation found for this org",
      "NOT_FOUND",
    );
  }

  const fileInfoResult = await safeAsync(() => {
    return getFileInfo(installation.botToken, fileId);
  });
  if ("error" in fileInfoResult) {
    const response = slackApiErrorResponse(fileInfoResult.error);
    if (response) {
      return response;
    }
    throw fileInfoResult.error;
  }
  const fileInfo = fileInfoResult.ok;

  const downloadUrl = fileInfo.url_private_download ?? fileInfo.url_private;
  if (!downloadUrl) {
    return jsonErrorResponse(
      404,
      "File does not have a downloadable URL",
      "NOT_FOUND",
    );
  }

  if (fileInfo.size > MAX_SLACK_FILE_SIZE_BYTES) {
    return jsonErrorResponse(
      413,
      `File exceeds maximum size of ${MAX_SLACK_FILE_SIZE_BYTES} bytes`,
      "PAYLOAD_TOO_LARGE",
    );
  }

  const fileResponseResult = await safeAsync(() => {
    return fetchSlackFile(downloadUrl, installation.botToken);
  });
  if ("error" in fileResponseResult) {
    const response = slackFileFetchErrorResponse(fileResponseResult.error);
    if (response) {
      return response;
    }
    throw fileResponseResult.error;
  }
  const fileResponse = fileResponseResult.ok;

  const responseContentType = fileResponse.headers.get("content-type") ?? "";
  if (responseContentType.includes("text/html")) {
    return jsonErrorResponse(
      502,
      "Slack returned an unexpected response (likely expired token)",
      "BAD_GATEWAY",
    );
  }

  const headers = new Headers();
  const contentLength = fileResponse.headers.get("content-length");
  const contentType =
    fileInfo.mimetype || responseContentType || "application/octet-stream";

  headers.set("Content-Type", contentType);
  headers.set("X-File-Name", encodeURIComponent(fileInfo.name ?? fileId));
  headers.set("X-File-Mimetype", contentType);
  if (contentLength) {
    headers.set("Content-Length", contentLength);
  }

  return new Response(fileResponse.body, { status: 200, headers });
});

const slackReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const slackDownloadAuth = {
  ...slackReadAuth,
  requiredCapability: "slack:write",
} as const;

export const zeroIntegrationsSlackRoutes: readonly RouteEntry[] = [
  {
    route: zeroIntegrationsSlackContract.getStatus,
    handler: authRoute(slackReadAuth, getSlackStatusInner$),
  },
  {
    route: slackDownloadFileContract.download,
    handler: authRoute(slackDownloadAuth, getSlackDownloadFileInner$),
  },
];
