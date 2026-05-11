import { command } from "ccstate";
import { integrationsSlackUploadInitContract } from "@vm0/api-contracts/contracts/integrations";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import {
  createSlackClient,
  getUploadUrlExternal,
} from "../external/slack-message-client";
import { zeroSlackOrgInstallation } from "../services/zero-slack-data.service";
import type { RouteEntry } from "../route";

const noInstallation = Object.freeze({
  status: 404 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "No Slack installation found for this organization",
      code: "NOT_FOUND",
    }),
  }),
});

const initInner$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);

  const bodyResult = await get(
    bodyResultOf(integrationsSlackUploadInitContract.init),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const installation = await get(
    zeroSlackOrgInstallation({ orgId: auth.orgId }),
  );
  signal.throwIfAborted();
  if (!installation) {
    return noInstallation;
  }

  const client = createSlackClient(installation.botToken);
  const result = await getUploadUrlExternal(client, {
    filename: bodyResult.data.filename,
    length: bodyResult.data.length,
  });
  signal.throwIfAborted();

  if (result.kind === "slack_error") {
    return {
      status: 400 as const,
      body: {
        error: {
          message: `Slack API error: ${result.error}`,
          code: "SLACK_ERROR",
        },
      },
    };
  }

  return {
    status: 200 as const,
    body: {
      uploadUrl: result.uploadUrl,
      fileId: result.fileId,
    },
  };
});

const slackWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "slack:write",
} as const;

export const zeroIntegrationsSlackUploadInitRoutes: readonly RouteEntry[] = [
  {
    route: integrationsSlackUploadInitContract.init,
    handler: authRoute(slackWriteAuth, initInner$),
  },
];
