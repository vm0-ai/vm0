#!/usr/bin/env bash
# Round 6: is the apps/api core program's peak RSS driven by breadth (many files
# of similar cost, so splitting the project helps) or by a hot subset (so
# splitting just moves the peak)?
#
# Each variant type-checks a subset of core's inputs. tsc still pulls the whole
# transitive import closure in as sources, so a subset's peak is a *lower bound*
# for what that subset would cost as the leaf project of a real split.
set -euo pipefail

variant="${1:?variant required}"
cd turbo/apps/api

write_probe() {
  node -e '
    const fs = require("node:fs");
    const include = JSON.parse(process.argv[1]);
    const config = {
      extends: "./tsconfig.json",
      compilerOptions: {
        noEmit: true,
        incremental: false,
        disableSourceOfProjectReferenceRedirect: true,
      },
      include,
      exclude: [
        "node_modules",
        "dist",
        "src/**/__benches__/**/*",
        "src/**/__tests__/**/*",
        "src/**/*.bench.ts",
        "src/**/*.spec.ts",
        "src/**/*.suite.ts",
        "src/**/*.test.ts",
        "src/test-fixtures/**/*",
      ],
      references: [{ path: "./tsconfig.gateways.json" }],
    };
    fs.writeFileSync("tsconfig.probe.json", JSON.stringify(config, null, 2));
    console.log("probe include:", JSON.stringify(include));
  ' "$1"
}

service_half() {
  # $1 = 1 or 2 -- alphabetical half of src/signals/services
  node -e '
    const fs = require("node:fs");
    const half = Number(process.argv[1]);
    const files = fs
      .readdirSync("src/signals/services")
      .filter((f) => f.endsWith(".ts"))
      .sort();
    const mid = Math.ceil(files.length / 2);
    const picked = half === 1 ? files.slice(0, mid) : files.slice(mid);
    console.log(JSON.stringify(picked.map((f) => `src/signals/services/${f}`)));
  ' "$1"
}

case "$variant" in
  core-full)
    write_probe '["src/**/*"]'
    ;;
  services-all)
    write_probe '["src/signals/services/**/*"]'
    ;;
  services-half-1)
    write_probe "$(service_half 1)"
    ;;
  services-half-2)
    write_probe "$(service_half 2)"
    ;;
  routes-all)
    write_probe '["src/signals/routes/**/*"]'
    ;;
  lib-external)
    write_probe '["src/lib/**/*","src/signals/external/**/*","src/signals/auth/**/*"]'
    ;;
  *)
    echo "unknown variant: $variant" >&2
    exit 1
    ;;
esac

echo "--- probe [$variant] written"
