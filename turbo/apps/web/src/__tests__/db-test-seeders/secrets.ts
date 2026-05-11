import { initServices } from "../../lib/init-services";
import type { SecretType } from "@vm0/api-contracts/contracts/secrets";
import { secrets } from "@vm0/db/schema/secret";
import { variables } from "@vm0/db/schema/variable";
import { ORG_SENTINEL_USER_ID } from "../../lib/zero/org/org-sentinel";
import { encryptSecretValue } from "../../lib/shared/crypto/secrets-encryption";

// ============================================================================
// Org Sentinel Secret/Variable Seeders
// ============================================================================

/**
 * Insert an org-level sentinel secret directly in the database.
 *
 * @why-db-direct The secrets API creates user-scoped secrets, not org-sentinel
 * records. Org-sentinel secrets use a special userId (ORG_SENTINEL_USER_ID)
 * that cannot be set through the API.
 */
export async function insertTestOrgSentinelSecret(params: {
  orgId: string;
  name: string;
}): Promise<void> {
  initServices();
  const { SECRETS_ENCRYPTION_KEY } = globalThis.services.env;
  const encrypted = encryptSecretValue(
    "sentinel-test-value",
    SECRETS_ENCRYPTION_KEY,
  );
  await globalThis.services.db.insert(secrets).values({
    name: params.name,
    encryptedValue: encrypted,
    type: "user",
    userId: ORG_SENTINEL_USER_ID,
    orgId: params.orgId,
  });
}

/**
 * Insert an org-sentinel model-provider secret directly in the database.
 *
 * Used by tests that exercise multi-auth model-provider resolution: the
 * resolver reads secrets of type "model-provider" via `getSecretValues`,
 * and seeding them through the user-secret API would store them under the
 * wrong type (`user`) and userId (real user, not ORG_SENTINEL_USER_ID).
 *
 * @why-db-direct Org-sentinel + type="model-provider" is not reachable
 * via the public secrets API.
 */
export async function insertTestOrgModelProviderSecret(params: {
  orgId: string;
  name: string;
  value: string;
}): Promise<void> {
  initServices();
  const { SECRETS_ENCRYPTION_KEY } = globalThis.services.env;
  const encrypted = encryptSecretValue(params.value, SECRETS_ENCRYPTION_KEY);
  await globalThis.services.db.insert(secrets).values({
    name: params.name,
    encryptedValue: encrypted,
    type: "model-provider",
    userId: ORG_SENTINEL_USER_ID,
    orgId: params.orgId,
    description: "test seed",
  });
}

/**
 * Insert a user-level (personal) model-provider secret directly in the
 * database. Resolver tests use this to verify that `secretUserId` is
 * derived from the resolved row's owner — they assert the resolved secret
 * value matches the personal row's stored value rather than the org's
 * (Epic #11868 — personal model providers).
 *
 * @why-db-direct Personal-tier secrets are upsert-routed through the API
 * which couples them to a model provider's lifecycle; tests need an
 * id-scoped writer to set up scenarios where personal and org secrets
 * have distinct values for the same name.
 */
export async function insertTestUserModelProviderSecret(params: {
  orgId: string;
  userId: string;
  name: string;
  value: string;
}): Promise<void> {
  initServices();
  const { SECRETS_ENCRYPTION_KEY } = globalThis.services.env;
  const encrypted = encryptSecretValue(params.value, SECRETS_ENCRYPTION_KEY);
  await globalThis.services.db.insert(secrets).values({
    name: params.name,
    encryptedValue: encrypted,
    type: "model-provider",
    userId: params.userId,
    orgId: params.orgId,
    description: "test seed",
  });
}

/**
 * Insert a user-level secret directly in the database.
 *
 * @why-db-direct Route isolation tests need rows owned by another user, another
 * org, or a non-user secret type. The public secrets API always writes the
 * authenticated user's active-org secret with type="user".
 */
export async function insertTestUserSecret(params: {
  orgId: string;
  userId: string;
  name: string;
  value?: string;
  type?: SecretType;
}): Promise<void> {
  initServices();
  const { SECRETS_ENCRYPTION_KEY } = globalThis.services.env;
  const encrypted = encryptSecretValue(
    params.value ?? "test-secret-value",
    SECRETS_ENCRYPTION_KEY,
  );
  await globalThis.services.db.insert(secrets).values({
    name: params.name,
    encryptedValue: encrypted,
    type: params.type ?? "user",
    userId: params.userId,
    orgId: params.orgId,
    description: "test seed",
  });
}

/**
 * Insert an org-level sentinel variable directly in the database.
 *
 * @why-db-direct The variables API creates user-scoped variables, not
 * org-sentinel records. Org-sentinel variables use a special userId
 * (ORG_SENTINEL_USER_ID) that cannot be set through the API.
 */
export async function insertTestOrgSentinelVariable(params: {
  orgId: string;
  name: string;
}): Promise<void> {
  initServices();
  await globalThis.services.db.insert(variables).values({
    name: params.name,
    value: "sentinel-test-value",
    userId: ORG_SENTINEL_USER_ID,
    orgId: params.orgId,
  });
}

/**
 * Insert a user-level variable directly in the database.
 *
 * @why-db-direct Route isolation tests need rows owned by another user or org.
 * The public variables API always writes the authenticated user's active-org
 * variable.
 */
export async function insertTestUserVariable(params: {
  orgId: string;
  userId: string;
  name: string;
  value?: string;
}): Promise<void> {
  initServices();
  await globalThis.services.db.insert(variables).values({
    name: params.name,
    value: params.value ?? "test-variable-value",
    userId: params.userId,
    orgId: params.orgId,
    description: "test seed",
  });
}
