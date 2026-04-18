import { describe, it, expect } from "vitest";
import {
  zeroConnectorsByTypeContract,
  zeroConnectorsMainContract,
} from "@vm0/core";
import { mockApi } from "../msw-contract.ts";
import { server } from "../server.ts";

describe("mockApi contract helper", () => {
  it("registers a handler at the contract's path + method and returns the typed body", async () => {
    server.use(
      mockApi(zeroConnectorsMainContract.list, ({ respond }) => {
        return respond(200, {
          connectors: [],
          configuredTypes: [],
          connectorProvidedSecretNames: [],
        });
      }),
    );

    const response = await fetch("/api/zero/connectors");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      connectors: [],
      configuredTypes: [],
      connectorProvidedSecretNames: [],
    });
  });

  it("substitutes path params and supports no-body responses", async () => {
    server.use(
      mockApi(zeroConnectorsByTypeContract.delete, ({ params, respond }) => {
        if (params.type === "notion") {
          return respond(204);
        }
        return respond(404, {
          error: { message: "Connector not found", code: "NOT_FOUND" },
        });
      }),
    );

    const ok = await fetch("/api/zero/connectors/notion", { method: "DELETE" });
    expect(ok.status).toBe(204);

    const missing = await fetch("/api/zero/connectors/slack", {
      method: "DELETE",
    });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toStrictEqual({
      error: { message: "Connector not found", code: "NOT_FOUND" },
    });
  });

  it("enforces response body shape at compile time", () => {
    mockApi(zeroConnectorsMainContract.list, ({ respond }) => {
      // @ts-expect-error — `wrongField` is not part of the 200 response schema
      return respond(200, { wrongField: "bad" });
    });

    mockApi(zeroConnectorsByTypeContract.delete, ({ respond }) => {
      // @ts-expect-error — 204 in this contract is declared as noBody
      return respond(204, { anything: "forbidden" });
    });

    mockApi(zeroConnectorsByTypeContract.delete, ({ respond }) => {
      // @ts-expect-error — 500 is not declared on this contract
      return respond(500, { error: { message: "x", code: "x" } });
    });
  });
});
