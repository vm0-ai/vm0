import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { connectors } from "@vm0/db/schema/connector";
import { secrets } from "@vm0/db/schema/secret";
import { variables } from "@vm0/db/schema/variable";
import { db, uniqueId } from "../test-db";

const ORG_SENTINEL_USER_ID = "__org__";

interface ApiTokenMigrationField {
  readonly connectorType: string;
  readonly fieldName: string;
  readonly storage: string;
  readonly required: boolean;
}

const REPRESENTATIVE_API_TOKEN_MIGRATION_FIELDS = sortApiTokenMigrationFields([
  {
    connectorType: "agora",
    fieldName: "AGORA_APP_CERTIFICATE",
    storage: "secret",
    required: false,
  },
  {
    connectorType: "agora",
    fieldName: "AGORA_APP_ID",
    storage: "variable",
    required: true,
  },
  {
    connectorType: "agora",
    fieldName: "AGORA_CUSTOMER_ID",
    storage: "secret",
    required: true,
  },
  {
    connectorType: "agora",
    fieldName: "AGORA_CUSTOMER_SECRET",
    storage: "secret",
    required: true,
  },
  {
    connectorType: "gitlab",
    fieldName: "GITLAB_HOST",
    storage: "variable",
    required: false,
  },
  {
    connectorType: "gitlab",
    fieldName: "GITLAB_TOKEN",
    storage: "secret",
    required: true,
  },
  {
    connectorType: "openai",
    fieldName: "OPENAI_TOKEN",
    storage: "secret",
    required: true,
  },
]);

function apiTokenMigrationFieldKey(field: ApiTokenMigrationField): string {
  return [field.connectorType, field.fieldName, field.storage].join("\0");
}

function sortApiTokenMigrationFields(
  fields: readonly ApiTokenMigrationField[],
): readonly ApiTokenMigrationField[] {
  return [...fields].sort((left, right) => {
    return apiTokenMigrationFieldKey(left).localeCompare(
      apiTokenMigrationFieldKey(right),
    );
  });
}

function apiTokenMigrationFieldsFromSql(): readonly ApiTokenMigrationField[] {
  const sqlText = readFileSync(
    new URL(
      "../../migrations/0410_api_token_connector_cutover.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const fieldPattern =
    /\('([^']+)', '([^']+)', '(secret|variable)', (true|false)\)/gu;
  return sortApiTokenMigrationFields(
    [...sqlText.matchAll(fieldPattern)].map((match) => {
      return {
        connectorType: match[1]!,
        fieldName: match[2]!,
        storage: match[3]!,
        required: match[4] === "true",
      };
    }),
  );
}

async function runScopedApiTokenConnectorCutover(args: {
  readonly orgId: string;
  readonly userId: string;
}): Promise<void> {
  await db.execute(sql`
    WITH api_token_fields(connector_type, field_name, storage, required) AS (
      VALUES
        ('agora', 'AGORA_APP_CERTIFICATE', 'secret', false),
        ('agora', 'AGORA_APP_ID', 'variable', true),
        ('agora', 'AGORA_CUSTOMER_ID', 'secret', true),
        ('agora', 'AGORA_CUSTOMER_SECRET', 'secret', true),
        ('gitlab', 'GITLAB_HOST', 'variable', false),
        ('gitlab', 'GITLAB_TOKEN', 'secret', true),
        ('openai', 'OPENAI_TOKEN', 'secret', true)
    ),
    required_field_counts AS (
      SELECT
        connector_type,
        COUNT(*) FILTER (WHERE required) AS required_count
      FROM api_token_fields
      GROUP BY connector_type
    ),
    legacy_field_presence AS (
      SELECT
        fields.connector_type,
        user_secrets.org_id,
        user_secrets.user_id,
        fields.field_name,
        fields.storage,
        fields.required
      FROM api_token_fields fields
      JOIN secrets user_secrets
        ON fields.storage = 'secret'
       AND user_secrets.type = 'user'
       AND user_secrets.name = fields.field_name
       AND user_secrets.org_id = ${args.orgId}
       AND user_secrets.user_id = ${args.userId}
       AND user_secrets.user_id <> ${ORG_SENTINEL_USER_ID}

      UNION ALL

      SELECT
        fields.connector_type,
        user_variables.org_id,
        user_variables.user_id,
        fields.field_name,
        fields.storage,
        fields.required
      FROM api_token_fields fields
      JOIN variables user_variables
        ON fields.storage = 'variable'
       AND user_variables.type = 'user'
       AND user_variables.name = fields.field_name
       AND user_variables.org_id = ${args.orgId}
       AND user_variables.user_id = ${args.userId}
       AND user_variables.user_id <> ${ORG_SENTINEL_USER_ID}
    ),
    eligible_legacy_connectors AS (
      SELECT
        presence.connector_type,
        presence.org_id,
        presence.user_id
      FROM legacy_field_presence presence
      JOIN required_field_counts counts
        ON counts.connector_type = presence.connector_type
      WHERE NOT EXISTS (
        SELECT 1
        FROM connectors existing_connector
        WHERE existing_connector.org_id = presence.org_id
          AND existing_connector.user_id = presence.user_id
          AND existing_connector.type = presence.connector_type
      )
      GROUP BY
        presence.connector_type,
        presence.org_id,
        presence.user_id,
        counts.required_count
      HAVING COUNT(DISTINCT presence.field_name) FILTER (WHERE presence.required) = counts.required_count
         AND counts.required_count > 0
    ),
    migrated_connectors AS (
      INSERT INTO connectors (
        org_id,
        user_id,
        type,
        auth_method,
        needs_reconnect,
        created_at,
        updated_at
      )
      SELECT
        eligible.org_id,
        eligible.user_id,
        eligible.connector_type,
        'api-token',
        false,
        NOW(),
        NOW()
      FROM eligible_legacy_connectors eligible
      ON CONFLICT (org_id, user_id, type) DO NOTHING
      RETURNING org_id, user_id, type
    ),
    copied_secrets AS (
      INSERT INTO secrets (
        org_id,
        user_id,
        name,
        encrypted_value,
        description,
        type,
        created_at,
        updated_at
      )
      SELECT
        source.org_id,
        source.user_id,
        source.name,
        source.encrypted_value,
        source.description,
        'connector',
        source.created_at,
        source.updated_at
      FROM migrated_connectors migrated
      JOIN api_token_fields fields
        ON fields.connector_type = migrated.type
       AND fields.storage = 'secret'
      JOIN secrets source
        ON source.org_id = migrated.org_id
       AND source.user_id = migrated.user_id
       AND source.type = 'user'
       AND source.name = fields.field_name
      ON CONFLICT (org_id, user_id, name, type) DO UPDATE SET
        encrypted_value = EXCLUDED.encrypted_value,
        description = EXCLUDED.description,
        updated_at = EXCLUDED.updated_at
      RETURNING org_id, user_id, name
    ),
    copied_variables AS (
      INSERT INTO variables (
        org_id,
        user_id,
        name,
        value,
        description,
        type,
        created_at,
        updated_at
      )
      SELECT
        source.org_id,
        source.user_id,
        source.name,
        source.value,
        source.description,
        'connector',
        source.created_at,
        source.updated_at
      FROM migrated_connectors migrated
      JOIN api_token_fields fields
        ON fields.connector_type = migrated.type
       AND fields.storage = 'variable'
      JOIN variables source
        ON source.org_id = migrated.org_id
       AND source.user_id = migrated.user_id
       AND source.type = 'user'
       AND source.name = fields.field_name
      ON CONFLICT (org_id, user_id, type, name) DO UPDATE SET
        value = EXCLUDED.value,
        description = EXCLUDED.description,
        updated_at = EXCLUDED.updated_at
      RETURNING org_id, user_id, name
    ),
    deleted_legacy_secrets AS (
      DELETE FROM secrets legacy
      USING copied_secrets copied
      WHERE legacy.org_id = copied.org_id
        AND legacy.user_id = copied.user_id
        AND legacy.name = copied.name
        AND legacy.type = 'user'
      RETURNING legacy.id
    ),
    deleted_legacy_variables AS (
      DELETE FROM variables legacy
      USING copied_variables copied
      WHERE legacy.org_id = copied.org_id
        AND legacy.user_id = copied.user_id
        AND legacy.name = copied.name
        AND legacy.type = 'user'
      RETURNING legacy.id
    )
    SELECT
      (SELECT COUNT(*) FROM migrated_connectors) AS migrated_connectors,
      (SELECT COUNT(*) FROM copied_secrets) AS copied_secrets,
      (SELECT COUNT(*) FROM copied_variables) AS copied_variables,
      (SELECT COUNT(*) FROM deleted_legacy_secrets) AS deleted_legacy_secrets,
      (SELECT COUNT(*) FROM deleted_legacy_variables) AS deleted_legacy_variables
  `);
}

async function readConnectorTypes(args: {
  readonly orgId: string;
  readonly userId: string;
}): Promise<readonly { readonly type: string; readonly authMethod: string }[]> {
  return await db
    .select({ type: connectors.type, authMethod: connectors.authMethod })
    .from(connectors)
    .where(
      and(eq(connectors.orgId, args.orgId), eq(connectors.userId, args.userId)),
    )
    .orderBy(connectors.type);
}

async function readSecretState(args: {
  readonly orgId: string;
  readonly userId: string;
}): Promise<
  readonly {
    readonly name: string;
    readonly encryptedValue: string;
    readonly type: string;
  }[]
> {
  return await db
    .select({
      name: secrets.name,
      encryptedValue: secrets.encryptedValue,
      type: secrets.type,
    })
    .from(secrets)
    .where(and(eq(secrets.orgId, args.orgId), eq(secrets.userId, args.userId)))
    .orderBy(secrets.name, secrets.type);
}

async function readVariableState(args: {
  readonly orgId: string;
  readonly userId: string;
}): Promise<
  readonly {
    readonly name: string;
    readonly value: string;
    readonly type: string;
  }[]
> {
  return await db
    .select({
      name: variables.name,
      value: variables.value,
      type: variables.type,
    })
    .from(variables)
    .where(
      and(eq(variables.orgId, args.orgId), eq(variables.userId, args.userId)),
    )
    .orderBy(variables.name, variables.type);
}

describe("migration 0410 api-token connector cutover", () => {
  it("keeps representative cutover fields in the migration SQL", () => {
    const sampleConnectorTypes = new Set(
      REPRESENTATIVE_API_TOKEN_MIGRATION_FIELDS.map((field) => {
        return field.connectorType;
      }),
    );
    expect(
      apiTokenMigrationFieldsFromSql().filter((field) => {
        return sampleConnectorTypes.has(field.connectorType);
      }),
    ).toStrictEqual(
      sortApiTokenMigrationFields(REPRESENTATIVE_API_TOKEN_MIGRATION_FIELDS),
    );
  });

  it("migrates complete required secret rows and preserves unrelated user rows", async () => {
    const orgId = uniqueId("org");
    const userId = uniqueId("user");
    await db.insert(secrets).values([
      {
        orgId,
        userId,
        name: "OPENAI_TOKEN",
        encryptedValue: "encrypted-openai",
        type: "user",
      },
      {
        orgId,
        userId,
        name: "UNRELATED_SECRET",
        encryptedValue: "encrypted-unrelated",
        type: "user",
      },
    ]);
    await db.insert(variables).values({
      orgId,
      userId,
      name: "UNRELATED_VAR",
      value: "unrelated",
      type: "user",
    });

    await runScopedApiTokenConnectorCutover({ orgId, userId });

    expect(await readConnectorTypes({ orgId, userId })).toStrictEqual([
      { type: "openai", authMethod: "api-token" },
    ]);
    expect(await readSecretState({ orgId, userId })).toStrictEqual([
      {
        name: "OPENAI_TOKEN",
        encryptedValue: "encrypted-openai",
        type: "connector",
      },
      {
        name: "UNRELATED_SECRET",
        encryptedValue: "encrypted-unrelated",
        type: "user",
      },
    ]);
    expect(await readVariableState({ orgId, userId })).toStrictEqual([
      { name: "UNRELATED_VAR", value: "unrelated", type: "user" },
    ]);
  });

  it("copies present optional fields for complete connectors", async () => {
    const orgId = uniqueId("org");
    const userId = uniqueId("user");
    await db.insert(secrets).values({
      orgId,
      userId,
      name: "GITLAB_TOKEN",
      encryptedValue: "encrypted-gitlab",
      type: "user",
    });
    await db.insert(variables).values({
      orgId,
      userId,
      name: "GITLAB_HOST",
      value: "gitlab.example.com",
      type: "user",
    });

    await runScopedApiTokenConnectorCutover({ orgId, userId });

    expect(await readConnectorTypes({ orgId, userId })).toStrictEqual([
      { type: "gitlab", authMethod: "api-token" },
    ]);
    expect(await readSecretState({ orgId, userId })).toStrictEqual([
      {
        name: "GITLAB_TOKEN",
        encryptedValue: "encrypted-gitlab",
        type: "connector",
      },
    ]);
    expect(await readVariableState({ orgId, userId })).toStrictEqual([
      { name: "GITLAB_HOST", value: "gitlab.example.com", type: "connector" },
    ]);
  });

  it("migrates complete connectors when optional fields are absent", async () => {
    const orgId = uniqueId("org");
    const userId = uniqueId("user");
    await db.insert(secrets).values({
      orgId,
      userId,
      name: "GITLAB_TOKEN",
      encryptedValue: "encrypted-gitlab",
      type: "user",
    });

    await runScopedApiTokenConnectorCutover({ orgId, userId });

    expect(await readConnectorTypes({ orgId, userId })).toStrictEqual([
      { type: "gitlab", authMethod: "api-token" },
    ]);
    expect(await readSecretState({ orgId, userId })).toStrictEqual([
      {
        name: "GITLAB_TOKEN",
        encryptedValue: "encrypted-gitlab",
        type: "connector",
      },
    ]);
    expect(await readVariableState({ orgId, userId })).toStrictEqual([]);
  });

  it("migrates mixed secret and variable requirements with optional secrets", async () => {
    const orgId = uniqueId("org");
    const userId = uniqueId("user");
    await db.insert(secrets).values([
      {
        orgId,
        userId,
        name: "AGORA_APP_CERTIFICATE",
        encryptedValue: "encrypted-certificate",
        type: "user",
      },
      {
        orgId,
        userId,
        name: "AGORA_CUSTOMER_ID",
        encryptedValue: "encrypted-customer-id",
        type: "user",
      },
      {
        orgId,
        userId,
        name: "AGORA_CUSTOMER_SECRET",
        encryptedValue: "encrypted-customer-secret",
        type: "user",
      },
    ]);
    await db.insert(variables).values({
      orgId,
      userId,
      name: "AGORA_APP_ID",
      value: "agora-app-id",
      type: "user",
    });

    await runScopedApiTokenConnectorCutover({ orgId, userId });

    expect(await readConnectorTypes({ orgId, userId })).toStrictEqual([
      { type: "agora", authMethod: "api-token" },
    ]);
    expect(await readSecretState({ orgId, userId })).toStrictEqual([
      {
        name: "AGORA_APP_CERTIFICATE",
        encryptedValue: "encrypted-certificate",
        type: "connector",
      },
      {
        name: "AGORA_CUSTOMER_ID",
        encryptedValue: "encrypted-customer-id",
        type: "connector",
      },
      {
        name: "AGORA_CUSTOMER_SECRET",
        encryptedValue: "encrypted-customer-secret",
        type: "connector",
      },
    ]);
    expect(await readVariableState({ orgId, userId })).toStrictEqual([
      { name: "AGORA_APP_ID", value: "agora-app-id", type: "connector" },
    ]);
  });

  it("skips connectors when a required variable is absent", async () => {
    const orgId = uniqueId("org");
    const userId = uniqueId("user");
    await db.insert(secrets).values([
      {
        orgId,
        userId,
        name: "AGORA_CUSTOMER_ID",
        encryptedValue: "encrypted-customer-id",
        type: "user",
      },
      {
        orgId,
        userId,
        name: "AGORA_CUSTOMER_SECRET",
        encryptedValue: "encrypted-customer-secret",
        type: "user",
      },
    ]);

    await runScopedApiTokenConnectorCutover({ orgId, userId });

    expect(await readConnectorTypes({ orgId, userId })).toStrictEqual([]);
    expect(await readSecretState({ orgId, userId })).toStrictEqual([
      {
        name: "AGORA_CUSTOMER_ID",
        encryptedValue: "encrypted-customer-id",
        type: "user",
      },
      {
        name: "AGORA_CUSTOMER_SECRET",
        encryptedValue: "encrypted-customer-secret",
        type: "user",
      },
    ]);
    expect(await readVariableState({ orgId, userId })).toStrictEqual([]);
  });

  it("skips incomplete required fields", async () => {
    const orgId = uniqueId("org");
    const userId = uniqueId("user");
    await db.insert(variables).values({
      orgId,
      userId,
      name: "GITLAB_HOST",
      value: "gitlab.example.com",
      type: "user",
    });

    await runScopedApiTokenConnectorCutover({ orgId, userId });

    expect(await readConnectorTypes({ orgId, userId })).toStrictEqual([]);
    expect(await readVariableState({ orgId, userId })).toStrictEqual([
      { name: "GITLAB_HOST", value: "gitlab.example.com", type: "user" },
    ]);
  });

  it("preserves org-level credential rows with connector field names", async () => {
    const orgId = uniqueId("org");
    await db.insert(secrets).values({
      orgId,
      userId: ORG_SENTINEL_USER_ID,
      name: "GITLAB_TOKEN",
      encryptedValue: "encrypted-org-gitlab",
      type: "user",
    });
    await db.insert(variables).values({
      orgId,
      userId: ORG_SENTINEL_USER_ID,
      name: "GITLAB_HOST",
      value: "gitlab.example.com",
      type: "user",
    });

    await runScopedApiTokenConnectorCutover({
      orgId,
      userId: ORG_SENTINEL_USER_ID,
    });

    expect(
      await readConnectorTypes({ orgId, userId: ORG_SENTINEL_USER_ID }),
    ).toStrictEqual([]);
    expect(
      await readSecretState({ orgId, userId: ORG_SENTINEL_USER_ID }),
    ).toStrictEqual([
      {
        name: "GITLAB_TOKEN",
        encryptedValue: "encrypted-org-gitlab",
        type: "user",
      },
    ]);
    expect(
      await readVariableState({ orgId, userId: ORG_SENTINEL_USER_ID }),
    ).toStrictEqual([
      { name: "GITLAB_HOST", value: "gitlab.example.com", type: "user" },
    ]);
  });

  it("skips users with an existing connector row and keeps legacy rows untouched", async () => {
    const orgId = uniqueId("org");
    const userId = uniqueId("user");
    await db.insert(connectors).values({
      orgId,
      userId,
      type: "openai",
      authMethod: "oauth",
    });
    await db.insert(secrets).values({
      orgId,
      userId,
      name: "OPENAI_TOKEN",
      encryptedValue: "encrypted-openai",
      type: "user",
    });

    await runScopedApiTokenConnectorCutover({ orgId, userId });

    expect(await readConnectorTypes({ orgId, userId })).toStrictEqual([
      { type: "openai", authMethod: "oauth" },
    ]);
    expect(await readSecretState({ orgId, userId })).toStrictEqual([
      {
        name: "OPENAI_TOKEN",
        encryptedValue: "encrypted-openai",
        type: "user",
      },
    ]);
  });
});
