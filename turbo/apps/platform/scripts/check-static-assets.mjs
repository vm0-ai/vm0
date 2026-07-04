import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");

const checkedRoots = ["src", "public"];
const staticAssetExtensions = new Set([
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
]);

const sameOriginAssetAllowlist = new Set([
  "public/icons/icon-192.png",
  "public/icons/icon-512-maskable.png",
  "public/icons/icon-512.png",
]);

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function collectFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath));
      continue;
    }
    if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

const violations = [];

for (const root of checkedRoots) {
  const rootPath = path.join(appRoot, root);
  if (!statSync(rootPath, { throwIfNoEntry: false })?.isDirectory()) {
    continue;
  }

  for (const file of collectFiles(rootPath)) {
    const relativePath = toPosixPath(path.relative(appRoot, file));
    const extension = path.extname(relativePath).toLowerCase();
    if (!staticAssetExtensions.has(extension)) {
      continue;
    }
    if (sameOriginAssetAllowlist.has(relativePath)) {
      continue;
    }
    violations.push(relativePath);
  }
}

if (violations.length > 0) {
  process.stderr.write(`Platform static asset lint failed.

These files look like UI illustrations, empty states, brand/logo images, connector/provider icons, or other build-stable png/webp/svg assets:

${violations.map((file) => `  - ${file}`).join("\n")}

Do not commit this kind of asset to vm0. Add it to vm0-ai/static-files under static.vm0.io/platform/... using a versioned or content-hashed path.

static.vm0.io is append-only and hard cached for one year. Never overwrite, rename, or delete an existing published path; add a new unique path instead.

In platform code, reference the CDN asset with platformStaticAssetUrl("..."), or add it to the existing platform asset URL map when a typed/shared constant is useful. For example:

  platformStaticAssetUrl("views/zero-page/assets/example-<hash>.webp")

Only same-origin browser assets such as manifest or push-notification icons should be allowlisted here, with a narrow path-specific exception.
`);
  process.exit(1);
}
