import { command, computed, type Getter } from "ccstate";
import { initContract } from "@ts-rest/core";
import { z } from "zod";
import type { View } from "@slack/web-api";
import {
  slackOrgStatusSchema,
  zeroIntegrationsSlackContract,
} from "@vm0/api-contracts/contracts/zero-integrations-slack";
import { authHeadersSchema } from "@vm0/api-contracts/contracts/base";
import { apiErrorSchema } from "@vm0/api-contracts/contracts/errors";
import { extractAndGroupVariables } from "@vm0/core/variable-expander";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { and, eq } from "drizzle-orm";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import {
  zeroSlackOrgInstallation,
  zeroSlackOrgStatus,
} from "../services/zero-slack-data.service";
import { publishSlackAdminSignal$ } from "../services/zero-slack-connect.service";
import { getFileInfo, isSlackApiClientError } from "../../lib/slack-client";
import {
  fetchSlackFile,
  isSlackFileFetchError,
  MAX_SLACK_FILE_SIZE_BYTES,
} from "../external/slack-file-fetcher";
import { createSlackClient } from "../external/slack-message-client";
import { db$, writeDb$, type Db } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { zeroConnectorList } from "../services/zero-connector-data.service";
import { userSecrets, userVariables } from "../services/zero-user-data.service";
import { decryptPersistentSecretValue } from "../services/crypto.utils";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import { env } from "../../lib/env";
import type { RouteEntry } from "../route";
import { bestEffort, settle } from "../utils";

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

type SlackEnvironment = NonNullable<
  z.infer<typeof slackOrgStatusSchema>["environment"]
>;

function emptySlackEnvironment(): SlackEnvironment {
  return {
    requiredSecrets: [],
    requiredVars: [],
    missingSecrets: [],
    missingVars: [],
  };
}

const getSlackEnvironment$ = computed(
  async (get): Promise<SlackEnvironment> => {
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
      return emptySlackEnvironment();
    }

    const [compose] = await db
      .select({ headVersionId: agentComposes.headVersionId })
      .from(agentComposes)
      .where(eq(agentComposes.id, meta.defaultAgentId))
      .limit(1);

    if (!compose?.headVersionId) {
      return emptySlackEnvironment();
    }

    const [version] = await db
      .select({ content: agentComposeVersions.content })
      .from(agentComposeVersions)
      .where(eq(agentComposeVersions.id, compose.headVersionId))
      .limit(1);

    if (!version) {
      return emptySlackEnvironment();
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

    const existingSecretNames = new Set([
      ...userSecretList.secrets.map((s) => {
        return s.name;
      }),
      ...userConnectors.connectorProvidedEnvNames,
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

  const statusFields = status.isConnected
    ? {
        workspaceName: status.workspaceName,
        defaultAgentName: status.defaultAgentName,
        agentOrgSlug: status.agentOrgSlug,
        environment: await get(getSlackEnvironment$),
      }
    : {
        installUrl: status.installUrl,
        connectUrl: status.connectUrl,
      };
  const body: z.infer<typeof slackOrgStatusSchema> = {
    isConnected: status.isConnected,
    isInstalled: status.isInstalled,
    isAdmin: status.isAdmin,
    ...statusFields,
    ...(status.scopeMismatch !== null && {
      scopeMismatch: status.scopeMismatch,
      reinstallUrl: status.reinstallUrl,
    }),
  };

  return { status: 200 as const, body };
});

function contractErrorResponse(
  status: 403 | 404,
  message: string,
  code: "FORBIDDEN" | "NOT_FOUND",
) {
  return {
    status,
    body: { error: { message, code } },
  };
}

async function publishAppHome(
  client: ReturnType<typeof createSlackClient>,
  userId: string,
  view: View,
): Promise<void> {
  await client.views.publish({ user_id: userId, view });
}

function buildConnectUrl(workspaceId: string, slackUserId: string): string {
  const params = new URLSearchParams({ w: workspaceId, u: slackUserId });
  return `${env("APP_URL")}/settings/slack?${params.toString()}`;
}

function buildDisconnectedAppHomeView(args: {
  readonly workspaceId: string;
  readonly slackUserId: string;
}): View {
  return {
    type: "home",
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "Welcome to Zero! :wave:" },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Connect your AI agents to Slack and interact with them through messages.",
        },
      },
      { type: "divider" },
      {
        type: "section",
        text: { type: "mrkdwn", text: ":x: *Account not connected*" },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Connect" },
            url: buildConnectUrl(args.workspaceId, args.slackUserId),
            action_id: "home_login_prompt",
            style: "primary",
          },
        ],
      },
    ],
  };
}

function buildUninstalledAppHomeView(): View {
  return {
    type: "home",
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "Welcome to Zero! :wave:" },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Connect your AI agents to Slack and interact with them through messages.",
        },
      },
      { type: "divider" },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: ":warning: *Zero is not installed for this workspace*\nAsk a workspace admin to install Zero from the platform.",
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Open Zero Settings" },
            url: `${env("APP_URL")}/works`,
            action_id: "home_open_settings",
            style: "primary",
          },
        ],
      },
    ],
  };
}

const deleteSlackIntegrationQuery$ = queryOf(
  zeroIntegrationsSlackContract.disconnect,
);

async function decryptSlackInstallationToken(args: {
  readonly get: Getter;
  readonly orgId: string;
  readonly userId: string;
  readonly encryptedBotToken: string;
}): Promise<string> {
  return await decryptPersistentSecretValue(
    args.encryptedBotToken,
    await args.get(userFeatureSwitchContext(args.orgId, args.userId)),
  );
}

async function uninstallSlackIntegration(args: {
  readonly get: Getter;
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly publishChanged: () => Promise<void>;
  readonly signal: AbortSignal;
}) {
  const [installation] = await args.db
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.orgId, args.orgId))
    .limit(1);
  args.signal.throwIfAborted();

  if (!installation) {
    return contractErrorResponse(
      404,
      "No Slack installation found",
      "NOT_FOUND",
    );
  }

  const connections = await args.db
    .select({
      slackUserId: slackOrgConnections.slackUserId,
      vm0UserId: slackOrgConnections.vm0UserId,
    })
    .from(slackOrgConnections)
    .where(
      eq(slackOrgConnections.slackWorkspaceId, installation.slackWorkspaceId),
    );
  args.signal.throwIfAborted();

  if (connections.length > 0) {
    const client = createSlackClient(
      await decryptSlackInstallationToken({
        get: args.get,
        orgId: args.orgId,
        userId: args.userId,
        encryptedBotToken: installation.encryptedBotToken,
      }),
    );
    const view = buildUninstalledAppHomeView();
    await Promise.allSettled(
      connections.map((connection) => {
        return publishAppHome(client, connection.slackUserId, view);
      }),
    );
    args.signal.throwIfAborted();
  }

  await args.db
    .delete(slackOrgConnections)
    .where(
      eq(slackOrgConnections.slackWorkspaceId, installation.slackWorkspaceId),
    );
  args.signal.throwIfAborted();

  await args.db
    .delete(slackOrgInstallations)
    .where(
      eq(slackOrgInstallations.slackWorkspaceId, installation.slackWorkspaceId),
    );
  args.signal.throwIfAborted();

  await args.publishChanged();
  args.signal.throwIfAborted();

  await bestEffort(
    publishUserSignal(
      Array.from(
        new Set([
          args.userId,
          ...connections.map((connection) => {
            return connection.vm0UserId;
          }),
        ]),
      ),
      "slack:changed",
    ),
    args.signal,
  );
  args.signal.throwIfAborted();

  return { status: 200 as const, body: { ok: true } };
}

async function disconnectSlackIntegration(args: {
  readonly get: Getter;
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly signal: AbortSignal;
}) {
  const [installation] = await args.db
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.orgId, args.orgId))
    .limit(1);
  args.signal.throwIfAborted();

  if (!installation) {
    return contractErrorResponse(404, "No Slack connection found", "NOT_FOUND");
  }

  const [connection] = await args.db
    .select({
      id: slackOrgConnections.id,
      slackUserId: slackOrgConnections.slackUserId,
    })
    .from(slackOrgConnections)
    .where(
      and(
        eq(slackOrgConnections.vm0UserId, args.userId),
        eq(slackOrgConnections.slackWorkspaceId, installation.slackWorkspaceId),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();

  if (!connection) {
    return contractErrorResponse(404, "No Slack connection found", "NOT_FOUND");
  }

  await args.db
    .delete(slackOrgConnections)
    .where(eq(slackOrgConnections.id, connection.id));
  args.signal.throwIfAborted();

  const client = createSlackClient(
    await decryptSlackInstallationToken({
      get: args.get,
      orgId: args.orgId,
      userId: args.userId,
      encryptedBotToken: installation.encryptedBotToken,
    }),
  );
  await bestEffort(
    publishAppHome(
      client,
      connection.slackUserId,
      buildDisconnectedAppHomeView({
        workspaceId: installation.slackWorkspaceId,
        slackUserId: connection.slackUserId,
      }),
    ),
  );
  args.signal.throwIfAborted();

  await bestEffort(
    publishUserSignal([args.userId], "slack:changed"),
    args.signal,
  );
  args.signal.throwIfAborted();

  return { status: 200 as const, body: { ok: true } };
}

const deleteSlackIntegration$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const query = get(deleteSlackIntegrationQuery$);
    const db = set(writeDb$);

    if (query.action === "uninstall") {
      if (auth.orgRole !== "admin") {
        return contractErrorResponse(403, "Admin access required", "FORBIDDEN");
      }

      return await uninstallSlackIntegration({
        get,
        db,
        orgId: auth.orgId,
        userId: auth.userId,
        publishChanged: async () => {
          await set(
            publishSlackAdminSignal$,
            { orgId: auth.orgId, topic: "slack:changed" },
            signal,
          );
        },
        signal,
      });
    }

    return await disconnectSlackIntegration({
      get,
      db,
      orgId: auth.orgId,
      userId: auth.userId,
      signal,
    });
  },
);

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
    zeroSlackOrgInstallation({ orgId: auth.orgId, userId: auth.userId }),
  );
  if (!installation) {
    return jsonErrorResponse(
      404,
      "No Slack installation found for this org",
      "NOT_FOUND",
    );
  }

  const fileInfoResult = await settle(
    getFileInfo(installation.botToken, fileId),
  );
  if (!fileInfoResult.ok) {
    const response = slackApiErrorResponse(fileInfoResult.error);
    if (response) {
      return response;
    }
    throw fileInfoResult.error;
  }
  const fileInfo = fileInfoResult.value;

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

  const fileResponseResult = await settle(
    fetchSlackFile(downloadUrl, installation.botToken),
  );
  if (!fileResponseResult.ok) {
    const response = slackFileFetchErrorResponse(fileResponseResult.error);
    if (response) {
      return response;
    }
    throw fileResponseResult.error;
  }
  const fileResponse = fileResponseResult.value;

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
    route: zeroIntegrationsSlackContract.disconnect,
    handler: authRoute(slackReadAuth, deleteSlackIntegration$),
  },
  {
    route: slackDownloadFileContract.download,
    handler: authRoute(slackDownloadAuth, getSlackDownloadFileInner$),
  },
];
