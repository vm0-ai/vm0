import { describe, expect, it } from "vitest";

import {
  buildBuiltinFirewallCatalog,
  renderPythonBuiltinFirewallCatalog,
} from "../builtin-firewall-catalog";

describe("builtin firewall catalog", () => {
  it("includes connector and model-provider firewalls", () => {
    const catalog = buildBuiltinFirewallCatalog();

    expect(catalog.firewalls.github?.apis[0]?.base).toBe(
      "https://api.github.com",
    );
    expect(
      catalog.firewalls["model-provider:openai-api-key"]?.apis[0]?.base,
    ).toBe("https://api.openai.com/v1/responses");
  });

  it("preserves connector auth templates", () => {
    const catalog = buildBuiltinFirewallCatalog();

    expect(catalog.firewalls.cloudflare?.apis[0]?.auth.headers).toStrictEqual({
      Authorization: "Bearer ${{ secrets.CLOUDFLARE_TOKEN }}",
    });
    expect(catalog.firewalls.slock?.apis[0]?.auth.headers).toStrictEqual({
      Authorization: "Bearer ${{ secrets.SLOCK_TOKEN }}",
      "X-Server-Id": "${{ secrets.SLOCK_SERVER_ID }}",
    });
    expect(catalog.firewalls.serpapi?.apis[0]?.auth.query).toStrictEqual({
      api_key: "${{ secrets.SERPAPI_TOKEN }}",
    });
    expect(catalog.firewalls.aws?.apis[0]?.auth.awsSigv4).toStrictEqual({
      accessKeyId: "${{ secrets.AWS_ACCESS_KEY_ID }}",
      secretAccessKey: "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
      sessionToken: "${{ secrets.AWS_SESSION_TOKEN }}",
    });
  });

  it("renders deterministic multiline Python JSON", () => {
    const firstRender = renderPythonBuiltinFirewallCatalog();
    const secondRender = renderPythonBuiltinFirewallCatalog();

    expect(secondRender).toBe(firstRender);
    expect(firstRender).toContain("BUILTIN_FIREWALLS = json.loads(");
    expect(firstRender).toContain('"github": {');
    expect(firstRender).not.toContain('json.loads("{\\n');
  });
});
