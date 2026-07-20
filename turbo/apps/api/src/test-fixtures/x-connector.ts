/**
 * In-process fixture for connected X connector state.
 *
 * Connector OAuth completion depends on a real provider callback and cannot be
 * constructed through a product route in focused route tests. This fixture only
 * seeds the connector row and stored access token needed to exercise routes
 * that consume an already-connected X account.
 */
import { createStore } from "ccstate";
import { CONNECTOR_TYPES } from "@vm0/connectors/connectors";
import { connectors } from "@vm0/db/schema/connector";
import { secrets } from "@vm0/db/schema/secret";

import { now } from "../lib/time";
import { writeDb$ } from "../signals/external/db";
import { encryptStoredSecretValue } from "../signals/services/crypto.utils";

export async function seedConnectedXConnector(values: {
  readonly accessToken: string;
  readonly orgId: string;
  readonly userId: string;
}): Promise<void> {
  const db = createStore().set(writeDb$);
  const [connector] = await db
    .insert(connectors)
    .values({
      type: "x",
      authMethod: "oauth",
      storageVersion: CONNECTOR_TYPES.x.authMethods.oauth.storage.version,
      orgId: values.orgId,
      userId: values.userId,
      externalId: "x-user-id",
      externalUsername: "zero_user",
      oauthScopes: JSON.stringify(["tweet.write", "media.write"]),
      tokenExpiresAt: new Date(now() + 60 * 60 * 1000),
    })
    .returning({ id: connectors.id });
  if (!connector) {
    throw new Error("Failed to seed X connector");
  }
  await db.insert(secrets).values({
    connectorId: connector.id,
    orgId: values.orgId,
    userId: values.userId,
    name: "X_ACCESS_TOKEN",
    type: "connector",
    encryptedValue: await encryptStoredSecretValue(values.accessToken),
  });
}
