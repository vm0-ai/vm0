// Dynamic ESLint config for ablation experiments.
// Reads env vars:
//   REMOVE_PROJECT_SERVICE=1  — strips projectService + disables all rules in that block
//   DISABLED_RULES=a,b,c      — turns those rule names off everywhere
import process from "node:process";

const { default: baseConfig } = await import("./eslint.config.js");

const disabled = (process.env.DISABLED_RULES ?? "").split(",").filter(Boolean);
const removePS = process.env.REMOVE_PROJECT_SERVICE === "1";

export default baseConfig.map((cfg) => {
  if (!cfg || typeof cfg !== "object") {
    return cfg;
  }
  let out = { ...cfg };

  const hadProjectService = Boolean(
    out.languageOptions?.parserOptions?.projectService,
  );

  if (removePS && hadProjectService) {
    const {
      projectService: _ps,
      tsconfigRootDir: _root,
      ...restParser
    } = out.languageOptions.parserOptions;
    out = {
      ...out,
      languageOptions: { ...out.languageOptions, parserOptions: restParser },
    };
    if (out.rules) {
      const silenced = Object.fromEntries(
        Object.keys(out.rules).map((r) => [r, "off"]),
      );
      out = { ...out, rules: silenced };
    }
  }

  if (disabled.length > 0 && out.rules) {
    const rules = { ...out.rules };
    for (const r of disabled) {
      if (r in rules) {
        rules[r] = "off";
      }
    }
    out = { ...out, rules };
  }

  return out;
});
