import { build } from "tsup";
import { cp, copyFile, mkdir, realpath, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";

const [directory, native, runtime] = process.argv.slice(2);
if (
  ![directory, native, runtime].every(
    (value) => value && path.isAbsolute(value),
  )
)
  throw new Error(
    "Expected absolute proof, native build, and staged CUA paths",
  );
await mkdir(directory, { mode: 0o700 });
const output = await realpath(directory);
const common = {
  config: false,
  platform: "node",
  target: "node20",
  format: ["cjs"],
  external: ["electron"],
  noExternal: ["zod", /^@okouai\//],
};
await build({
  ...common,
  entry: { discovery: "cua/discovery-proof/main.ts" },
  outDir: output,
});
await build({
  ...common,
  entry: { "cua-sdk-process": "src/cua-sdk-process.ts" },
  outDir: path.join(output, "native"),
});
await copyFile(
  path.join(native, "owner.node"),
  path.join(output, "native/cua-owner.node"),
);
await copyFile(
  path.join(native, "guardian"),
  path.join(output, "native/cua-guardian"),
);
await cp(runtime, path.join(output, "cua"), { recursive: true });

const bundleId = `ai.okou.discovery-proof.${randomUUID()}`;
const fixture = path.join(output, "DiscoveryFixture.app");
await mkdir(path.join(fixture, "Contents/MacOS"), { recursive: true });
await writeFile(
  path.join(fixture, "Contents/Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleName</key><string>Okou Discovery Fixture</string>
<key>CFBundleExecutable</key><string>fixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
`,
);
execFileSync(
  "clang",
  [
    "-fobjc-arc",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-framework",
    "AppKit",
    "cua/discovery-proof/fixture.m",
    "-o",
    path.join(fixture, "Contents/MacOS/fixture"),
  ],
  { stdio: "inherit" },
);
execFileSync("codesign", ["--force", "--sign", "-", fixture], {
  stdio: "inherit",
});
await writeFile(
  path.join(output, "fixture.json"),
  JSON.stringify({ bundleId, fixture }) + "\n",
);
console.log(`Discovery proof built in ${output}`);
