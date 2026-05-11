import { describe, expect, it } from "vitest";
import { zeroCustomConnectorSecretContract } from "@vm0/api-contracts/contracts/zero-custom-connectors";
import { server } from "../../../../mocks/server.ts";
import { createMockApi } from "../../../../mocks/msw-contract.ts";
import { testContext } from "../../../__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../../__tests__/page-helper.ts";
import { setCustomConnectorSecret$ } from "../custom-connectors.ts";

const context = testContext();
const mockApi = createMockApi(context);

describe("custom-connectors", () => {
  it("strips whitespace from custom connector credentials before upload", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });

    let submittedValue: string | null = null;

    server.use(
      mockApi(zeroCustomConnectorSecretContract.set, ({ body, respond }) => {
        submittedValue = body.value;
        return respond(204);
      }),
    );

    await context.store.set(
      setCustomConnectorSecret$,
      {
        id: "a1b2c3d4-e5f6-4890-abcd-ef1234567890",
        value: " custom\n credential ",
      },
      context.signal,
    );

    expect(submittedValue).toBe("customcredential");
  });
});
