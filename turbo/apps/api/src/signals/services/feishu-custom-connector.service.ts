import { isDeepStrictEqual } from "node:util";

import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { FEISHU_OAUTH_SCOPES } from "@vm0/api-contracts/contracts/zero-feishu-connect";
import { connectors } from "@vm0/db/schema/connector";
import { feishuOrgInstallations } from "@vm0/db/schema/feishu-org-installation";
import { orgCustomConnectorOauthConfigs } from "@vm0/db/schema/org-custom-connector-oauth-config";
import { orgCustomConnectors } from "@vm0/db/schema/org-custom-connector";
import { secrets } from "@vm0/db/schema/secret";

import { nowDate } from "../external/time";
import { writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { syncCustomConnectorSkillVolume$ } from "./custom-connector-skill-volume.service";

const FEISHU_API_PREFIX = "https://open.feishu.cn/open-apis/";
const FEISHU_AUTHORIZATION_URL =
  "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
const FEISHU_TOKEN_URL =
  "https://open.feishu.cn/open-apis/authen/v2/oauth/token";
const FEISHU_DISPLAY_NAME = "Feishu";
const FEISHU_AUTHORIZATION_HEADER = "Authorization";
const FEISHU_AUTHORIZATION_TEMPLATE = "Bearer {{oauth.access_token}}";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

interface EnsureFeishuCustomConnectorArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly installationId: string;
  readonly configurationChanged?: boolean;
}

interface FeishuConnectorInstallation {
  readonly orgId: string;
  readonly ownerUserId: string | null;
  readonly appId: string;
  readonly encryptedAppSecret: string;
}

interface ExistingFeishuCustomConnector {
  readonly connector: typeof orgCustomConnectors.$inferSelect;
  readonly oauthConfig:
    | typeof orgCustomConnectorOauthConfigs.$inferSelect
    | null;
}

interface ReconciledFeishuCustomConnector {
  readonly connectorId: string;
}

const FEISHU_SKILL_MARKDOWN = `Use this connector for everyday Feishu collaboration through the OpenAPI base URL \`${FEISHU_API_PREFIX}\`.

Authentication is injected automatically. Never request, print, store, or add an access token yourself.

## Core API areas

- Identity: \`GET /authen/v1/user_info\`.
- Chats and messages: use \`/im/v1/chats\` and \`/im/v1/messages\` to list chats, read messages, send messages, reply, edit, recall, and manage reactions. Message \`content\` is a JSON-encoded string.
- Message files: upload through \`/im/v1/images\` or \`/im/v1/files\`; download message resources through \`/im/v1/messages/{message_id}/resources/{file_key}\`.
- Drive and files: use \`/drive/v1/files\`, import/export APIs, and permission APIs under \`/drive/v1/permissions\`.
- Documents: create and edit documents and blocks under \`/docx/v1/documents\`. Use the document block conversion API when turning Markdown or HTML into blocks.
- Sheets, Base, Wiki, Slides, and whiteboards: use \`/sheets/v3/spreadsheets\`, \`/bitable/v1/apps\`, \`/wiki/v2/spaces\`, \`/slides/v1/presentations\`, and \`/board/v1/whiteboards\`.
- Search, calendar, and tasks: use \`/search/v2\`, \`/calendar/v4\`, and \`/task/v2\`.

## Operating rules

1. Prefer the narrowest read or write operation that completes the request.
2. Preserve Feishu identifiers exactly, including \`open_id\`, \`chat_id\`, document tokens, block IDs, spreadsheet tokens, and app/table/record IDs.
3. For JSON requests, send \`Content-Type: application/json; charset=utf-8\`. Use multipart form data for uploads.
4. A successful HTTP response can still contain a Feishu error. Check that the response \`code\` is \`0\` before using \`data\`; otherwise report \`code\` and \`msg\`.
5. Follow \`has_more\` and \`page_token\` when a list response is paginated.
6. Confirm destructive or broadly shared changes before deleting content, changing permissions, or messaging many people.
`;

function feishuCustomConnectorSlug(installationId: string): string {
  return `_feishu-${installationId}`;
}

function desiredConnectorDefinition() {
  return {
    displayName: FEISHU_DISPLAY_NAME,
    prefixes: [FEISHU_API_PREFIX],
    headerName: FEISHU_AUTHORIZATION_HEADER,
    headerTemplate: FEISHU_AUTHORIZATION_TEMPLATE,
    prefixTemplates: [FEISHU_API_PREFIX],
    fields: [],
    headerInjections: [
      {
        name: FEISHU_AUTHORIZATION_HEADER,
        valueTemplate: FEISHU_AUTHORIZATION_TEMPLATE,
      },
    ],
    queryInjections: [],
    authMode: "oauth" as const,
    enabled: true,
    permissionBundleRef: null,
    skillMarkdown: FEISHU_SKILL_MARKDOWN,
  };
}

function desiredOAuthConfig(installation: FeishuConnectorInstallation) {
  return {
    orgId: installation.orgId,
    providerAdapter: "feishu" as const,
    clientId: installation.appId,
    encryptedClientSecret: installation.encryptedAppSecret,
    authorizationUrl: FEISHU_AUTHORIZATION_URL,
    tokenUrl: FEISHU_TOKEN_URL,
    tokenEndpointAuthMethod: "client_secret_post" as const,
    pkceMethod: "none" as const,
    scopes: [...FEISHU_OAUTH_SCOPES],
    authorizationParams: {},
  };
}

function connectorDefinitionMatches(
  connector: typeof orgCustomConnectors.$inferSelect,
): boolean {
  const desired = desiredConnectorDefinition();
  return (
    connector.displayName === desired.displayName &&
    isDeepStrictEqual(connector.prefixes, desired.prefixes) &&
    connector.headerName === desired.headerName &&
    connector.headerTemplate === desired.headerTemplate &&
    isDeepStrictEqual(connector.prefixTemplates, desired.prefixTemplates) &&
    isDeepStrictEqual(connector.fields, desired.fields) &&
    isDeepStrictEqual(connector.headerInjections, desired.headerInjections) &&
    isDeepStrictEqual(connector.queryInjections, desired.queryInjections) &&
    connector.authMode === desired.authMode &&
    connector.enabled === desired.enabled &&
    connector.permissionBundleRef === desired.permissionBundleRef &&
    connector.skillMarkdown === desired.skillMarkdown
  );
}

function oauthConfigMatches(
  config: typeof orgCustomConnectorOauthConfigs.$inferSelect | null,
  installation: FeishuConnectorInstallation,
): boolean {
  if (!config) {
    return false;
  }
  return (
    config.orgId === installation.orgId &&
    config.providerAdapter === "feishu" &&
    config.clientId === installation.appId &&
    config.encryptedClientSecret === installation.encryptedAppSecret &&
    config.authorizationUrl === FEISHU_AUTHORIZATION_URL &&
    config.tokenUrl === FEISHU_TOKEN_URL &&
    config.tokenEndpointAuthMethod === "client_secret_post" &&
    config.pkceMethod === "none" &&
    isDeepStrictEqual(config.scopes, FEISHU_OAUTH_SCOPES) &&
    isDeepStrictEqual(config.authorizationParams, {})
  );
}

async function createFeishuCustomConnector(
  tx: DbTransaction,
  args: EnsureFeishuCustomConnectorArgs,
  installation: FeishuConnectorInstallation,
  slug: string,
  signal: AbortSignal,
): Promise<ReconciledFeishuCustomConnector> {
  const [connector] = await tx
    .insert(orgCustomConnectors)
    .values({
      orgId: args.orgId,
      slug,
      ...desiredConnectorDefinition(),
      createdBy: installation.ownerUserId ?? args.userId,
    })
    .returning({ id: orgCustomConnectors.id });
  signal.throwIfAborted();
  if (!connector) {
    throw new Error("Expected Feishu custom connector to be created");
  }
  await tx.insert(orgCustomConnectorOauthConfigs).values({
    connectorId: connector.id,
    ...desiredOAuthConfig(installation),
  });
  signal.throwIfAborted();
  return { connectorId: connector.id };
}

async function repairFeishuCustomConnector(
  tx: DbTransaction,
  args: EnsureFeishuCustomConnectorArgs,
  installation: FeishuConnectorInstallation,
  existing: ExistingFeishuCustomConnector,
  signal: AbortSignal,
): Promise<ReconciledFeishuCustomConnector> {
  await tx
    .update(orgCustomConnectors)
    .set({
      ...desiredConnectorDefinition(),
      revision: existing.connector.revision + 1,
      updatedAt: nowDate(),
    })
    .where(eq(orgCustomConnectors.id, existing.connector.id));
  signal.throwIfAborted();
  const oauthConfig = desiredOAuthConfig(installation);
  await tx
    .insert(orgCustomConnectorOauthConfigs)
    .values({
      connectorId: existing.connector.id,
      ...oauthConfig,
    })
    .onConflictDoUpdate({
      target: orgCustomConnectorOauthConfigs.connectorId,
      set: {
        ...oauthConfig,
        updatedAt: nowDate(),
      },
    });
  signal.throwIfAborted();
  await tx
    .delete(connectors)
    .where(
      and(
        eq(connectors.customConnectorId, existing.connector.id),
        eq(connectors.orgId, args.orgId),
      ),
    );
  signal.throwIfAborted();
  return { connectorId: existing.connector.id };
}

async function reconcileFeishuCustomConnector(
  tx: DbTransaction,
  args: EnsureFeishuCustomConnectorArgs,
  signal: AbortSignal,
): Promise<ReconciledFeishuCustomConnector | null> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`feishu_custom_connector:${args.installationId}`}, 0))`,
  );
  signal.throwIfAborted();
  const [installation] = await tx
    .select({
      orgId: feishuOrgInstallations.orgId,
      ownerUserId: feishuOrgInstallations.ownerUserId,
      appId: feishuOrgInstallations.appId,
      encryptedAppSecret: feishuOrgInstallations.encryptedAppSecret,
    })
    .from(feishuOrgInstallations)
    .where(
      and(
        eq(feishuOrgInstallations.id, args.installationId),
        eq(feishuOrgInstallations.orgId, args.orgId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!installation) {
    return null;
  }

  const slug = feishuCustomConnectorSlug(args.installationId);
  const [existing] = await tx
    .select({
      connector: orgCustomConnectors,
      oauthConfig: orgCustomConnectorOauthConfigs,
    })
    .from(orgCustomConnectors)
    .leftJoin(
      orgCustomConnectorOauthConfigs,
      and(
        eq(orgCustomConnectorOauthConfigs.connectorId, orgCustomConnectors.id),
        eq(orgCustomConnectorOauthConfigs.orgId, orgCustomConnectors.orgId),
      ),
    )
    .where(
      and(
        eq(orgCustomConnectors.orgId, args.orgId),
        eq(orgCustomConnectors.slug, slug),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!existing) {
    return await createFeishuCustomConnector(
      tx,
      args,
      installation,
      slug,
      signal,
    );
  }

  const needsRepair =
    !connectorDefinitionMatches(existing.connector) ||
    !oauthConfigMatches(existing.oauthConfig, installation);
  if (!args.configurationChanged && !needsRepair) {
    return { connectorId: existing.connector.id };
  }
  return await repairFeishuCustomConnector(
    tx,
    args,
    installation,
    existing,
    signal,
  );
}

export const ensureFeishuCustomConnector$ = command(
  async (
    { set },
    args: EnsureFeishuCustomConnectorArgs,
    signal: AbortSignal,
  ): Promise<string | null> => {
    const db = set(writeDb$);
    const result = await db.transaction(async (tx) => {
      return await reconcileFeishuCustomConnector(tx, args, signal);
    });
    signal.throwIfAborted();
    if (!result) {
      return null;
    }
    await set(
      syncCustomConnectorSkillVolume$,
      {
        orgId: args.orgId,
        connectorId: result.connectorId,
        connectorSlug: feishuCustomConnectorSlug(args.installationId),
        displayName: FEISHU_DISPLAY_NAME,
        skillMarkdown: FEISHU_SKILL_MARKDOWN,
      },
      signal,
    );
    signal.throwIfAborted();
    return result.connectorId;
  },
);

export const deleteFeishuCustomConnector$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly installationId: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const [deleted] = await set(writeDb$)
      .delete(orgCustomConnectors)
      .where(
        and(
          eq(orgCustomConnectors.orgId, args.orgId),
          eq(
            orgCustomConnectors.slug,
            feishuCustomConnectorSlug(args.installationId),
          ),
        ),
      )
      .returning({ id: orgCustomConnectors.id });
    signal.throwIfAborted();
    if (!deleted) {
      return;
    }
    await set(
      syncCustomConnectorSkillVolume$,
      {
        orgId: args.orgId,
        connectorId: deleted.id,
        connectorSlug: feishuCustomConnectorSlug(args.installationId),
        displayName: FEISHU_DISPLAY_NAME,
        skillMarkdown: null,
      },
      signal,
    );
    signal.throwIfAborted();
  },
);

export async function hasFeishuCustomConnectorOAuthConnection(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly installationId: string;
  },
): Promise<boolean> {
  const [connection] = await db
    .select({ id: connectors.id })
    .from(orgCustomConnectors)
    .innerJoin(
      connectors,
      and(
        eq(connectors.customConnectorId, orgCustomConnectors.id),
        eq(connectors.orgId, orgCustomConnectors.orgId),
      ),
    )
    .innerJoin(
      secrets,
      and(
        eq(secrets.connectorId, connectors.id),
        eq(secrets.name, "access_token"),
      ),
    )
    .where(
      and(
        eq(orgCustomConnectors.orgId, args.orgId),
        eq(
          orgCustomConnectors.slug,
          feishuCustomConnectorSlug(args.installationId),
        ),
        eq(connectors.userId, args.userId),
        eq(connectors.authMethod, "oauth"),
        eq(connectors.needsReconnect, false),
      ),
    )
    .limit(1);
  return Boolean(connection);
}

export async function disconnectFeishuCustomConnectorOAuthConnection(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly installationId: string;
  },
): Promise<void> {
  const [connector] = await db
    .select({ id: orgCustomConnectors.id })
    .from(orgCustomConnectors)
    .where(
      and(
        eq(orgCustomConnectors.orgId, args.orgId),
        eq(
          orgCustomConnectors.slug,
          feishuCustomConnectorSlug(args.installationId),
        ),
      ),
    )
    .limit(1);
  if (!connector) {
    return;
  }
  await db
    .delete(connectors)
    .where(
      and(
        eq(connectors.customConnectorId, connector.id),
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
      ),
    );
}
