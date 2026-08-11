import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  runCustomCredentialBackfill,
  type StoredSecretKmsClient,
  type StoredSecretKmsDecryptRequest,
} from "../../scripts/migrations/012-custom-connector-credentials/backfill";
import { connectors } from "../schema/connector";
import { orgCustomConnectorSecrets } from "../schema/org-custom-connector-secret";
import { orgCustomConnectorValues } from "../schema/org-custom-connector-value";
import {
  orgCustomConnectors,
  type OrgCustomConnectorField,
} from "../schema/org-custom-connector";
import { secrets } from "../schema/secret";
import { variables } from "../schema/variable";

const DATA_KEY = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
const FIXED_FIRST_ID = "00000000-0000-4000-8000-000000000001";
const FIXED_SECOND_ID = "00000000-0000-4000-8000-000000000002";

type TestDatabase = PostgresJsDatabase<Record<string, never>>;

interface ConnectorFixture {
  readonly definitionId: string;
  readonly connectionId: string | null;
  readonly orgId: string;
  readonly userId: string;
}

class FakeKmsClient implements StoredSecretKmsClient {
  readonly requests: StoredSecretKmsDecryptRequest[] = [];
  readonly plaintextResponses: Uint8Array[] = [];
  fail = false;
  beforeFirstDecrypt?: () => Promise<void>;
  response?: (request: StoredSecretKmsDecryptRequest) => Uint8Array;
  #calledHook = false;

  async decrypt(request: StoredSecretKmsDecryptRequest): Promise<Uint8Array> {
    this.requests.push(request);
    if (!this.#calledHook && this.beforeFirstDecrypt) {
      this.#calledHook = true;
      await this.beforeFirstDecrypt();
    }
    if (this.fail) {
      throw new Error("fake KMS failure containing test-only details");
    }
    const plaintext = this.response?.(request) ?? Buffer.from(DATA_KEY);
    this.plaintextResponses.push(plaintext);
    return plaintext;
  }
}

let adminClient: Sql;
let databaseClient: Sql;
let db: TestDatabase;
let schemaName: string;
let reportDirectory: string;
let reportSequence = 0;
let connectorSequence = 0;

function requiredDatabaseUrl(): string {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) {
    throw new Error(
      "DATABASE_URL is required for the migration integration test",
    );
  }
  return value;
}

async function createIsolatedSchema(): Promise<void> {
  schemaName = `credential_backfill_${randomUUID().replaceAll("-", "")}`;
  await adminClient.unsafe(`CREATE SCHEMA "${schemaName}"`);
  for (const table of [
    "org_custom_connectors",
    "connectors",
    "org_custom_connector_values",
    "org_custom_connector_secrets",
    "secrets",
    "variables",
  ]) {
    await adminClient.unsafe(
      `CREATE TABLE "${schemaName}"."${table}" (LIKE public."${table}" INCLUDING ALL)`,
    );
  }
  await adminClient.unsafe(`
    ALTER TABLE "${schemaName}".connectors
      ADD FOREIGN KEY (custom_connector_id, org_id)
      REFERENCES "${schemaName}".org_custom_connectors (id, org_id)
      ON DELETE CASCADE;
    ALTER TABLE "${schemaName}".org_custom_connector_values
      ADD FOREIGN KEY (connector_id, org_id)
      REFERENCES "${schemaName}".org_custom_connectors (id, org_id)
      ON DELETE CASCADE;
    ALTER TABLE "${schemaName}".org_custom_connector_secrets
      ADD FOREIGN KEY (connector_id, org_id)
      REFERENCES "${schemaName}".org_custom_connectors (id, org_id)
      ON DELETE CASCADE;
    ALTER TABLE "${schemaName}".secrets
      ADD FOREIGN KEY (connector_id, org_id, user_id)
      REFERENCES "${schemaName}".connectors (id, org_id, user_id)
      ON DELETE CASCADE;
    ALTER TABLE "${schemaName}".variables
      ADD FOREIGN KEY (connector_id, org_id, user_id)
      REFERENCES "${schemaName}".connectors (id, org_id, user_id)
      ON DELETE CASCADE
  `);
}

function storedSecretEnvelope(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", DATA_KEY, iv, {
    authTagLength: 16,
  });
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const envelope = {
    v: 1,
    kind: "stored-secret",
    kms: {
      keyId: "alias/vm0-secrets-test",
      encryptedDataKey: Buffer.from("wrapped-test-data-key", "utf8").toString(
        "base64",
      ),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    },
  };
  return `vm0secret:v1:${Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url")}`;
}

function directStoredSecretEnvelope(ciphertext: string): string {
  const envelope = {
    v: 1,
    kind: "stored-secret",
    kms: {
      keyId: "alias/vm0-secrets-test",
      ciphertext: Buffer.from(ciphertext, "utf8").toString("base64"),
    },
  };
  return `vm0secret:v1:${Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url")}`;
}

function nextReportPath(label: string): string {
  reportSequence += 1;
  return join(reportDirectory, `${reportSequence}-${label}.json`);
}

async function createConnector(args: {
  readonly fields: readonly OrgCustomConnectorField[];
  readonly authMode?: "manual" | "oauth";
  readonly createConnection?: boolean;
  readonly definitionStorageVersion?: number;
  readonly connectionStorageVersion?: number;
}): Promise<ConnectorFixture> {
  connectorSequence += 1;
  const definitionId = randomUUID();
  const connectionId = args.createConnection === false ? null : randomUUID();
  const orgId = `org_migration_${connectorSequence}`;
  const userId = `user_migration_${connectorSequence}`;
  const authMode = args.authMode ?? "manual";
  const definitionStorageVersion = args.definitionStorageVersion ?? 1;
  await db.insert(orgCustomConnectors).values({
    id: definitionId,
    orgId,
    slug: `_migration-${connectorSequence}`,
    displayName: `Migration ${connectorSequence}`,
    prefixTemplates: [`https://migration-${connectorSequence}.example.com`],
    fields: [...args.fields],
    headerInjections: [
      { name: "Authorization", valueTemplate: "Bearer migration-test" },
    ],
    queryInjections: [],
    authMode,
    storageVersion: definitionStorageVersion,
    createdBy: userId,
  });
  if (connectionId) {
    await db.insert(connectors).values({
      id: connectionId,
      customConnectorId: definitionId,
      connectorSlug: null,
      authMethod: authMode,
      storageVersion: args.connectionStorageVersion ?? definitionStorageVersion,
      orgId,
      userId,
    });
  }
  return { definitionId, connectionId, orgId, userId };
}

async function addValue(
  fixture: ConnectorFixture,
  args: {
    readonly kind: string;
    readonly key: string;
    readonly encryptedValue: string;
    readonly id?: string;
  },
): Promise<string> {
  const [row] = await db
    .insert(orgCustomConnectorValues)
    .values({
      id: args.id,
      connectorId: fixture.definitionId,
      orgId: fixture.orgId,
      userId: fixture.userId,
      kind: args.kind,
      key: args.key,
      encryptedValue: args.encryptedValue,
    })
    .returning({ id: orgCustomConnectorValues.id });
  if (!row) {
    throw new Error("Expected Custom connector value fixture");
  }
  return row.id;
}

async function addLegacySecret(
  fixture: ConnectorFixture,
  encryptedValue: string,
): Promise<string> {
  const [row] = await db
    .insert(orgCustomConnectorSecrets)
    .values({
      connectorId: fixture.definitionId,
      orgId: fixture.orgId,
      userId: fixture.userId,
      encryptedValue,
    })
    .returning({ id: orgCustomConnectorSecrets.id });
  if (!row) {
    throw new Error("Expected legacy Custom connector secret fixture");
  }
  return row.id;
}

async function runBackfill(args: {
  readonly mode: "dry-run" | "migrate";
  readonly kms?: StoredSecretKmsClient;
  readonly batchSize?: number;
  readonly cursor?: string;
  readonly reportLabel: string;
}) {
  return await runCustomCredentialBackfill({
    db,
    kms: args.kms ?? new FakeKmsClient(),
    options: {
      mode: args.mode,
      batchSize: args.batchSize ?? 100,
      cursor: args.cursor,
      reportPath: nextReportPath(args.reportLabel),
    },
  });
}

beforeAll(async () => {
  const databaseUrl = requiredDatabaseUrl();
  adminClient = postgres(databaseUrl, { max: 1 });
  await createIsolatedSchema();
  databaseClient = postgres(databaseUrl, { max: 1 });
  await databaseClient.unsafe(`SET search_path TO "${schemaName}"`);
  db = drizzle(databaseClient);
  reportDirectory = await mkdtemp(
    join(tmpdir(), "vm0-custom-credential-backfill-"),
  );
});

beforeEach(async () => {
  await databaseClient.unsafe(`
    TRUNCATE TABLE
      org_custom_connector_values,
      org_custom_connector_secrets,
      secrets,
      variables,
      connectors,
      org_custom_connectors
    CASCADE
  `);
});

afterAll(async () => {
  if (typeof databaseClient !== "undefined") {
    await databaseClient.end();
  }
  if (typeof adminClient !== "undefined") {
    await adminClient.unsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
    await adminClient.end();
  }
  if (typeof reportDirectory !== "undefined") {
    await rm(reportDirectory, { recursive: true, force: true });
  }
});

describe("Custom connector credential backfill", () => {
  it("keeps dry-run non-mutating and writes a sanitized readiness report", async () => {
    const fixture = await createConnector({
      fields: [
        {
          key: "api_key",
          label: "API key",
          kind: "secret",
          required: true,
        },
        {
          key: "region",
          label: "Region",
          kind: "variable",
          required: true,
        },
      ],
    });
    const secretPlaintext = "secret-value-that-must-not-appear";
    const variablePlaintext = "region-value-that-must-not-appear";
    const secretEnvelope = storedSecretEnvelope(secretPlaintext);
    const variableEnvelope = storedSecretEnvelope(variablePlaintext);
    await addValue(fixture, {
      kind: "secret",
      key: "api_key",
      encryptedValue: secretEnvelope,
    });
    await addValue(fixture, {
      kind: "variable",
      key: "region",
      encryptedValue: variableEnvelope,
    });
    const kms = new FakeKmsClient();

    const report = await runBackfill({
      mode: "dry-run",
      kms,
      reportLabel: "dry-run",
    });

    expect(report.counts).toMatchObject({ target_missing: 2 });
    expect(report).toMatchObject({
      complete: true,
      ready: false,
      blockingDifferences: 2,
    });
    expect(await db.select().from(secrets)).toHaveLength(0);
    expect(await db.select().from(variables)).toHaveLength(0);
    expect(kms.requests).toHaveLength(1);
    expect(kms.requests[0]).toMatchObject({
      keyId: "alias/vm0-secrets-test",
      encryptionContext: { purpose: "vm0-stored-secret" },
    });
    expect(
      Buffer.from(kms.requests[0]?.ciphertext ?? []).toString("utf8"),
    ).toBe("wrapped-test-data-key");
    expect(kms.plaintextResponses).toHaveLength(1);
    expect(
      Buffer.from(kms.plaintextResponses[0] ?? []).equals(
        Buffer.alloc(DATA_KEY.length),
      ),
    ).toBe(true);

    const serialized = JSON.stringify(report);
    for (const forbidden of [
      secretPlaintext,
      variablePlaintext,
      secretEnvelope,
      variableEnvelope,
      fixture.orgId,
      fixture.userId,
      fixture.definitionId,
      fixture.connectionId ?? "missing-connection-id",
      "api_key",
      "region",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("migrates exact values idempotently and requires a final full dry-run", async () => {
    const fixture = await createConnector({
      fields: [
        {
          key: "api_key",
          label: "API key",
          kind: "secret",
          required: true,
        },
        {
          key: "region",
          label: "Region",
          kind: "variable",
          required: true,
        },
      ],
    });
    const secretEnvelope = storedSecretEnvelope("secret-value");
    const variableEnvelope = storedSecretEnvelope("us-west-2");
    await addValue(fixture, {
      kind: "secret",
      key: "api_key",
      encryptedValue: secretEnvelope,
    });
    await addValue(fixture, {
      kind: "variable",
      key: "region",
      encryptedValue: variableEnvelope,
    });
    await db.insert(secrets).values({
      connectorId: fixture.connectionId,
      orgId: fixture.orgId,
      userId: fixture.userId,
      name: "api_key",
      encryptedValue: secretEnvelope,
      description: "stale secret description",
      type: "connector",
    });
    await db.insert(variables).values({
      connectorId: fixture.connectionId,
      orgId: fixture.orgId,
      userId: fixture.userId,
      name: "region",
      value: "stale-region",
      description: "stale variable description",
      type: "connector",
    });

    const migrated = await runBackfill({
      mode: "migrate",
      reportLabel: "migrate",
    });
    expect(migrated).toMatchObject({ complete: true, ready: false });
    expect(migrated.counts).toMatchObject({ updated: 2 });
    expect(await db.select().from(secrets)).toEqual([
      expect.objectContaining({
        connectorId: fixture.connectionId,
        name: "api_key",
        encryptedValue: secretEnvelope,
        description: null,
      }),
    ]);
    expect(await db.select().from(variables)).toEqual([
      expect.objectContaining({
        connectorId: fixture.connectionId,
        name: "region",
        value: "us-west-2",
        description: null,
      }),
    ]);
    expect(await db.select().from(orgCustomConnectorValues)).toHaveLength(2);

    const rerun = await runBackfill({
      mode: "migrate",
      reportLabel: "migrate-rerun",
    });
    expect(rerun.counts).toMatchObject({ already_current: 2 });
    expect(rerun.ready).toBe(false);

    const readiness = await runBackfill({
      mode: "dry-run",
      reportLabel: "readiness",
    });
    expect(readiness).toMatchObject({
      complete: true,
      ready: true,
      blockingDifferences: 0,
    });
  });

  it("supports direct KMS envelopes without exposing decrypted variables", async () => {
    const fixture = await createConnector({
      fields: [
        {
          key: "region",
          label: "Region",
          kind: "variable",
          required: true,
        },
      ],
    });
    const plaintext = "direct-kms-plaintext";
    const kmsCiphertext = "direct-kms-ciphertext";
    const envelope = directStoredSecretEnvelope(kmsCiphertext);
    await addValue(fixture, {
      kind: "variable",
      key: "region",
      encryptedValue: envelope,
    });
    const kms = new FakeKmsClient();
    kms.response = () => {
      return Buffer.from(plaintext, "utf8");
    };

    const report = await runBackfill({
      mode: "dry-run",
      kms,
      reportLabel: "direct-kms",
    });

    expect(report.counts).toMatchObject({ target_missing: 1 });
    expect(kms.requests).toHaveLength(1);
    expect(kms.requests[0]).toMatchObject({
      keyId: "alias/vm0-secrets-test",
      encryptionContext: { purpose: "vm0-stored-secret" },
    });
    expect(
      Buffer.from(kms.requests[0]?.ciphertext ?? []).toString("utf8"),
    ).toBe(kmsCiphertext);
    expect(kms.plaintextResponses).toHaveLength(1);
    expect(
      Buffer.from(kms.plaintextResponses[0] ?? []).equals(
        Buffer.alloc(Buffer.byteLength(plaintext)),
      ),
    ).toBe(true);
    expect(JSON.stringify(report)).not.toContain(plaintext);
    expect(JSON.stringify(report)).not.toContain(envelope);
  });

  it("migrates a legacy-only secret while normalized values suppress fallback", async () => {
    const field: OrgCustomConnectorField = {
      key: "secret",
      label: "Secret",
      kind: "secret",
      required: true,
    };
    const legacyOnly = await createConnector({ fields: [field] });
    const duplicate = await createConnector({ fields: [field] });
    const invalidNormalized = await createConnector({ fields: [field] });
    const legacyOnlyEnvelope = storedSecretEnvelope("legacy-only");
    const normalizedEnvelope = storedSecretEnvelope("normalized-wins");
    const obsoleteFallbackEnvelope = storedSecretEnvelope("obsolete-fallback");
    const suppressedFallbackEnvelope = storedSecretEnvelope(
      "suppressed-fallback",
    );
    await addLegacySecret(legacyOnly, legacyOnlyEnvelope);
    await addValue(duplicate, {
      kind: "secret",
      key: "secret",
      encryptedValue: normalizedEnvelope,
    });
    await addLegacySecret(duplicate, obsoleteFallbackEnvelope);
    await addValue(invalidNormalized, {
      kind: "secret",
      key: "secret",
      encryptedValue: "",
    });
    await addLegacySecret(invalidNormalized, suppressedFallbackEnvelope);

    const report = await runBackfill({
      mode: "migrate",
      reportLabel: "fallback-precedence",
    });

    expect(report.counts).toMatchObject({
      inserted: 2,
      fallback_duplicate_different: 2,
      invalid_envelope: 1,
    });
    const targets = await db
      .select({
        connectorId: secrets.connectorId,
        encryptedValue: secrets.encryptedValue,
      })
      .from(secrets);
    expect(targets).toEqual(
      expect.arrayContaining([
        {
          connectorId: legacyOnly.connectionId,
          encryptedValue: legacyOnlyEnvelope,
        },
        {
          connectorId: duplicate.connectionId,
          encryptedValue: normalizedEnvelope,
        },
      ]),
    );
    expect(JSON.stringify(targets)).not.toContain(obsoleteFallbackEnvelope);
    expect(JSON.stringify(targets)).not.toContain(suppressedFallbackEnvelope);
  });

  it("classifies non-executable residue without changing OAuth tokens", async () => {
    const secretField: OrgCustomConnectorField = {
      key: "secret",
      label: "Secret",
      kind: "secret",
      required: true,
    };
    const parentless = await createConnector({
      fields: [secretField],
      createConnection: false,
    });
    await databaseClient`
      UPDATE org_custom_connectors
      SET fields = ${JSON.stringify([{ key: "invalid" }])}::jsonb
      WHERE id = ${parentless.definitionId}
    `;
    await addValue(parentless, {
      kind: "secret",
      key: "secret",
      encryptedValue: storedSecretEnvelope("parentless"),
    });

    const incompatible = await createConnector({
      fields: [secretField],
      connectionStorageVersion: 2,
    });
    await addValue(incompatible, {
      kind: "secret",
      key: "secret",
      encryptedValue: storedSecretEnvelope("incompatible"),
    });

    const removed = await createConnector({ fields: [] });
    await addValue(removed, {
      kind: "secret",
      key: "removed",
      encryptedValue: storedSecretEnvelope("removed"),
    });

    const wrongKind = await createConnector({
      fields: [
        {
          key: "same_key",
          label: "Same key",
          kind: "variable",
          required: false,
        },
      ],
    });
    await addValue(wrongKind, {
      kind: "secret",
      key: "same_key",
      encryptedValue: storedSecretEnvelope("wrong-kind"),
    });

    const invalidKind = await createConnector({ fields: [secretField] });
    await addValue(invalidKind, {
      kind: "unsupported",
      key: "secret",
      encryptedValue: storedSecretEnvelope("invalid-kind"),
    });

    const invalidDefinition = await createConnector({ fields: [secretField] });
    await databaseClient`
      UPDATE org_custom_connectors
      SET fields = ${JSON.stringify([{ key: "invalid" }])}::jsonb
      WHERE id = ${invalidDefinition.definitionId}
    `;
    await addValue(invalidDefinition, {
      kind: "secret",
      key: "secret",
      encryptedValue: storedSecretEnvelope("invalid-definition"),
    });

    const invalidEnvelope = await createConnector({ fields: [secretField] });
    await addValue(invalidEnvelope, {
      kind: "secret",
      key: "secret",
      encryptedValue: "not-a-stored-secret-envelope",
    });

    const oauth = await createConnector({
      fields: [
        {
          key: "tenant",
          label: "Tenant",
          kind: "variable",
          required: true,
        },
      ],
      authMode: "oauth",
    });
    await addValue(oauth, {
      kind: "variable",
      key: "tenant",
      encryptedValue: storedSecretEnvelope("oauth-tenant"),
    });
    await addLegacySecret(oauth, storedSecretEnvelope("obsolete-manual"));
    const oauthAccessToken = storedSecretEnvelope("current-oauth-token");
    await db.insert(secrets).values({
      connectorId: oauth.connectionId,
      orgId: oauth.orgId,
      userId: oauth.userId,
      name: "access_token",
      encryptedValue: oauthAccessToken,
      type: "connector",
    });

    const report = await runBackfill({
      mode: "migrate",
      reportLabel: "residue",
    });

    expect(report.counts).toMatchObject({
      missing_connection: 1,
      incompatible_connection: 1,
      removed_field: 1,
      wrong_kind: 1,
      invalid_kind: 1,
      invalid_definition: 1,
      invalid_envelope: 1,
      oauth_transition: 1,
      oauth_variable_unsupported: 1,
    });
    expect(report.blockingDifferences).toBe(2);
    expect(await db.select().from(variables)).toHaveLength(0);
    const sharedSecrets = await db.select().from(secrets);
    expect(sharedSecrets).toHaveLength(1);
    expect(sharedSecrets[0]).toMatchObject({
      connectorId: oauth.connectionId,
      name: "access_token",
      encryptedValue: oauthAccessToken,
    });
    expect(await db.select().from(orgCustomConnectorValues)).toHaveLength(8);
    expect(await db.select().from(orgCustomConnectorSecrets)).toHaveLength(1);
  });

  it("checkpoints KMS failure and resumes without certifying a partial scan", async () => {
    const fixture = await createConnector({
      fields: [
        {
          key: "api_key",
          label: "API key",
          kind: "secret",
          required: true,
        },
        {
          key: "region",
          label: "Region",
          kind: "variable",
          required: true,
        },
      ],
    });
    await addValue(fixture, {
      id: FIXED_FIRST_ID,
      kind: "secret",
      key: "api_key",
      encryptedValue: storedSecretEnvelope("secret-before-failure"),
    });
    await addValue(fixture, {
      id: FIXED_SECOND_ID,
      kind: "variable",
      key: "region",
      encryptedValue: storedSecretEnvelope("variable-after-failure"),
    });
    const failingKms = new FakeKmsClient();
    failingKms.fail = true;
    const failedReportPath = nextReportPath("kms-failure");

    await expect(
      runCustomCredentialBackfill({
        db,
        kms: failingKms,
        options: {
          mode: "migrate",
          batchSize: 1,
          reportPath: failedReportPath,
        },
      }),
    ).rejects.toThrow(
      "Custom credential backfill stopped (credential_decrypt_failed)",
    );
    expect(await db.select().from(secrets)).toHaveLength(1);
    expect(await db.select().from(variables)).toHaveLength(0);
    const failedReport = await readFile(failedReportPath, "utf8");
    expect(failedReport).toContain(
      `"resumeCursor": "values:${FIXED_FIRST_ID}"`,
    );
    expect(failedReport).toContain(
      '"failureCode": "credential_decrypt_failed"',
    );
    expect(failedReport).toContain('"stage": "decrypt_source"');
    expect(failedReport).toContain(`"sourceRowId": "${FIXED_SECOND_ID}"`);
    expect(failedReport).not.toContain("variable-after-failure");

    const resumed = await runBackfill({
      mode: "migrate",
      cursor: `values:${FIXED_FIRST_ID}`,
      reportLabel: "kms-resume",
    });
    expect(resumed).toMatchObject({
      complete: true,
      ready: false,
      startedFromBeginning: false,
    });
    expect(await db.select().from(variables)).toEqual([
      expect.objectContaining({
        name: "region",
        value: "variable-after-failure",
      }),
    ]);
  });

  it("rejects plaintext discovered before a concurrent source update", async () => {
    const fixture = await createConnector({
      fields: [
        {
          key: "region",
          label: "Region",
          kind: "variable",
          required: true,
        },
      ],
    });
    const firstEnvelope = storedSecretEnvelope("stale-value");
    const currentEnvelope = storedSecretEnvelope("current-value");
    const sourceId = await addValue(fixture, {
      kind: "variable",
      key: "region",
      encryptedValue: firstEnvelope,
    });
    const kms = new FakeKmsClient();
    kms.beforeFirstDecrypt = async () => {
      await db
        .update(orgCustomConnectorValues)
        .set({ encryptedValue: currentEnvelope, updatedAt: new Date() })
        .where(eq(orgCustomConnectorValues.id, sourceId));
      await db.insert(variables).values({
        connectorId: fixture.connectionId,
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: "region",
        value: "current-value",
        type: "connector",
      });
    };

    const report = await runBackfill({
      mode: "migrate",
      kms,
      reportLabel: "source-race",
    });

    expect(report.counts).toMatchObject({ source_changed: 1 });
    expect(report.blockingDifferences).toBe(1);
    expect(await db.select().from(variables)).toEqual([
      expect.objectContaining({ value: "current-value" }),
    ]);
  });

  it("rolls back a failed shared target write and emits only a stable failure code", async () => {
    const fixture = await createConnector({
      fields: [
        {
          key: "api_key",
          label: "API key",
          kind: "secret",
          required: true,
        },
      ],
    });
    const envelope = storedSecretEnvelope("database-failure-secret");
    const sourceId = await addValue(fixture, {
      kind: "secret",
      key: "api_key",
      encryptedValue: envelope,
    });
    await databaseClient.unsafe(`
      CREATE FUNCTION fail_credential_backfill_target() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced shared target failure';
      END
      $$;
      CREATE TRIGGER fail_credential_backfill_target
      BEFORE INSERT ON secrets
      FOR EACH ROW EXECUTE FUNCTION fail_credential_backfill_target()
    `);
    const reportPath = nextReportPath("database-failure");

    try {
      await expect(
        runCustomCredentialBackfill({
          db,
          kms: new FakeKmsClient(),
          options: {
            mode: "migrate",
            batchSize: 100,
            reportPath,
          },
        }),
      ).rejects.toThrow(
        "Custom credential backfill stopped (database_or_internal_failure)",
      );
    } finally {
      await databaseClient.unsafe(`
        DROP TRIGGER fail_credential_backfill_target ON secrets;
        DROP FUNCTION fail_credential_backfill_target()
      `);
    }

    expect(await db.select().from(secrets)).toHaveLength(0);
    expect(await db.select().from(orgCustomConnectorValues)).toHaveLength(1);
    const serializedReport = await readFile(reportPath, "utf8");
    expect(serializedReport).toContain(
      '"failureCode": "database_or_internal_failure"',
    );
    expect(serializedReport).toContain('"stage": "migrate_target"');
    expect(serializedReport).toContain(`"sourceRowId": "${sourceId}"`);
    expect(serializedReport).not.toContain(envelope);
    expect(serializedReport).not.toContain("database-failure-secret");
    expect(serializedReport).not.toContain("forced shared target failure");
  });

  it("bounds report details while retaining aggregate counts", async () => {
    const fixture = await createConnector({ fields: [] });
    const encryptedValue = storedSecretEnvelope("bounded-detail-value");
    await db.insert(orgCustomConnectorValues).values(
      Array.from({ length: 1_001 }, (_, index) => {
        return {
          connectorId: fixture.definitionId,
          orgId: fixture.orgId,
          userId: fixture.userId,
          kind: "secret",
          key: `removed_${index}`,
          encryptedValue,
        };
      }),
    );

    const report = await runBackfill({
      mode: "dry-run",
      batchSize: 1_000,
      reportLabel: "bounded-details",
    });

    expect(report.scannedRows).toBe(1_001);
    expect(report.counts).toMatchObject({ removed_field: 1_001 });
    expect(report.details).toHaveLength(1_000);
    expect(report.omittedDetails).toBe(1);
  });
});
