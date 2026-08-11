#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const assetsDirectory = process.argv[2];
if (!assetsDirectory) {
  throw new Error("usage: find-okou-pages-probe-assets.mjs <assets-directory>");
}

const assetNames = await readdir(assetsDirectory);
const javascriptAssets = new Set(
  assetNames.filter((assetName) => assetName.endsWith(".js")),
);
const rootPrefixes = ["index-", "Route-", "SignIn-", "SignUp-"];
const roots = [...javascriptAssets].filter((assetName) =>
  rootPrefixes.some((prefix) => assetName.startsWith(prefix)),
);

for (const prefix of rootPrefixes) {
  if (!roots.some((assetName) => assetName.startsWith(prefix))) {
    throw new Error(`Could not identify ${prefix} preview assets`);
  }
}

const queuedAssets = [...roots];
const reachableAssets = new Set();
const relativeImportPattern = /["']\.\/([^"'?#]+\.js)(?:[?#][^"']*)?["']/g;

while (queuedAssets.length > 0) {
  const assetName = queuedAssets.pop();
  if (!assetName || reachableAssets.has(assetName)) {
    continue;
  }
  reachableAssets.add(assetName);

  const source = await readFile(path.join(assetsDirectory, assetName), "utf8");
  for (const match of source.matchAll(relativeImportPattern)) {
    const dependencyName = match[1];
    if (
      javascriptAssets.has(dependencyName) &&
      !reachableAssets.has(dependencyName)
    ) {
      queuedAssets.push(dependencyName);
    }
  }
}

for (const assetName of [...reachableAssets].sort()) {
  console.log(path.join(assetsDirectory, assetName));
}
