import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
async function writeManifest() {
  const manifest = {
    manifest_version: 3,
    name: "VM0 Local Browser",
    description: "Connect Chrome to VM0 Local Browser Use.",
    version: pkg.version,
    minimum_chrome_version: "120",
    action: {
      default_title: "VM0 Local Browser",
      default_popup: "popup.html",
    },
    background: {
      service_worker: "background.js",
      type: "module",
    },
    permissions: ["alarms", "scripting", "storage", "tabs"],
    host_permissions: ["http://*/*", "https://*/*"],
    content_scripts: [
      {
        matches: [
          "https://*.vm0.ai/*",
          "https://*.vm7.ai/*",
          "http://localhost/*",
          "http://127.0.0.1/*",
        ],
        js: ["content.js"],
        run_at: "document_idle",
      },
    ],
  };

  await writeFile(
    resolve(dist, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

async function copyStaticFiles() {
  const [html, css] = await Promise.all([
    readFile(resolve(root, "src/popup/popup.html"), "utf8"),
    readFile(resolve(root, "src/popup/popup.css"), "utf8"),
  ]);
  await Promise.all([
    writeFile(resolve(dist, "popup.html"), html),
    writeFile(resolve(dist, "popup.css"), css),
  ]);
}

async function buildOnce() {
  await rm(dist, { force: true, recursive: true });
  await mkdir(dist, { recursive: true });
  await Promise.all([
    build({
      bundle: true,
      define: {
        __EXTENSION_VERSION__: JSON.stringify(pkg.version),
      },
      entryPoints: [resolve(root, "src/background/index.ts")],
      format: "esm",
      outfile: resolve(dist, "background.js"),
      platform: "browser",
      sourcemap: true,
      target: "chrome120",
    }),
    build({
      bundle: true,
      entryPoints: [resolve(root, "src/content/index.ts")],
      format: "iife",
      outfile: resolve(dist, "content.js"),
      platform: "browser",
      sourcemap: true,
      target: "chrome120",
    }),
    build({
      bundle: true,
      entryPoints: [resolve(root, "src/popup/index.ts")],
      format: "iife",
      outfile: resolve(dist, "popup.js"),
      platform: "browser",
      sourcemap: true,
      target: "chrome120",
    }),
  ]);
  await Promise.all([writeManifest(), copyStaticFiles()]);
}

await buildOnce();
