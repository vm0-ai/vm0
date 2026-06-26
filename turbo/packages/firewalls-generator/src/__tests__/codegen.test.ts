import { describe, expect, it } from "vitest";

import { applyPermissionDescriptions } from "../codegen";
import type { PermissionGroup } from "../codegen";

describe("applyPermissionDescriptions", () => {
  it("attaches descriptions without changing permission order or rules", () => {
    const permissions: PermissionGroup[] = [
      {
        name: "tokens.read",
        rules: ["GET /tokens"],
      },
      {
        name: "tokens.update",
        rules: ["POST /tokens/{id}/regenerate"],
      },
    ];

    expect(
      applyPermissionDescriptions("Test API", permissions, {
        "tokens.read": "Read API tokens.",
        "tokens.update": "Regenerate API tokens.",
      }),
    ).toStrictEqual([
      {
        name: "tokens.read",
        description: "Read API tokens.",
        rules: ["GET /tokens"],
      },
      {
        name: "tokens.update",
        description: "Regenerate API tokens.",
        rules: ["POST /tokens/{id}/regenerate"],
      },
    ]);
    expect(permissions).toStrictEqual([
      {
        name: "tokens.read",
        rules: ["GET /tokens"],
      },
      {
        name: "tokens.update",
        rules: ["POST /tokens/{id}/regenerate"],
      },
    ]);
  });

  it("fails when a rule-bearing permission has no description", () => {
    expect(() => {
      applyPermissionDescriptions(
        "Test API",
        [
          {
            name: "tokens.read",
            rules: ["GET /tokens"],
          },
          {
            name: "tokens.update",
            rules: ["POST /tokens/{id}/regenerate"],
          },
        ],
        {
          "tokens.read": "Read API tokens.",
        },
      );
    }).toThrowErrorMatchingInlineSnapshot(`
      [Error: Test API permissions missing descriptions:
      tokens.update]
    `);
  });

  it("treats blank descriptions as missing", () => {
    expect(() => {
      applyPermissionDescriptions(
        "Test API",
        [
          {
            name: "tokens.read",
            rules: ["GET /tokens"],
          },
        ],
        {
          "tokens.read": " ",
        },
      );
    }).toThrowErrorMatchingInlineSnapshot(`
      [Error: Test API permissions missing descriptions:
      tokens.read]
    `);
  });

  it("fails when the description map has stale permission names", () => {
    expect(() => {
      applyPermissionDescriptions(
        "Test API",
        [
          {
            name: "tokens.read",
            rules: ["GET /tokens"],
          },
        ],
        {
          "tokens.read": "Read API tokens.",
          "tokens.update": "Regenerate API tokens.",
        },
      );
    }).toThrowErrorMatchingInlineSnapshot(`
      [Error: Test API permission descriptions reference unknown permissions:
      tokens.update]
    `);
  });

  it("does not require descriptions for permissions without rules", () => {
    expect(
      applyPermissionDescriptions(
        "Test API",
        [
          {
            name: "tokens.read",
            rules: [],
          },
        ],
        {},
      ),
    ).toStrictEqual([
      {
        name: "tokens.read",
        rules: [],
      },
    ]);
  });
});
