import { describe, expect, it } from "vitest";

import { findFirewallRuleOverlap } from "./firewall-rule-overlap-helper";

describe("firewall rule overlap", () => {
  it("reports exact route overlaps", () => {
    expect(
      findFirewallRuleOverlap("GET /v4/items/{id}", "GET /v4/items/{id}"),
    ).toStrictEqual({
      leftRule: "GET /v4/items/{id}",
      rightRule: "GET /v4/items/{id}",
      method: "GET",
      path: "/v4/items/x",
    });
  });

  it("uses the concrete method when ANY overlaps a fixed method", () => {
    expect(
      findFirewallRuleOverlap(
        "ANY /v4/pages/assets/{rest*}",
        "POST /v4/pages/assets/upload",
      ),
    ).toMatchObject({
      method: "POST",
      path: "/v4/pages/assets/upload",
    });
  });

  it("matches parameterized routes against literal routes", () => {
    expect(
      findFirewallRuleOverlap(
        "POST /v4/accounts/{account_id}/workers/assets/{action}",
        "POST /v4/accounts/{account_id}/workers/assets/upload",
      ),
    ).toMatchObject({
      method: "POST",
      path: "/v4/accounts/x/workers/assets/upload",
    });
  });

  it("matches mixed segment parameters", () => {
    expect(
      findFirewallRuleOverlap("GET /files/file-{id}", "GET /files/{slug}"),
    ).toMatchObject({
      method: "GET",
      path: "/files/file-x",
    });
  });

  it("rejects incompatible mixed segment prefixes", () => {
    expect(
      findFirewallRuleOverlap("GET /files/file-{id}", "GET /files/user-{id}"),
    ).toBeNull();
  });

  it("allows star greedy segments to overlap an empty tail", () => {
    expect(findFirewallRuleOverlap("GET /v4/{rest*}", "GET /v4")).toMatchObject(
      {
        method: "GET",
        path: "/v4",
      },
    );
  });

  it("does not allow plus greedy segments to overlap an empty tail", () => {
    expect(findFirewallRuleOverlap("GET /v4/{rest+}", "GET /v4")).toBeNull();
  });

  it("allows plus greedy segments to overlap a non-empty tail", () => {
    expect(
      findFirewallRuleOverlap("GET /v4/{rest+}", "GET /v4/pages"),
    ).toMatchObject({
      method: "GET",
      path: "/v4/pages",
    });
  });

  it("does not overlap different fixed methods", () => {
    expect(
      findFirewallRuleOverlap("GET /v4/items", "POST /v4/items"),
    ).toBeNull();
  });

  it("does not overlap routes with different fixed tail segments", () => {
    expect(
      findFirewallRuleOverlap(
        "POST /v4/accounts/{account_id}/workers/dispatch/namespaces/{dispatch_namespace}/scripts/{script_name}/assets-upload-session",
        "POST /v4/accounts/{account_id}/workers/assets/upload",
      ),
    ).toBeNull();
  });

  it("rejects malformed rules through the shared firewall grammar", () => {
    expect(() => {
      findFirewallRuleOverlap("GET /v4/{id}/{id}", "GET /v4/items/1");
    }).toThrow('duplicate parameter name "{id}"');
  });
});
