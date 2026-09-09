/** Bundle real app/RPC code and substitute only the public SDK boundary. */
import { build } from "tsup";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const [directory, native] = process.argv.slice(-2);
if (!path.isAbsolute(directory) || !path.isAbsolute(native))
  throw new Error("Expected dedicated absolute proof paths");
const common = {
  config: false,
  platform: "node",
  target: "node20",
  external: ["electron"],
  noExternal: ["zod", /^@okouai\//],
};
await build({
  ...common,
  entry: { adapter: "scripts/cua-adapter-proof.ts" },
  format: ["cjs"],
  outDir: directory,
});
await build({
  ...common,
  entry: { "cua-sdk-process": "src/cua-sdk-process.ts" },
  format: ["cjs"],
  outDir: path.join(directory, "native"),
});
const sdk = "node_modules/@trycua/cua-driver";
await build({
  ...common,
  entry: { index: "scripts/test-cua-sdk.ts" },
  format: ["esm"],
  outDir: path.join(directory, "cua", sdk, "dist"),
  outExtension: () => ({ js: ".js" }),
});
await copyFile(
  path.join(native, "owner.node"),
  path.join(directory, "native/cua-owner.node"),
);
await copyFile(
  path.join(native, "guardian"),
  path.join(directory, "native/cua-guardian"),
);
const lock = JSON.parse(await readFile("cua/artifacts.json", "utf8"));
const files = {};
for (const artifact of lock.artifacts) {
  for (const file of artifact.files) {
    const relative = path.join(
      artifact.destination,
      artifact.destination === "." ? file : file.slice("package/".length),
    );
    const destination = path.join(directory, "cua", relative);
    await mkdir(path.dirname(destination), { recursive: true });
    if (relative === `${sdk}/package.json`)
      await writeFile(destination, '{"type":"module"}\n');
    else if (relative !== `${sdk}/dist/index.js`)
      await writeFile(destination, "");
    files[relative] = createHash("sha256")
      .update(await readFile(destination))
      .digest("hex");
  }
}
await writeFile(
  path.join(directory, "cua/payload.json"),
  JSON.stringify({
    driverVersion: lock.driverVersion,
    files,
  }),
);
