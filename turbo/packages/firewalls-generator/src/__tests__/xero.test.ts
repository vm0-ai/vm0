import { describe, expect, it } from "vitest";

import { pickPrimaryXeroScope } from "../xero";

describe("pickPrimaryXeroScope", () => {
  it("uses read scopes as owners for read endpoints", () => {
    expect(
      pickPrimaryXeroScope(
        ["accounting.settings", "accounting.settings.read"],
        "GET /Accounts",
      ),
    ).toBe("accounting.settings.read");
  });

  it("uses non-read scopes as owners for mutating endpoints", () => {
    expect(
      pickPrimaryXeroScope(
        ["accounting.settings", "accounting.settings.read"],
        "PUT /Accounts",
      ),
    ).toBe("accounting.settings");
  });

  it("uses the most granular read scope when official scopes overlap", () => {
    expect(
      pickPrimaryXeroScope(
        ["accounting.reports.read", "accounting.reports.tenninetynine.read"],
        "GET /Reports/TenNinetyNine",
      ),
    ).toBe("accounting.reports.tenninetynine.read");
  });

  it("uses granular non-read scopes over legacy broad scopes", () => {
    expect(
      pickPrimaryXeroScope(
        ["accounting.transactions", "accounting.invoices"],
        "POST /Invoices",
      ),
    ).toBe("accounting.invoices");
  });

  it("throws when same-priority scopes need an explicit owner", () => {
    expect(() => {
      pickPrimaryXeroScope(
        ["accounting.invoices", "accounting.payments"],
        "POST /Payments",
      );
    }).toThrow("Ambiguous Xero scope owner");
  });
});
