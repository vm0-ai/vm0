import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { secrets } from "@vm0/db/schema/secret";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { writeDb$ } from "../../external/db";
import {
  zeroConnectorList,
  zeroConnectorSearch,
} from "../zero-connector-data.service";

const store = createStore();
const writeDb = store.set(writeDb$);

describe("zeroConnectorList", () => {
  it("assigns fixed sentinel timestamps to derived api-token connectors", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;

    // Seed OPENAI_TOKEN so openai is derived as a connected api-token connector
    await writeDb.insert(secrets).values({
      orgId,
      userId,
      name: "OPENAI_TOKEN",
      encryptedValue: "encrypted_openai_token",
      type: "user",
    });

    const list = await store.get(zeroConnectorList({ orgId, userId }));
    const openai = list.connectors.find((c) => {
      return c.type === "openai";
    });

    expect(openai).toBeDefined();
    if (openai) {
      expect(openai.createdAt).toBe("1970-01-01T00:00:00.000Z");
      expect(openai.updatedAt).toBe("1970-01-01T00:00:00.000Z");
    }
  });
});

describe("zeroConnectorSearch", () => {
  it("hides strict feature-flagged api-token connectors when the flag is disabled", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;

    const connectors = await store.get(
      zeroConnectorSearch({ orgId, userId, keyword: undefined }),
    );

    expect(
      connectors.some((connector) => {
        return connector.id === "zapier";
      }),
    ).toBeFalsy();
  });

  it("shows strict feature-flagged api-token connectors when an override enables the flag", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;

    await writeDb.insert(userFeatureSwitches).values({
      orgId,
      userId,
      switches: { [FeatureSwitchKey.ZapierConnector]: true },
    });

    const connectors = await store.get(
      zeroConnectorSearch({ orgId, userId, keyword: "zapier" }),
    );

    const zapier = connectors.find((connector) => {
      return connector.id === "zapier";
    });
    expect(zapier?.authMethods).toStrictEqual(["api-token"]);
  });
});
