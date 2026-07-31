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
const FEISHU_SKILL_NAME = "feishu";
const FEISHU_SKILL_DESCRIPTION =
  "Feishu OpenAPI for user-authorized messaging, people search, cloud documents, calendars, and tasks. Use when the user asks to work with Feishu.";
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
  readonly botName: string | null;
}

interface ExistingFeishuCustomConnector {
  readonly connector: typeof orgCustomConnectors.$inferSelect;
  readonly oauthConfig:
    | typeof orgCustomConnectorOauthConfigs.$inferSelect
    | null;
}

interface ReconciledFeishuCustomConnector {
  readonly connectorId: string;
  readonly displayName: string;
}

const FEISHU_SKILL_MARKDOWN = `Use Feishu OpenAPI as the connected user to find coworkers, collaborate in chats, work with cloud content, manage calendars, and organize tasks.

## Authentication and access

Base URL: \`${FEISHU_API_PREFIX}\`

The connector automatically injects an OAuth \`Authorization: Bearer\` header for the connected Feishu user. Never request, print, store, or add an access token, and never call Feishu OAuth token endpoints yourself.

Every request runs with the connected user's identity. An operation succeeds only when both the granted OAuth scopes and that user's Feishu visibility or resource permissions allow it. Do not assume that a granted scope gives access to every person, chat, document, calendar, or task in the tenant.

## Available capabilities

- Identity and people: get the connected user's profile with \`GET /authen/v1/user_info\`; read basic contact and user information; resolve supplied email addresses or mobile numbers to user IDs; and search visible coworkers with \`GET /search/v1/user\`.
- Chats and members: list, inspect, create, and update chats through \`/im/v1/chats\`; list chat members and add or remove members when the connected user is allowed to do so.
- Messages: read visible direct and group messages through \`/im/v1/messages\`, send messages as the connected user, read or change message reactions, and access message images or files. A message's \`content\` field is a JSON-encoded string, not an embedded JSON object.
- Drive and files: inspect and manage cloud-space files and permissions, upload or download files, import local files as Feishu cloud documents, export supported cloud documents, and upload or download document media.
- Docs: create, read, and edit Docs and document blocks under \`/docx/v1/documents\`; convert Markdown or HTML into document blocks; and read, add, reply to, update, resolve, or delete comments as allowed by the comment APIs.
- Sheets, Base, and Wiki: read and edit spreadsheets under \`/sheets/v3/spreadsheets\`, multidimensional tables under \`/bitable/v1/apps\`, and knowledge spaces or nodes under \`/wiki/v2\`.
- Search and presentations: search cloud documents visible to the connected user with \`POST /search/v2/doc_wiki/search\`; read, create, update, or remove presentation content under \`/slides/v1/presentations\`.
- Whiteboards: read existing nodes and create new nodes under \`/board/v1/whiteboards\`. This connection does not grant whiteboard node update or delete scopes.
- Calendars: use \`/calendar/v4\` for calendars, events, attendees, availability, access controls, and other calendar operations available to the connected user.
- Tasks: use \`/task/v2\` to read, create, update, and delete tasks and task lists, manage assignees or followers, create subtasks, manage task-list collaborators, and add or remove tasks from lists.

## Request patterns

Do not add an \`Authorization\` header to these requests; the connector supplies it.

### Identify the connected user

~~~bash
curl -sS "https://open.feishu.cn/open-apis/authen/v1/user_info"
~~~

### Search for a coworker

~~~bash
curl -sS -G "https://open.feishu.cn/open-apis/search/v1/user" \
  --data-urlencode "query=Alice" \
  --data-urlencode "page_size=20"
~~~

The user search endpoint cannot find external-tenant or departed users. Keep the returned ID type explicit when passing a result to another API.

### Read chat history

~~~bash
curl -sS -G "https://open.feishu.cn/open-apis/im/v1/messages" \
  --data-urlencode "container_id_type=chat" \
  --data-urlencode "container_id=oc_xxx" \
  --data-urlencode "page_size=50"
~~~

### Send a text message as the connected user

Write this request to \`/tmp/feishu_message.json\`:

~~~json
{
  "receive_id": "oc_xxx",
  "msg_type": "text",
  "content": "{\\"text\\":\\"Hello\\"}"
}
~~~

Then send it:

~~~bash
curl -sS -X POST \
  "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d @/tmp/feishu_message.json
~~~

Use \`receive_id_type=open_id\` with an \`ou_xxx\` ID for a direct message.

### Search visible cloud documents

~~~bash
curl -sS -X POST \
  "https://open.feishu.cn/open-apis/search/v2/doc_wiki/search?page_size=20" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d '{"query":"quarterly plan"}'
~~~

## Operating rules

1. Prefer lookup and read requests before writes. Resolve names or shared links to exact Feishu IDs or tokens before changing anything.
2. Preserve identifiers exactly, including \`open_id\`, \`user_id\`, \`union_id\`, \`chat_id\`, \`message_id\`, file or document tokens, block IDs, spreadsheet tokens, and Base app, table, or record IDs. Do not interchange ID types.
3. Use \`Content-Type: application/json; charset=utf-8\` for JSON requests and multipart form data for uploads. For import and export jobs, follow the documented upload/create-job/poll/download sequence.
4. HTTP success does not mean Feishu success. Check that the response \`code\` is \`0\` before using \`data\`; otherwise surface the Feishu \`code\` and \`msg\`.
5. Follow \`has_more\` and \`page_token\` until enough results have been collected. Respect rate limits and use bounded retries for throttling or transient server errors.
6. Before sending messages, inviting or removing chat members, changing permissions, modifying shared content, deleting resources, or making broad calendar/task changes, summarize the intended target and impact and obtain confirmation when the user has not already made that intent explicit.
7. Consult the current Feishu API reference when an endpoint, payload, supported token type, or resource-specific limitation is uncertain.
`;

function feishuCustomConnectorSlug(installationId: string): string {
  return `_feishu-${installationId}`;
}

function feishuCustomConnectorDisplayName(botName: string | null): string {
  return botName ? `${FEISHU_DISPLAY_NAME}-${botName}` : FEISHU_DISPLAY_NAME;
}

function desiredConnectorDefinition(installation: FeishuConnectorInstallation) {
  return {
    displayName: feishuCustomConnectorDisplayName(installation.botName),
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
  installation: FeishuConnectorInstallation,
): boolean {
  const desired = desiredConnectorDefinition(installation);
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
      ...desiredConnectorDefinition(installation),
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
  return {
    connectorId: connector.id,
    displayName: feishuCustomConnectorDisplayName(installation.botName),
  };
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
      ...desiredConnectorDefinition(installation),
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
  return {
    connectorId: existing.connector.id,
    displayName: feishuCustomConnectorDisplayName(installation.botName),
  };
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
      botName: feishuOrgInstallations.botName,
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
    !connectorDefinitionMatches(existing.connector, installation) ||
    !oauthConfigMatches(existing.oauthConfig, installation);
  if (!args.configurationChanged && !needsRepair) {
    return {
      connectorId: existing.connector.id,
      displayName: feishuCustomConnectorDisplayName(installation.botName),
    };
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
        displayName: result.displayName,
        skillMarkdown: FEISHU_SKILL_MARKDOWN,
        skillName: FEISHU_SKILL_NAME,
        skillDescription: FEISHU_SKILL_DESCRIPTION,
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
