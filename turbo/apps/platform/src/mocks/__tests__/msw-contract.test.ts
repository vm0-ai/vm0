import { describe, it, expect } from "vitest";
import {
  zeroConnectorsByTypeContract,
  zeroConnectorsMainContract,
  zeroFeatureSwitchesContract,
  zeroIntegrationsSlackContract,
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

  it("parses JSON request bodies for mutation routes", async () => {
    let received: unknown = null;
    server.use(
      mockApi(zeroFeatureSwitchesContract.update, ({ body, respond }) => {
        received = body;
        return respond(200, { switches: body.switches });
      }),
    );

    const response = await fetch("/api/zero/feature-switches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ switches: { newNav: true, darkMode: false } }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      switches: { newNav: true, darkMode: false },
    });
    expect(received).toStrictEqual({
      switches: { newNav: true, darkMode: false },
    });
  });

  it("exposes typed query params to the handler", async () => {
    let seenAction: string | undefined;
    server.use(
      mockApi(zeroIntegrationsSlackContract.disconnect, ({ query, respond }) => {
        seenAction = query.action;
        return respond(200, { ok: true });
      }),
    );

    const response = await fetch(
      "/api/zero/integrations/slack?action=uninstall",
      { method: "DELETE" },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ ok: true });
    expect(seenAction).toBe("uninstall");
  });

  it("tolerates empty request bodies on mutation routes", async () => {
    let received: unknown = "sentinel";
    server.use(
      mockApi(zeroIntegrationsSlackContract.disconnect, ({ body, respond }) => {
        received = body;
        return respond(200, { ok: true });
      }),
    );

    const response = await fetch("/api/zero/integrations/slack", {
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    expect(received).toBeUndefined();
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

  it("enforces request body + query shape at compile time", () => {
    mockApi(zeroFeatureSwitchesContract.update, ({ body, respond }) => {
      // body.switches is typed; reading an unrelated field should fail.
      // @ts-expect-error — `somethingElse` is not part of the request body schema
      void body.somethingElse;
      return respond(200, { switches: body.switches });
    });

    mockApi(zeroIntegrationsSlackContract.disconnect, ({ query, respond }) => {
      // @ts-expect-error — `unknownParam` is not declared in the query schema
      void query.unknownParam;
      return respond(200, { ok: true });
    });
  });
});
