#!/usr/bin/env node

import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const defaultBackgroundSvg = path.join(
  desktopDir,
  "assets",
  "dmg-background.svg",
);

const windowBounds = {
  left: 120,
  top: 90,
  right: 780,
  bottom: 490,
};
const backgroundWidth = windowBounds.right - windowBounds.left;
const backgroundHeight = windowBounds.bottom - windowBounds.top;
const backgroundScale = 2;
const backgroundDpi = 72 * backgroundScale;
const appIconPosition = { x: 170, y: 224 };
const applicationsIconPosition = { x: 490, y: 224 };

function usage() {
  return [
    "Usage:",
    "  node apps/desktop/scripts/create-styled-dmg.mjs --app <app-path> --out <dmg-path> [--volume-name <name>] [--background-svg <svg-path>]",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    volumeName: "Zero Computer Use",
    backgroundSvg: defaultBackgroundSvg,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }

    if (!value) {
      throw new Error(`Missing value for ${arg}`);
    }

    if (arg === "--app") {
      options.appPath = path.resolve(value);
      index += 1;
      continue;
    }
    if (arg === "--out") {
      options.outPath = path.resolve(value);
      index += 1;
      continue;
    }
    if (arg === "--volume-name") {
      options.volumeName = value;
      index += 1;
      continue;
    }
    if (arg === "--background-svg") {
      options.backgroundSvg = path.resolve(value);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.appPath || !options.outPath) {
    throw new Error(usage());
  }

  return options;
}

function escapeAppleScriptString(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

async function run(command, args, options = {}) {
  const { silent, ...execOptions } = options;
  const { stdout, stderr } = await execFileAsync(command, args, {
    maxBuffer: 20 * 1024 * 1024,
    ...execOptions,
  });

  if (stdout && !silent) {
    process.stdout.write(stdout);
  }
  if (stderr && !silent) {
    process.stderr.write(stderr);
  }

  return stdout;
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function appSizeMegabytes(appPath) {
  const stdout = await run("du", ["-sm", appPath], { silent: true });
  const [size] = stdout.trim().split(/\s+/);
  return Number.parseInt(size, 10);
}

function finderLayoutScript({ appName, backgroundPng, mountPath }) {
  const escapedAppName = escapeAppleScriptString(appName);
  const escapedBackgroundPng = escapeAppleScriptString(backgroundPng);
  const escapedMountPath = escapeAppleScriptString(mountPath);

  return `
set mountedFolder to POSIX file "${escapedMountPath}" as alias
set backgroundPicture to POSIX file "${escapedBackgroundPng}" as alias
tell application "Finder"
  open mountedFolder
  set targetWindow to container window of mountedFolder
  set current view of targetWindow to icon view
  set toolbar visible of targetWindow to false
  set statusbar visible of targetWindow to false
  set bounds of targetWindow to {${windowBounds.left}, ${windowBounds.top}, ${windowBounds.right}, ${windowBounds.bottom}}
  set viewOptions to icon view options of targetWindow
  set arrangement of viewOptions to not arranged
  set icon size of viewOptions to 104
  set text size of viewOptions to 13
  set background picture of viewOptions to backgroundPicture
  set position of item "${escapedAppName}" of mountedFolder to {${appIconPosition.x}, ${appIconPosition.y}}
  set position of item "Applications" of mountedFolder to {${applicationsIconPosition.x}, ${applicationsIconPosition.y}}
  update mountedFolder without registering applications
  delay 1
  close targetWindow
end tell
`;
}

async function createStyledDmg({
  appPath,
  backgroundSvg,
  outPath,
  volumeName,
}) {
  if (process.platform !== "darwin") {
    throw new Error("Styled DMG creation requires macOS.");
  }

  const appStats = await stat(appPath);
  if (!appStats.isDirectory() || path.extname(appPath) !== ".app") {
    throw new Error(`Expected --app to point at a .app bundle: ${appPath}`);
  }
  if (!(await pathExists(backgroundSvg))) {
    throw new Error(`No DMG background SVG found: ${backgroundSvg}`);
  }

  const appName = path.basename(appPath);
  const tempDir = await mkdtemp(path.join(tmpdir(), "zero-desktop-dmg-"));
  const rwDmgPath = path.join(tempDir, "Zero Computer Use.rw.dmg");
  const mountPath = path.join(tempDir, "mount");
  const backgroundDir = path.join(mountPath, ".background");
  const backgroundPng = path.join(backgroundDir, "background.png");
  const dsStore = path.join(mountPath, ".DS_Store");
  let mounted = false;

  try {
    const sourceSizeMb = await appSizeMegabytes(appPath);
    const imageSizeMb = Math.max(sourceSizeMb + 96, 360);

    await rm(outPath, { force: true });
    await mkdir(mountPath);
    await run("hdiutil", [
      "create",
      "-volname",
      volumeName,
      "-size",
      `${imageSizeMb}m`,
      "-fs",
      "HFS+",
      "-ov",
      rwDmgPath,
    ]);
    await run("hdiutil", [
      "attach",
      rwDmgPath,
      "-nobrowse",
      "-mountpoint",
      mountPath,
    ]);
    mounted = true;

    await run("ditto", [appPath, path.join(mountPath, appName)]);
    await symlink("/Applications", path.join(mountPath, "Applications"));
    await mkdir(backgroundDir);
    await run("sips", [
      "-s",
      "format",
      "png",
      "-z",
      String(backgroundHeight * backgroundScale),
      String(backgroundWidth * backgroundScale),
      "-s",
      "dpiWidth",
      String(backgroundDpi),
      "-s",
      "dpiHeight",
      String(backgroundDpi),
      backgroundSvg,
      "--out",
      backgroundPng,
    ]);
    await run("chflags", ["hidden", backgroundDir]);
    await run("osascript", [
      "-e",
      finderLayoutScript({
        appName,
        backgroundPng,
        mountPath,
      }),
    ]);
    if (!(await pathExists(dsStore))) {
      throw new Error("Finder did not write the DMG layout metadata.");
    }
    await run("sync", []);

    await run("hdiutil", ["detach", mountPath]);
    mounted = false;

    await run("hdiutil", [
      "convert",
      rwDmgPath,
      "-format",
      "UDZO",
      "-imagekey",
      "zlib-level=9",
      "-o",
      outPath,
    ]);
    await run("hdiutil", ["verify", outPath]);
  } finally {
    if (mounted) {
      await run("hdiutil", ["detach", mountPath]).catch(() => {});
    }
    if (process.env.ZERO_DESKTOP_KEEP_DMG_TEMP !== "true") {
      await rm(tempDir, { force: true, recursive: true });
    } else {
      console.log(`Kept temporary DMG directory: ${tempDir}`);
    }
  }
}

const options = parseArgs(process.argv.slice(2));
await createStyledDmg(options);
console.log(`Created styled DMG: ${options.outPath}`);
