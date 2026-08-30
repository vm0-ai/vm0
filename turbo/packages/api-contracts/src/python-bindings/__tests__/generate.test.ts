import {
  BUILTIN_FIREWALL_CATALOG_CACHE_SCHEMA_VERSION,
  BUILTIN_FIREWALL_CATALOG_MAX_BYTES,
} from "../../contracts/runners";
import { renderBuiltinFirewallCacheContract } from "../generate";

describe("Python builtin firewall cache binding", () => {
  it("renders the canonical cache format constants deterministically", () => {
    expect(BUILTIN_FIREWALL_CATALOG_CACHE_SCHEMA_VERSION).toBe(1);
    expect(BUILTIN_FIREWALL_CATALOG_MAX_BYTES).toBe(16 * 1024 * 1024);

    const firstRender = renderBuiltinFirewallCacheContract();
    const secondRender = renderBuiltinFirewallCacheContract();

    expect(secondRender).toBe(firstRender);
    expect(firstRender).toContain(
      "BUILTIN_FIREWALL_CATALOG_CACHE_SCHEMA_VERSION: Final[int] = 1",
    );
    expect(firstRender).toContain(
      "BUILTIN_FIREWALL_CATALOG_MAX_BYTES: Final[int] = 16_777_216",
    );
  });
});
