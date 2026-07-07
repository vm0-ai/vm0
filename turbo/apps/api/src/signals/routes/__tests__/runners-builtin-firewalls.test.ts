import {
  runnersBuiltinFirewallsResolveContract,
  type RunnerBuiltinFirewallsResolveResponse,
} from "@vm0/api-contracts/contracts/runners";
import {
  RUNNER_RUNTIME_FIREWALL_CATALOG_DIGEST,
  RUNNER_RUNTIME_FIREWALL_NAMES,
  RUNNER_RUNTIME_FIREWALL_CATALOG_VERSION,
} from "@vm0/connectors/firewall-metadata/runner-runtime";
import { describe, expect, it } from "vitest";

import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { accept, testContext } from "../../../__tests__/test-context";
import { runnersRoutes } from "../runners";

const context = testContext();
const OFFICIAL_RUNNER_AUTHORIZATION =
  "Bearer vm0_official_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const OPENAI_API_KEY_AUTH_HEADER = [
  "Bearer $",
  "{{ secrets.OPENAI_API_KEY }}",
].join("");

function client() {
  return setupAppWithRoutes({ context, routes: runnersRoutes })(
    runnersBuiltinFirewallsResolveContract,
  );
}

describe("runner builtin firewall resolver", () => {
  it("requires runner authentication", async () => {
    const response = await accept(
      client().resolve({
        headers: {},
        body: { names: ["github"] },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects unknown builtin firewall names", async () => {
    const response = await accept(
      client().resolve({
        headers: { authorization: OFFICIAL_RUNNER_AUTHORIZATION },
        body: { names: ["github", "not-a-builtin-firewall"] },
      }),
      [400],
    );

    expect(response.body.error.message).toBe(
      "Unknown builtin firewall: not-a-builtin-firewall",
    );
  });

  it("resolves connector and model-provider builtin firewalls", async () => {
    const response = await accept(
      client().resolve({
        headers: { authorization: OFFICIAL_RUNNER_AUTHORIZATION },
        body: {
          names: ["github", "github", "model-provider:openai-api-key"],
        },
      }),
      [200],
    );
    const body: RunnerBuiltinFirewallsResolveResponse = response.body;

    expect(body.catalogDigest).toBe(RUNNER_RUNTIME_FIREWALL_CATALOG_DIGEST);
    expect(body.catalogVersion).toBe(RUNNER_RUNTIME_FIREWALL_CATALOG_VERSION);
    expect(Object.keys(body.firewalls).sort()).toStrictEqual([
      "github",
      "model-provider:openai-api-key",
    ]);
    expect(body.firewalls.github?.name).toBe("github");
    expect(
      body.firewalls["model-provider:openai-api-key"]?.apis[0],
    ).toStrictEqual({
      base: "https://api.openai.com/v1/responses",
      auth: {
        headers: {
          Authorization: OPENAI_API_KEY_AUTH_HEADER,
        },
      },
      permissions: [],
    });
  });

  it("resolves the full generated builtin firewall catalog when names are omitted", async () => {
    const response = await accept(
      client().resolve({
        headers: { authorization: OFFICIAL_RUNNER_AUTHORIZATION },
        body: {},
      }),
      [200],
    );
    const body: RunnerBuiltinFirewallsResolveResponse = response.body;

    expect(body.catalogDigest).toBe(RUNNER_RUNTIME_FIREWALL_CATALOG_DIGEST);
    expect(body.catalogVersion).toBe(RUNNER_RUNTIME_FIREWALL_CATALOG_VERSION);
    expect(Object.keys(body.firewalls).sort()).toStrictEqual([
      ...RUNNER_RUNTIME_FIREWALL_NAMES,
    ]);
    expect(body.firewalls.github?.name).toBe("github");
    expect(
      body.firewalls["model-provider:openai-api-key"]?.apis[0],
    ).toStrictEqual({
      base: "https://api.openai.com/v1/responses",
      auth: {
        headers: {
          Authorization: OPENAI_API_KEY_AUTH_HEADER,
        },
      },
      permissions: [],
    });
  });
});
