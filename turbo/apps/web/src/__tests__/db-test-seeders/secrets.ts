import { initServices } from "../../lib/init-services";
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
