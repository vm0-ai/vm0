import { computed } from "ccstate";
import { initContract } from "@ts-rest/core";
import { z } from "zod";
import {
  slackOrgStatusSchema,
  zeroIntegrationsSlackContract,
} from "@vm0/api-contracts/contracts/zero-integrations-slack";
import { authHeadersSchema } from "@vm0/api-contracts/contracts/base";
import { apiErrorSchema } from "@vm0/api-contracts/contracts/errors";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import { shadowCompareRoute } from "../context/shadow-compare";
import {
  zeroSlackOrgInstallation,
  zeroSlackOrgStatus,
} from "../services/zero-slack-data.service";
import { getFileInfo } from "../external/slack-client";
import { fetchSlackFile } from "../external/slack-file-fetcher";
import type { RouteEntry } from "../route";

const c = initContract();

const slackDownloadFileContract = c.router({
  download: {
    method: "GET",
    path: "/api/zero/integrations/slack/download-file",
    headers: authHeadersSchema,
    query: z.object({
      file_id: z.string().min(1),
    }),
    responses: {
      200: c.otherResponse({
        contentType: "application/octet-stream",
        body: z.unknown(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary: "Download a Slack file via org bot token",
  },
});

const getSlackStatusInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const status = await get(
    zeroSlackOrgStatus({
      orgId: auth.orgId,
      userId: auth.userId,
    }),
  );

  const body: z.infer<typeof slackOrgStatusSchema> = {
    isConnected: status.isConnected,
    isInstalled: status.isInstalled,
    isAdmin: status.isAdmin,
    workspaceName: status.workspaceName,
    installUrl: status.installUrl,
    connectUrl: status.connectUrl,
    defaultAgentName: status.defaultAgentName,
    agentOrgSlug: status.agentOrgSlug,
  };

  return { status: 200 as const, body };
});

const getSlackDownloadFileInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(slackDownloadFileContract.download));

  const installation = await get(
    zeroSlackOrgInstallation({ orgId: auth.orgId }),
  );
  if (!installation) {
    return new Response(
      JSON.stringify({
        error: {
          message: "No Slack installation found for this org",
          code: "NOT_FOUND",
        },
      }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  return getFileInfo(installation.botToken, query.file_id)
    .then((fileInfo) => {
      const downloadUrl = fileInfo.url_private_download ?? fileInfo.url_private;
      if (!downloadUrl) {
        return new Response(
          JSON.stringify({
            error: {
              message: "File does not have a downloadable URL",
              code: "NOT_FOUND",
            },
          }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }

      return fetchSlackFile(downloadUrl, installation.botToken).then(
        (fileResponse) => {
          const headers = new Headers();
          const contentLength = fileResponse.headers.get("content-length");
          const contentType =
            fileResponse.headers.get("content-type") ??
            fileInfo.mimetype ??
            "application/octet-stream";

          headers.set("Content-Type", contentType);
          headers.set(
            "X-File-Name",
            encodeURIComponent(fileInfo.name ?? query.file_id),
          );
          headers.set("X-File-Mimetype", contentType);
          if (contentLength) {
            headers.set("Content-Length", contentLength);
          }

          return new Response(fileResponse.body, { status: 200, headers });
        },
      );
    })
    .catch((error) => {
      return new Response(
        JSON.stringify({
          error: {
            message:
              error instanceof Error
                ? error.message
                : "Failed to download file",
            code: "BAD_GATEWAY",
          },
        }),
        {
          status: 502,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
});

const slackReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

export const zeroIntegrationsSlackRoutes: readonly RouteEntry[] = [
  {
    route: zeroIntegrationsSlackContract.getStatus,
    handler: shadowCompareRoute({
      route: zeroIntegrationsSlackContract.getStatus,
      handler: authRoute(slackReadAuth, getSlackStatusInner$),
    }),
  },
  {
    route: slackDownloadFileContract.download,
    handler: authRoute(slackReadAuth, getSlackDownloadFileInner$),
  },
];
