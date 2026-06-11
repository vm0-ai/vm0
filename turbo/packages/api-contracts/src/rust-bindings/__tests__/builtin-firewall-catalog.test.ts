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
    expect(catalog.connectorCount).toBeGreaterThan(0);
    expect(catalog.modelProviderCount).toBeGreaterThan(0);
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
