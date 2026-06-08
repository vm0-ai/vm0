import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument near ${key ?? "end of input"}`);
    }
    args.set(key.slice(2), value);
  }
  return args;
}

function requiredArg(args, name) {
  const value = args.get(name);
  if (!value) {
    throw new Error(`Missing required --${name}`);
  }
  return value;
}

function readManifest(path) {
  if (!existsSync(path)) {
    return {
      schemaVersion: 1,
      channels: {},
      releases: {},
    };
  }

  return JSON.parse(readFileSync(path, "utf8"));
}

function ensureRecord(value, fallback = {}) {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value;
  }
  return fallback;
}

const args = parseArgs(process.argv.slice(2));
const manifestPath = requiredArg(args, "manifest");
const version = requiredArg(args, "version");
const zipUrl = requiredArg(args, "zip-url");
const channel = args.get("channel") ?? "stable";
const platform = args.get("platform") ?? "darwin";
const arch = args.get("arch") ?? "arm64";
const pubDate = args.get("pub-date") ?? new Date().toISOString();

const manifest = ensureRecord(readManifest(manifestPath));
manifest.schemaVersion = 1;
manifest.channels = ensureRecord(manifest.channels);
manifest.releases = ensureRecord(manifest.releases);

const currentChannel = ensureRecord(manifest.channels[channel], {
  blocked: [],
});
const blocked = Array.isArray(currentChannel.blocked)
  ? currentChannel.blocked
  : [];
manifest.channels[channel] = {
  ...currentChannel,
  latest: version,
  blocked,
};

const currentRelease = ensureRecord(manifest.releases[version]);
const platforms = ensureRecord(currentRelease.platforms);
const platformAssets = ensureRecord(platforms[platform]);
platformAssets[arch] = { url: zipUrl };
platforms[platform] = platformAssets;

manifest.releases[version] = {
  ...currentRelease,
  version,
  name: currentRelease.name ?? `Zero ${version}`,
  notes: currentRelease.notes ?? "",
  pubDate,
  platforms,
};

mkdirSync(dirname(manifestPath), { recursive: true });
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
