import { testCustomConnectorSkillRepairStateContract } from "@vm0/api-contracts/contracts/test-custom-connector-skill-repair-state";
import {
  getCustomConnectorSkillStorageName,
  VOLUME_ORG_USER_ID,
} from "@vm0/core/storage-names";
import { feishuOrgInstallations } from "@vm0/db/schema/feishu-org-installation";
import { orgCustomConnectorOauthConfigs } from "@vm0/db/schema/org-custom-connector-oauth-config";
import { orgCustomConnectors } from "@vm0/db/schema/org-custom-connector";
import { storages } from "@vm0/db/schema/storage";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";

import { notFound } from "../../lib/error";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";
import { getFeishuCustomConnectorSlug } from "../services/feishu-custom-connector-skill-metadata";

const actionBody$ = bodyResultOf(
  testCustomConnectorSkillRepairStateContract.action,
);

async function readConnectorIdentity(
  db: Db,
  connectorId: string,
  signal: AbortSignal,
) {
  const [connector] = await db
    .select({
      id: orgCustomConnectors.id,
      orgId: orgCustomConnectors.orgId,
      slug: orgCustomConnectors.slug,
    })
    .from(orgCustomConnectors)
    .where(eq(orgCustomConnectors.id, connectorId))
    .limit(1);
  signal.throwIfAborted();
  return connector;
}

async function readState(db: Db, connectorId: string, signal: AbortSignal) {
  const [connector] = await db
    .select({
      id: orgCustomConnectors.id,
      orgId: orgCustomConnectors.orgId,
      slug: orgCustomConnectors.slug,
      skillMarkdown: orgCustomConnectors.skillMarkdown,
      skillStorageVersionId: orgCustomConnectors.skillStorageVersionId,
      oauthProviderAdapter: orgCustomConnectorOauthConfigs.providerAdapter,
    })
    .from(orgCustomConnectors)
    .leftJoin(
      orgCustomConnectorOauthConfigs,
      and(
        eq(orgCustomConnectorOauthConfigs.connectorId, orgCustomConnectors.id),
        eq(orgCustomConnectorOauthConfigs.orgId, orgCustomConnectors.orgId),
      ),
    )
    .where(eq(orgCustomConnectors.id, connectorId))
    .limit(1);
  signal.throwIfAborted();
  if (!connector) {
    return undefined;
  }
  const [storage] = await db
    .select({ id: storages.id, headVersionId: storages.headVersionId })
    .from(storages)
    .where(
      and(
        eq(storages.orgId, connector.orgId),
        eq(storages.userId, VOLUME_ORG_USER_ID),
        eq(storages.name, getCustomConnectorSkillStorageName(connector.id)),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  const installations = await db
    .select({ id: feishuOrgInstallations.id })
    .from(feishuOrgInstallations)
    .where(eq(feishuOrgInstallations.orgId, connector.orgId));
  signal.throwIfAborted();
  const managedFeishuInstallation = installations.find((installation) => {
    return getFeishuCustomConnectorSlug(installation.id) === connector.slug;
  });
  return {
    connector: {
      skillMarkdown: connector.skillMarkdown,
      skillStorageVersionId: connector.skillStorageVersionId,
      oauthProviderAdapter: connector.oauthProviderAdapter,
      managedFeishuInstallationId: managedFeishuInstallation?.id ?? null,
    },
    storage: storage ?? null,
  };
}

const action$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!isTestEndpointAllowed(get(request$))) {
    return testEndpointNotFoundResponse();
  }
  const bodyResult = await get(actionBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const db = set(writeDb$);
  const body = bodyResult.data;
  if (body.action === "set-connector") {
    const values: {
      skillMarkdown?: string | null;
      skillStorageVersionId?: string | null;
    } = {};
    if (body.skillMarkdown !== undefined) {
      values.skillMarkdown = body.skillMarkdown;
    }
    if (body.skillStorageVersionId !== undefined) {
      values.skillStorageVersionId = body.skillStorageVersionId;
    }
    await db
      .update(orgCustomConnectors)
      .set(values)
      .where(eq(orgCustomConnectors.id, body.connectorId));
    signal.throwIfAborted();
  } else if (body.action === "set-provider-adapter") {
    const [oauthConfig] = await db
      .update(orgCustomConnectorOauthConfigs)
      .set({ providerAdapter: body.providerAdapter })
      .where(eq(orgCustomConnectorOauthConfigs.connectorId, body.connectorId))
      .returning({ connectorId: orgCustomConnectorOauthConfigs.connectorId });
    signal.throwIfAborted();
    if (!oauthConfig) {
      return notFound("Custom connector repair fixture OAuth config not found");
    }
  } else if (body.action === "set-managed-feishu-installation") {
    const connector = await readConnectorIdentity(db, body.connectorId, signal);
    if (!connector) {
      return notFound("Custom connector repair fixture target not found");
    }
    await db
      .update(orgCustomConnectors)
      .set({ slug: getFeishuCustomConnectorSlug(body.installationId) })
      .where(eq(orgCustomConnectors.id, connector.id));
    signal.throwIfAborted();
    await db
      .insert(feishuOrgInstallations)
      .values({
        id: body.installationId,
        orgId: connector.orgId,
        appId: `repair-test-${body.installationId}`,
        encryptedAppSecret: "repair-test-app-secret",
        encryptedVerificationToken: "repair-test-verification-token",
        encryptedEncryptKey: "repair-test-encrypt-key",
        defaultComposeId: body.defaultComposeId,
      })
      .onConflictDoNothing();
    signal.throwIfAborted();
  } else if (body.action === "clear-managed-feishu-installation") {
    const connector = await readConnectorIdentity(db, body.connectorId, signal);
    if (!connector) {
      return notFound("Custom connector repair fixture target not found");
    }
    await db
      .delete(feishuOrgInstallations)
      .where(
        and(
          eq(feishuOrgInstallations.id, body.installationId),
          eq(feishuOrgInstallations.orgId, connector.orgId),
        ),
      );
    signal.throwIfAborted();
  } else if (body.action === "set-head") {
    const connector = await readConnectorIdentity(db, body.connectorId, signal);
    if (!connector) {
      return notFound("Custom connector repair fixture target not found");
    }
    const [storage] = await db
      .update(storages)
      .set({ headVersionId: body.headVersionId })
      .where(
        and(
          eq(storages.orgId, connector.orgId),
          eq(storages.userId, VOLUME_ORG_USER_ID),
          eq(storages.name, getCustomConnectorSkillStorageName(connector.id)),
        ),
      )
      .returning({ id: storages.id });
    signal.throwIfAborted();
    if (!storage) {
      return notFound("Custom connector repair fixture storage not found");
    }
  }

  const state = await readState(db, body.connectorId, signal);
  if (!state) {
    return notFound("Custom connector repair fixture target not found");
  }
  return { status: 200 as const, body: { ok: true as const, state } };
});

export const testCustomConnectorSkillRepairStateRoutes: readonly RouteEntry[] =
  [
    {
      route: testCustomConnectorSkillRepairStateContract.action,
      handler: action$,
    },
  ];
