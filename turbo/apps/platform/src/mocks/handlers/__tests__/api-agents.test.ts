import { describe, expect, it } from "vitest";
import { userConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";

import { setupBootstrap } from "../../../__tests__/page-helper.ts";
import { accept } from "../../../lib/accept.ts";
import { apiClient$ } from "../../../signals/api-client.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const agentId = "c0000000-0000-4000-a000-000000000001";

async function userConnectorsClient() {
  await setupBootstrap({ context, path: "/error" });
  return context.store.get(apiClient$)(userConnectorsContract);
}

describe("api agents mock handlers", () => {
  it("preserves existing user connectors when adding another connector", async () => {
    const client = await userConnectorsClient();

    const initial = await accept(
      client.get({ params: { id: agentId } }),
      [200],
    );
    expect(initial.body.enabledConnectorSlugs).toStrictEqual([]);

    await accept(
      client.update({
        params: { id: agentId },
        body: { enabledConnectorSlugs: ["github"], operation: "add" },
      }),
      [200],
    );

    const updated = await accept(
      client.update({
        params: { id: agentId },
        body: { enabledConnectorSlugs: ["slack"], operation: "add" },
      }),
      [200],
    );
    expect(new Set(updated.body.enabledConnectorSlugs)).toStrictEqual(
      new Set(["github", "slack"]),
    );

    const readBack = await accept(
      client.get({ params: { id: agentId } }),
      [200],
    );
    expect(new Set(readBack.body.enabledConnectorSlugs)).toStrictEqual(
      new Set(["github", "slack"]),
    );
  });

  it("starts each test with isolated user connector state", async () => {
    const client = await userConnectorsClient();

    const initial = await accept(
      client.get({ params: { id: agentId } }),
      [200],
    );
    expect(initial.body.enabledConnectorSlugs).toStrictEqual([]);

    const updated = await accept(
      client.update({
        params: { id: agentId },
        body: { enabledConnectorSlugs: ["notion"], operation: "add" },
      }),
      [200],
    );
    expect(updated.body.enabledConnectorSlugs).toStrictEqual(["notion"]);
  });
});
