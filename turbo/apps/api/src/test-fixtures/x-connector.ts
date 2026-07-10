/**
 * In-process fixture for connected X connector state.
 *
 * Connector OAuth completion depends on a real provider callback and cannot be
 * constructed through a product route in focused route tests. This fixture only
 * seeds the connector row and stored access token needed to exercise routes
 * that consume an already-connected X account.
 */
import { createStore } from "ccstate";
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
  await db.insert(connectors).values({
    type: "x",
    authMethod: "oauth",
    orgId: values.orgId,
    userId: values.userId,
    externalId: "x-user-id",
    externalUsername: "zero_user",
    oauthScopes: JSON.stringify(["tweet.write", "media.write"]),
    tokenExpiresAt: new Date(now() + 60 * 60 * 1000),
  });
  await db.insert(secrets).values({
    orgId: values.orgId,
    userId: values.userId,
    name: "X_ACCESS_TOKEN",
    type: "connector",
    encryptedValue: await encryptStoredSecretValue(values.accessToken),
  });
}
