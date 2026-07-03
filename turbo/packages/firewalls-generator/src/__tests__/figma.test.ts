import { describe, expect, it } from "vitest";

import { pickPrimaryFigmaScope } from "../figma";

describe("pickPrimaryFigmaScope", () => {
  it("uses granular scopes over deprecated files:read", () => {
    expect(
      pickPrimaryFigmaScope(
        ["file_content:read", "files:read"],
        "GET /v1/files/{file_key}",
      ),
    ).toBe("file_content:read");

    expect(
      pickPrimaryFigmaScope(
        ["webhooks:read", "files:read"],
        "GET /v2/webhooks/{webhook_id}",
      ),
    ).toBe("webhooks:read");
  });

  it("keeps a single official scope as the owner", () => {
    expect(
      pickPrimaryFigmaScope(
        ["library_analytics:read"],
        "GET /v1/analytics/libraries/{file_key}/component/actions",
      ),
    ).toBe("library_analytics:read");
  });

  it("throws when same-priority scopes need an explicit owner", () => {
    expect(() => {
      pickPrimaryFigmaScope(
        ["file_content:read", "file_metadata:read"],
        "GET /v1/files/{file_key}",
      );
    }).toThrow("Ambiguous Figma scope owner");
  });
});
