import { describe, expect, it } from "vitest";
import {
  hasTokenInputValue,
  sanitizeTokenInput,
  sanitizeTokenInputRecord,
} from "../token-input.ts";

describe("token-input", () => {
  it("removes spaces and newlines from token strings", () => {
    expect(sanitizeTokenInput(" sk-ant\n token\tvalue ")).toBe(
      "sk-anttokenvalue",
    );
    expect(hasTokenInputValue(" \n ")).toBeFalsy();
  });

  it("can preserve JSON credential whitespace while trimming the wrapper", () => {
    const result = sanitizeTokenInputRecord(
      {
        CODEX_AUTH_JSON: '  { "tokens": { "access": "abc" } }\n',
        CHATGPT_ACCESS_TOKEN: " chatgpt\n token ",
      },
      { preserveWhitespaceKeys: new Set(["CODEX_AUTH_JSON"]) },
    );

    expect(result).toStrictEqual({
      CODEX_AUTH_JSON: '{ "tokens": { "access": "abc" } }',
      CHATGPT_ACCESS_TOKEN: "chatgpttoken",
    });
  });
});
