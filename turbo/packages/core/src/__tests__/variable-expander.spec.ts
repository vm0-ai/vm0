import { describe, expect, test } from "vitest";
import {
  extractVariableReferences,
  extractVariableReferencesFromString,
  expandVariables,
  expandVariablesInString,
  validateRequiredVariables,
  groupVariablesBySource,
  formatMissingVariables,
} from "../variable-expander.js";

describe("extractVariableReferencesFromString", () => {
  test("extracts env variables", () => {
    const refs = extractVariableReferencesFromString("${{ env.MY_VAR }}");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({
      source: "env",
      name: "MY_VAR",
      fullMatch: "${{ env.MY_VAR }}",
    });
  });

  test("extracts vars variables", () => {
    const refs = extractVariableReferencesFromString("${{ vars.myVar }}");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({
      source: "vars",
      name: "myVar",
      fullMatch: "${{ vars.myVar }}",
    });
  });

  test("extracts secrets variables", () => {
    const refs = extractVariableReferencesFromString("${{ secrets.apiKey }}");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({
      source: "secrets",
      name: "apiKey",
      fullMatch: "${{ secrets.apiKey }}",
    });
  });

  test("extracts credentials variables", () => {
    const refs = extractVariableReferencesFromString(
      "${{ credentials.MY_API_KEY }}",
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({
      source: "credentials",
      name: "MY_API_KEY",
      fullMatch: "${{ credentials.MY_API_KEY }}",
    });
  });

  test("extracts multiple variables from same string", () => {
    const refs = extractVariableReferencesFromString(
      "host: ${{ env.HOST }}, port: ${{ vars.port }}",
    );
    expect(refs).toHaveLength(2);
    expect(refs[0]?.source).toBe("env");
    expect(refs[0]?.name).toBe("HOST");
    expect(refs[1]?.source).toBe("vars");
    expect(refs[1]?.name).toBe("port");
  });

  test("handles whitespace in syntax", () => {
    const refs = extractVariableReferencesFromString("${{env.VAR}}");
    expect(refs).toHaveLength(1);
    expect(refs[0]?.name).toBe("VAR");

    const refs2 = extractVariableReferencesFromString("${{  env.VAR  }}");
    expect(refs2).toHaveLength(1);
    expect(refs2[0]?.name).toBe("VAR");
  });

  test("returns empty array for strings without variables", () => {
    const refs = extractVariableReferencesFromString("no variables here");
    expect(refs).toHaveLength(0);
  });

  test("does not match old ${VAR} syntax", () => {
    const refs = extractVariableReferencesFromString("${OLD_VAR}");
    expect(refs).toHaveLength(0);
  });

  test("does not match old {{VAR}} syntax", () => {
    const refs = extractVariableReferencesFromString("{{oldVar}}");
    expect(refs).toHaveLength(0);
  });

  test("supports underscores in variable names", () => {
    const refs = extractVariableReferencesFromString(
      "${{ env.MY_LONG_VAR_NAME }}",
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]?.name).toBe("MY_LONG_VAR_NAME");
  });

  test("supports numbers in variable names (not at start)", () => {
    const refs = extractVariableReferencesFromString("${{ vars.var123 }}");
    expect(refs).toHaveLength(1);
    expect(refs[0]?.name).toBe("var123");
  });
});

describe("extractVariableReferences", () => {
  test("extracts from nested objects", () => {
    const obj = {
      level1: {
        level2: {
          value: "${{ env.NESTED }}",
        },
      },
    };
    const refs = extractVariableReferences(obj);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.name).toBe("NESTED");
  });

  test("extracts from arrays", () => {
    const obj = {
      items: ["${{ env.ITEM1 }}", "${{ vars.item2 }}"],
    };
    const refs = extractVariableReferences(obj);
    expect(refs).toHaveLength(2);
  });

  test("deduplicates references", () => {
    const obj = {
      a: "${{ env.SAME }}",
      b: "${{ env.SAME }}",
    };
    const refs = extractVariableReferences(obj);
    expect(refs).toHaveLength(1);
  });

  test("handles mixed types", () => {
    const obj = {
      string: "${{ env.VAR }}",
      number: 42,
      boolean: true,
      null: null,
      array: [1, "${{ vars.x }}"],
    };
    const refs = extractVariableReferences(obj);
    expect(refs).toHaveLength(2);
  });
});

describe("expandVariablesInString", () => {
  test("expands env variables", () => {
    const result = expandVariablesInString("Hello ${{ env.NAME }}", {
      env: { NAME: "World" },
    });
    expect(result.result).toBe("Hello World");
    expect(result.missingVars).toHaveLength(0);
  });

  test("expands vars variables", () => {
    const result = expandVariablesInString("ID: ${{ vars.id }}", {
      vars: { id: "123" },
    });
    expect(result.result).toBe("ID: 123");
    expect(result.missingVars).toHaveLength(0);
  });

  test("expands secrets variables", () => {
    const result = expandVariablesInString("Token: ${{ secrets.token }}", {
      secrets: { token: "secret123" },
    });
    expect(result.result).toBe("Token: secret123");
    expect(result.missingVars).toHaveLength(0);
  });

  test("expands credentials variables", () => {
    const result = expandVariablesInString(
      "Key: ${{ credentials.MY_API_KEY }}",
      {
        credentials: { MY_API_KEY: "cred-value-123" },
      },
    );
    expect(result.result).toBe("Key: cred-value-123");
    expect(result.missingVars).toHaveLength(0);
  });

  test("reports missing variables", () => {
    const result = expandVariablesInString("${{ env.MISSING }}", {
      env: {},
    });
    expect(result.result).toBe("${{ env.MISSING }}");
    expect(result.missingVars).toHaveLength(1);
    expect(result.missingVars[0]?.name).toBe("MISSING");
  });

  test("reports missing source", () => {
    const result = expandVariablesInString("${{ secrets.key }}", {
      env: {},
    });
    expect(result.result).toBe("${{ secrets.key }}");
    expect(result.missingVars).toHaveLength(1);
  });

  test("expands multiple variables", () => {
    const result = expandVariablesInString("${{ env.A }} and ${{ vars.b }}", {
      env: { A: "first" },
      vars: { b: "second" },
    });
    expect(result.result).toBe("first and second");
    expect(result.missingVars).toHaveLength(0);
  });

  test("handles partial expansion", () => {
    const result = expandVariablesInString(
      "${{ env.EXISTS }} ${{ env.MISSING }}",
      {
        env: { EXISTS: "found" },
      },
    );
    expect(result.result).toBe("found ${{ env.MISSING }}");
    expect(result.missingVars).toHaveLength(1);
  });
});

describe("expandVariables", () => {
  test("expands nested objects", () => {
    const obj = {
      config: {
        host: "${{ env.HOST }}",
        port: "${{ vars.port }}",
      },
    };
    const result = expandVariables(obj, {
      env: { HOST: "localhost" },
      vars: { port: "8080" },
    });
    expect(result.result).toEqual({
      config: {
        host: "localhost",
        port: "8080",
      },
    });
    expect(result.missingVars).toHaveLength(0);
  });

  test("expands arrays", () => {
    const obj = {
      items: ["${{ env.A }}", "${{ env.B }}"],
    };
    const result = expandVariables(obj, {
      env: { A: "a", B: "b" },
    });
    expect(result.result).toEqual({
      items: ["a", "b"],
    });
  });

  test("preserves non-string values", () => {
    const obj = {
      string: "${{ env.VAR }}",
      number: 42,
      boolean: true,
      null: null,
    };
    const result = expandVariables(obj, {
      env: { VAR: "value" },
    });
    expect(result.result).toEqual({
      string: "value",
      number: 42,
      boolean: true,
      null: null,
    });
  });

  test("collects all missing vars from nested structure", () => {
    const obj = {
      a: "${{ env.MISS1 }}",
      b: {
        c: "${{ vars.miss2 }}",
      },
    };
    const result = expandVariables(obj, {
      env: {},
      vars: {},
    });
    expect(result.missingVars).toHaveLength(2);
  });

  test("deduplicates missing vars", () => {
    const obj = {
      a: "${{ env.SAME }}",
      b: "${{ env.SAME }}",
    };
    const result = expandVariables(obj, {
      env: {},
    });
    expect(result.missingVars).toHaveLength(1);
  });
});

describe("validateRequiredVariables", () => {
  test("returns empty for all present", () => {
    const refs = [
      { source: "env" as const, name: "VAR", fullMatch: "${{ env.VAR }}" },
    ];
    const missing = validateRequiredVariables(refs, {
      env: { VAR: "value" },
    });
    expect(missing).toHaveLength(0);
  });

  test("returns missing variables", () => {
    const refs = [
      { source: "env" as const, name: "MISS", fullMatch: "${{ env.MISS }}" },
    ];
    const missing = validateRequiredVariables(refs, {
      env: {},
    });
    expect(missing).toHaveLength(1);
    expect(missing[0]?.name).toBe("MISS");
  });

  test("handles missing source entirely", () => {
    const refs = [
      {
        source: "secrets" as const,
        name: "KEY",
        fullMatch: "${{ secrets.KEY }}",
      },
    ];
    const missing = validateRequiredVariables(refs, {
      env: {},
    });
    expect(missing).toHaveLength(1);
  });
});

describe("groupVariablesBySource", () => {
  test("groups variables correctly", () => {
    const refs = [
      { source: "env" as const, name: "A", fullMatch: "" },
      { source: "vars" as const, name: "B", fullMatch: "" },
      { source: "secrets" as const, name: "C", fullMatch: "" },
      { source: "credentials" as const, name: "D", fullMatch: "" },
      { source: "env" as const, name: "E", fullMatch: "" },
    ];
    const grouped = groupVariablesBySource(refs);
    expect(grouped.env).toHaveLength(2);
    expect(grouped.vars).toHaveLength(1);
    expect(grouped.secrets).toHaveLength(1);
    expect(grouped.credentials).toHaveLength(1);
  });
});

describe("formatMissingVariables", () => {
  test("formats all sources", () => {
    const missing = [
      { source: "env" as const, name: "A", fullMatch: "" },
      { source: "vars" as const, name: "b", fullMatch: "" },
      { source: "secrets" as const, name: "c", fullMatch: "" },
      { source: "credentials" as const, name: "MY_KEY", fullMatch: "" },
    ];
    const msg = formatMissingVariables(missing);
    expect(msg).toContain("Environment variables: A");
    expect(msg).toContain("CLI variables (--vars): b");
    expect(msg).toContain("Secrets: c");
    expect(msg).toContain("Credentials: MY_KEY");
  });

  test("lists multiple vars per source", () => {
    const missing = [
      { source: "env" as const, name: "A", fullMatch: "" },
      { source: "env" as const, name: "B", fullMatch: "" },
    ];
    const msg = formatMissingVariables(missing);
    expect(msg).toContain("Environment variables: A, B");
  });
});

describe("credentials to secrets aliasing", () => {
  describe("expandVariablesInString", () => {
    test("resolves credentials from credentials source", () => {
      const result = expandVariablesInString(
        "Key: ${{ credentials.MY_API_KEY }}",
        {
          credentials: { MY_API_KEY: "from-credentials" },
        },
      );
      expect(result.result).toBe("Key: from-credentials");
      expect(result.missingVars).toHaveLength(0);
    });

    test("falls back to secrets source when not in credentials", () => {
      const result = expandVariablesInString(
        "Key: ${{ credentials.MY_API_KEY }}",
        {
          secrets: { MY_API_KEY: "from-secrets" },
        },
      );
      expect(result.result).toBe("Key: from-secrets");
      expect(result.missingVars).toHaveLength(0);
    });

    test("prefers credentials source over secrets source", () => {
      const result = expandVariablesInString(
        "Key: ${{ credentials.MY_API_KEY }}",
        {
          secrets: { MY_API_KEY: "from-secrets" },
          credentials: { MY_API_KEY: "from-credentials" },
        },
      );
      expect(result.result).toBe("Key: from-credentials");
      expect(result.missingVars).toHaveLength(0);
    });

    test("resolves from secrets when credentials source exists but key missing", () => {
      const result = expandVariablesInString(
        "Key: ${{ credentials.MY_API_KEY }}",
        {
          secrets: { MY_API_KEY: "from-secrets" },
          credentials: { OTHER_KEY: "other-value" },
        },
      );
      expect(result.result).toBe("Key: from-secrets");
      expect(result.missingVars).toHaveLength(0);
    });

    test("reports missing when credential not in secrets or credentials", () => {
      const result = expandVariablesInString(
        "Key: ${{ credentials.MY_API_KEY }}",
        {
          secrets: {},
          credentials: {},
        },
      );
      expect(result.result).toBe("Key: ${{ credentials.MY_API_KEY }}");
      expect(result.missingVars).toHaveLength(1);
      expect(result.missingVars[0]?.source).toBe("credentials");
      expect(result.missingVars[0]?.name).toBe("MY_API_KEY");
    });
  });

  describe("validateRequiredVariables", () => {
    test("validates credentials against credentials source", () => {
      const refs = [
        {
          source: "credentials" as const,
          name: "MY_KEY",
          fullMatch: "${{ credentials.MY_KEY }}",
        },
      ];
      const missing = validateRequiredVariables(refs, {
        credentials: { MY_KEY: "value" },
      });
      expect(missing).toHaveLength(0);
    });

    test("validates credentials against secrets source as fallback", () => {
      const refs = [
        {
          source: "credentials" as const,
          name: "MY_KEY",
          fullMatch: "${{ credentials.MY_KEY }}",
        },
      ];
      const missing = validateRequiredVariables(refs, {
        secrets: { MY_KEY: "value" },
      });
      expect(missing).toHaveLength(0);
    });

    test("returns missing when credential not in secrets or credentials", () => {
      const refs = [
        {
          source: "credentials" as const,
          name: "MY_KEY",
          fullMatch: "${{ credentials.MY_KEY }}",
        },
      ];
      const missing = validateRequiredVariables(refs, {
        secrets: {},
        credentials: {},
      });
      expect(missing).toHaveLength(1);
      expect(missing[0]?.name).toBe("MY_KEY");
    });
  });
});
