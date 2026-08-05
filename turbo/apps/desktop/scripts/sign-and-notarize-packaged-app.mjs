#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { notarize } from "@electron/notarize";
import { sign } from "@electron/osx-sign";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptDirectory, "..");
const packageMetadata = JSON.parse(
  await readFile(path.join(desktopDirectory, "package.json"), "utf8"),
);

function requiredEnvironmentVariable(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function appPathFromArguments(argv) {
  if (argv.length !== 2 || argv[0] !== "--app") {
    throw new Error(
      "Usage: sign-and-notarize-packaged-app.mjs --app <app-path>",
    );
  }
  return path.resolve(argv[1]);
}

const appPath = appPathFromArguments(process.argv.slice(2));
const appStat = await stat(appPath);
if (
  !appStat.isDirectory() ||
  path.basename(appPath) !== "Zero Computer Use.app"
) {
  throw new Error(`Expected a Zero Computer Use.app directory: ${appPath}`);
}

await sign({
  app: appPath,
  batchCodesignCalls: true,
  identity: requiredEnvironmentVariable("VM0_DESKTOP_SIGNING_IDENTITY"),
  identityValidation: true,
  platform: "darwin",
  version: packageMetadata.devDependencies.electron,
});

await notarize({
  appPath,
  appleApiKey: requiredEnvironmentVariable("VM0_DESKTOP_NOTARIZE_API_KEY_PATH"),
  appleApiKeyId: requiredEnvironmentVariable("VM0_DESKTOP_NOTARIZE_API_KEY_ID"),
  appleApiIssuer: requiredEnvironmentVariable(
    "VM0_DESKTOP_NOTARIZE_API_ISSUER",
  ),
});
