import { describe, expect, it } from "vitest";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";

import { accept } from "../../../lib/accept.ts";
import { zeroClient$ } from "../../../signals/api-client.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

describe("api agents mock handlers", () => {
  it("preserves existing user connectors when adding another connector", async () => {
    const agentId = "c0000000-0000-4000-a000-000000000001";
    const client = context.store.get(zeroClient$)(zeroUserConnectorsContract);

    await accept(
      client.update({
        params: { id: agentId },
        body: { enabledTypes: ["github"], operation: "add" },
      }),
      [200],
    );

    const updated = await accept(
      client.update({
        params: { id: agentId },
        body: { enabledTypes: ["slack"], operation: "add" },
      }),
      [200],
    );
    expect(new Set(updated.body.enabledTypes)).toStrictEqual(
      new Set(["github", "slack"]),
    );

    const readBack = await accept(
      client.get({ params: { id: agentId } }),
      [200],
    );
    expect(new Set(readBack.body.enabledTypes)).toStrictEqual(
      new Set(["github", "slack"]),
    );
  });
});
