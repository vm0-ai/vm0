import { describe, expect, test } from "vitest";
import { extractTemplateVars } from "../config-validator";

describe("extractTemplateVars", () => {
  test("extracts vars variable names from config object", () => {
    const config = {
      volumes: {
        "user-data": {
          name: "${{ vars.userName }}-data",
          version: "latest",
        },
      },
    };
    const vars = extractTemplateVars(config);
    expect(vars).toEqual(["userName"]);
  });

  test("extracts multiple vars variables", () => {
    const config = {
      settings: {
        prefix: "${{ vars.prefix }}",
        suffix: "${{ vars.suffix }}",
      },
    };
    const vars = extractTemplateVars(config);
    expect(vars).toHaveLength(2);
    expect(vars).toContain("prefix");
    expect(vars).toContain("suffix");
  });

  test("ignores env, secrets, and credentials variables", () => {
    const config = {
      settings: {
        envVar: "${{ env.MY_ENV }}",
        secret: "${{ secrets.mySecret }}",
        cred: "${{ credentials.MY_CRED }}",
        varsVar: "${{ vars.myVar }}",
      },
    };
    const vars = extractTemplateVars(config);
    expect(vars).toEqual(["myVar"]);
  });

  test("returns empty array when no vars variables present", () => {
    const config = {
      settings: {
        static: "static-value",
        envVar: "${{ env.MY_ENV }}",
      },
    };
    const vars = extractTemplateVars(config);
    expect(vars).toEqual([]);
  });

  test("deduplicates repeated variable references", () => {
    const config = {
      a: "${{ vars.userName }}",
      b: "${{ vars.userName }}",
      c: {
        d: "${{ vars.userName }}",
      },
    };
    const vars = extractTemplateVars(config);
    expect(vars).toEqual(["userName"]);
  });

  test("handles nested config structures", () => {
    const config = {
      agents: {
        myAgent: {
          description: "Test agent",
          framework: "claude-code",
          image: "vm0/claude-code:latest",
          volumes: {
            "user-data": {
              name: "${{ vars.userName }}-data",
              version: "latest",
            },
          },
        },
      },
    };
    const vars = extractTemplateVars(config);
    expect(vars).toEqual(["userName"]);
  });

  test("handles empty config", () => {
    const vars = extractTemplateVars({});
    expect(vars).toEqual([]);
  });

  test("handles arrays with variables", () => {
    const config = {
      items: ["${{ vars.item1 }}", "static", "${{ vars.item2 }}"],
    };
    const vars = extractTemplateVars(config);
    expect(vars).toHaveLength(2);
    expect(vars).toContain("item1");
    expect(vars).toContain("item2");
  });
});
