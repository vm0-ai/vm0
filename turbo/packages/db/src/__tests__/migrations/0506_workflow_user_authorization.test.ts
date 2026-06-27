import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { db, uniqueId } from "../test-db";

async function createShadowTables(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS zero_workflow_triggers_0506_shadow (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      owner_user_id text NOT NULL,
      workflow_id uuid NOT NULL,
      unattended_connector_refs jsonb,
      unattended_permission_policy jsonb
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS workflow_user_connectors_0506_shadow (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      user_id text NOT NULL,
      workflow_id uuid NOT NULL,
      connector_type varchar(50) NOT NULL,
      UNIQUE (org_id, user_id, workflow_id, connector_type)
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS workflow_user_permission_grants_0506_shadow (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      user_id text NOT NULL,
      workflow_id uuid NOT NULL,
      connector_ref varchar(64) NOT NULL,
      permission varchar(128) NOT NULL,
      action varchar(8) NOT NULL,
      expires_at timestamp,
      updated_at timestamp DEFAULT now() NOT NULL,
      UNIQUE (org_id, user_id, workflow_id, connector_ref, permission)
    )
  `);
}

async function truncateShadowTables(): Promise<void> {
  await db.execute(sql`
    TRUNCATE
      zero_workflow_triggers_0506_shadow,
      workflow_user_connectors_0506_shadow,
      workflow_user_permission_grants_0506_shadow
  `);
}

async function dropShadowTables(): Promise<void> {
  await db.execute(sql`
    DROP TABLE IF EXISTS
      zero_workflow_triggers_0506_shadow,
      workflow_user_connectors_0506_shadow,
      workflow_user_permission_grants_0506_shadow
  `);
}

async function insertLegacyTrigger(row: {
  readonly orgId: string;
  readonly ownerUserId: string;
  readonly workflowId: string;
  readonly connectorRefs: readonly string[];
  readonly permissionPolicy: Record<string, unknown>;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO zero_workflow_triggers_0506_shadow (
      org_id,
      owner_user_id,
      workflow_id,
      unattended_connector_refs,
      unattended_permission_policy
    )
    VALUES (
      ${row.orgId},
      ${row.ownerUserId},
      ${row.workflowId}::uuid,
      ${JSON.stringify(row.connectorRefs)}::jsonb,
      ${JSON.stringify(row.permissionPolicy)}::jsonb
    )
  `);
}

async function runBackfillOnShadow(): Promise<void> {
  await db.execute(sql`
    WITH legacy_connector_refs AS (
      SELECT
        zero_workflow_triggers_0506_shadow.org_id,
        zero_workflow_triggers_0506_shadow.owner_user_id AS user_id,
        zero_workflow_triggers_0506_shadow.workflow_id,
        legacy_connector.connector_type
      FROM zero_workflow_triggers_0506_shadow
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE
          WHEN jsonb_typeof(zero_workflow_triggers_0506_shadow.unattended_connector_refs) = 'array'
            THEN zero_workflow_triggers_0506_shadow.unattended_connector_refs
          ELSE '[]'::jsonb
        END
      ) AS legacy_connector(connector_type)
      WHERE legacy_connector.connector_type <> ''
      UNION
      SELECT
        zero_workflow_triggers_0506_shadow.org_id,
        zero_workflow_triggers_0506_shadow.owner_user_id AS user_id,
        zero_workflow_triggers_0506_shadow.workflow_id,
        legacy_connector.connector_type
      FROM zero_workflow_triggers_0506_shadow
      CROSS JOIN LATERAL jsonb_each(
        CASE
          WHEN jsonb_typeof(zero_workflow_triggers_0506_shadow.unattended_permission_policy) = 'object'
            THEN zero_workflow_triggers_0506_shadow.unattended_permission_policy
          ELSE '{}'::jsonb
        END
      ) AS legacy_connector(connector_type, connector_policy)
      WHERE legacy_connector.connector_type <> ''
    )
    INSERT INTO workflow_user_connectors_0506_shadow (
      org_id,
      user_id,
      workflow_id,
      connector_type
    )
    SELECT DISTINCT
      org_id,
      user_id,
      workflow_id,
      connector_type
    FROM legacy_connector_refs
    ON CONFLICT (org_id, user_id, workflow_id, connector_type) DO NOTHING
  `);

  await db.execute(sql`
    WITH legacy_permission_entries AS (
      SELECT
        zero_workflow_triggers_0506_shadow.org_id,
        zero_workflow_triggers_0506_shadow.owner_user_id AS user_id,
        zero_workflow_triggers_0506_shadow.workflow_id,
        legacy_connector.connector_ref,
        legacy_permission.permission,
        legacy_permission.action
      FROM zero_workflow_triggers_0506_shadow
      CROSS JOIN LATERAL jsonb_each(
        CASE
          WHEN jsonb_typeof(zero_workflow_triggers_0506_shadow.unattended_permission_policy) = 'object'
            THEN zero_workflow_triggers_0506_shadow.unattended_permission_policy
          ELSE '{}'::jsonb
        END
      ) AS legacy_connector(connector_ref, connector_policy)
      CROSS JOIN LATERAL jsonb_each_text(
        CASE
          WHEN jsonb_typeof(legacy_connector.connector_policy -> 'policies') = 'object'
            THEN legacy_connector.connector_policy -> 'policies'
          ELSE '{}'::jsonb
        END
      ) AS legacy_permission(permission, action)
      WHERE legacy_connector.connector_ref <> ''
        AND legacy_permission.permission <> ''
      UNION ALL
      SELECT
        zero_workflow_triggers_0506_shadow.org_id,
        zero_workflow_triggers_0506_shadow.owner_user_id AS user_id,
        zero_workflow_triggers_0506_shadow.workflow_id,
        legacy_connector.connector_ref,
        '__unknown__' AS permission,
        legacy_connector.connector_policy ->> 'unknownPolicy' AS action
      FROM zero_workflow_triggers_0506_shadow
      CROSS JOIN LATERAL jsonb_each(
        CASE
          WHEN jsonb_typeof(zero_workflow_triggers_0506_shadow.unattended_permission_policy) = 'object'
            THEN zero_workflow_triggers_0506_shadow.unattended_permission_policy
          ELSE '{}'::jsonb
        END
      ) AS legacy_connector(connector_ref, connector_policy)
      WHERE legacy_connector.connector_ref <> ''
        AND legacy_connector.connector_policy ? 'unknownPolicy'
    ),
    legacy_permission_grants AS (
      SELECT
        org_id,
        user_id,
        workflow_id,
        connector_ref,
        permission,
        bool_or(action = 'deny') AS has_deny,
        bool_or(action = 'allow') AS has_allow
      FROM legacy_permission_entries
      WHERE action IN ('allow', 'deny')
      GROUP BY
        org_id,
        user_id,
        workflow_id,
        connector_ref,
        permission
    )
    INSERT INTO workflow_user_permission_grants_0506_shadow (
      org_id,
      user_id,
      workflow_id,
      connector_ref,
      permission,
      action
    )
    SELECT
      org_id,
      user_id,
      workflow_id,
      connector_ref,
      permission,
      CASE WHEN has_deny THEN 'deny' ELSE 'allow' END
    FROM legacy_permission_grants
    WHERE has_deny OR has_allow
    ON CONFLICT (org_id, user_id, workflow_id, connector_ref, permission)
    DO UPDATE SET
      action = CASE
        WHEN workflow_user_permission_grants_0506_shadow.action = 'deny'
          OR EXCLUDED.action = 'deny'
          THEN 'deny'
        ELSE 'allow'
      END,
      expires_at = NULL,
      updated_at = now()
  `);
}

async function columnExists(column: string): Promise<boolean> {
  const result = await db.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'zero_workflow_triggers'
        AND column_name = ${column}
    ) AS exists
  `);
  return result.rows[0]?.exists === true;
}

describe("migration 0506 workflow-user authorization", () => {
  beforeEach(async () => {
    await createShadowTables();
    await truncateShadowTables();
  });

  afterAll(async () => {
    await dropShadowTables();
  });

  it("backfills trigger authorization into workflow-user grants with deny-biased conflicts", async () => {
    const orgId = uniqueId("org");
    const userId = uniqueId("user");
    const otherUserId = uniqueId("other-user");
    const workflowId = randomUUID();

    await insertLegacyTrigger({
      orgId,
      ownerUserId: userId,
      workflowId,
      connectorRefs: ["slack", "gmail"],
      permissionPolicy: {
        slack: {
          policies: {
            "channels:history": "allow",
            "chat:write": "allow",
          },
          unknownPolicy: "deny",
        },
        gmail: {
          policies: {
            "messages.send": "deny",
          },
        },
        github: {
          policies: {
            "contents:read": "allow",
          },
        },
      },
    });
    await insertLegacyTrigger({
      orgId,
      ownerUserId: userId,
      workflowId,
      connectorRefs: ["slack"],
      permissionPolicy: {
        slack: {
          policies: {
            "chat:write": "deny",
            "files:read": "allow",
          },
          unknownPolicy: "allow",
        },
      },
    });
    await insertLegacyTrigger({
      orgId,
      ownerUserId: otherUserId,
      workflowId,
      connectorRefs: ["slack"],
      permissionPolicy: {
        slack: {
          policies: {
            "chat:write": "allow",
          },
        },
      },
    });

    await runBackfillOnShadow();
    await runBackfillOnShadow();

    const connectors = await db.execute<{
      user_id: string;
      connector_type: string;
    }>(sql`
      SELECT user_id, connector_type
      FROM workflow_user_connectors_0506_shadow
      WHERE org_id = ${orgId}
      ORDER BY user_id ASC, connector_type ASC
    `);
    expect(connectors.rows).toStrictEqual([
      { user_id: otherUserId, connector_type: "slack" },
      { user_id: userId, connector_type: "github" },
      { user_id: userId, connector_type: "gmail" },
      { user_id: userId, connector_type: "slack" },
    ]);

    const grants = await db.execute<{
      user_id: string;
      connector_ref: string;
      permission: string;
      action: string;
    }>(sql`
      SELECT user_id, connector_ref, permission, action
      FROM workflow_user_permission_grants_0506_shadow
      WHERE org_id = ${orgId}
      ORDER BY
        user_id ASC,
        connector_ref ASC,
        permission ASC
    `);
    expect(grants.rows).toStrictEqual([
      {
        user_id: otherUserId,
        connector_ref: "slack",
        permission: "chat:write",
        action: "allow",
      },
      {
        user_id: userId,
        connector_ref: "github",
        permission: "contents:read",
        action: "allow",
      },
      {
        user_id: userId,
        connector_ref: "gmail",
        permission: "messages.send",
        action: "deny",
      },
      {
        user_id: userId,
        connector_ref: "slack",
        permission: "__unknown__",
        action: "deny",
      },
      {
        user_id: userId,
        connector_ref: "slack",
        permission: "channels:history",
        action: "allow",
      },
      {
        user_id: userId,
        connector_ref: "slack",
        permission: "chat:write",
        action: "deny",
      },
      {
        user_id: userId,
        connector_ref: "slack",
        permission: "files:read",
        action: "allow",
      },
    ]);
  });

  it("drops legacy authorization columns from workflow triggers", async () => {
    expect(await columnExists("unattended_connector_refs")).toBe(false);
    expect(await columnExists("unattended_permission_policy")).toBe(false);
  });
});
