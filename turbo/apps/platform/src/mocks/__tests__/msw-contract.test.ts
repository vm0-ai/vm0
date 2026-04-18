import { describe, it, expect, expectTypeOf } from "vitest";
import type { ServerInferResponseBody } from "@ts-rest/core";
import {
  logsListContract,
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
      mockApi(
        zeroIntegrationsSlackContract.disconnect,
        ({ query, respond }) => {
          seenAction = query.action;
          return respond(200, { ok: true });
        },
      ),
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
    // 200 body must be the full connector list shape — wrongField is not in it
    expectTypeOf<{ wrongField: string }>().not.toExtend<
      ServerInferResponseBody<(typeof zeroConnectorsMainContract)["list"], 200>
    >();

    // 204 in this contract is declared as noBody
    expectTypeOf<
      ServerInferResponseBody<
        (typeof zeroConnectorsByTypeContract)["delete"],
        204
      >
    >().toEqualTypeOf<undefined>();

    // 500 is not declared on this contract
    expectTypeOf<500>().not.toExtend<
      keyof (typeof zeroConnectorsByTypeContract)["delete"]["responses"] &
        number
    >();
  });

  it("applies Zod coercion and defaults to query params", async () => {
    let seenLimit: number | undefined;
    server.use(
      mockApi(logsListContract.list, ({ query, respond }) => {
        seenLimit = query.limit;
        return respond(200, {
          data: [],
          pagination: { hasMore: false, nextCursor: null, totalPages: 1 },
          filters: { statuses: [], sources: [], agents: [] },
        });
      }),
    );

    // No `limit` param — contract declares default(20), mockApi must apply it
    await fetch("/api/zero/logs");
    expect(seenLimit).toBe(20);

    // String "5" must be coerced to number 5
    await fetch("/api/zero/logs?limit=5");
    expect(seenLimit).toBe(5);
  });

  it("enforces request body + query shape at compile time", () => {
    mockApi(zeroFeatureSwitchesContract.update, ({ body, respond }) => {
      // body.switches is typed; somethingElse must not be present
      expectTypeOf(body).not.toExtend<{ somethingElse: unknown }>();
      return respond(200, { switches: body.switches });
    });

    mockApi(zeroIntegrationsSlackContract.disconnect, ({ query, respond }) => {
      // unknownParam must not be present in the typed query
      expectTypeOf(query).not.toExtend<{ unknownParam: unknown }>();
      return respond(200, { ok: true });
    });
  });
});
