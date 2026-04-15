/**
 * Download external API specs and populate the local content-addressed cache.
 *
 * Usage:
 *   tsx src/update-specs.ts           # update all
 *   tsx src/update-specs.ts gmail     # update single generator
 *   tsx src/update-specs.ts axiom gmail xero  # update multiple
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  MAP_PATH,
  SPECS_DIR,
  type SpecsMap,
  fetchRemote,
  hashContent,
  writeSpecFile,
} from "./codegen";

type SpecEntries = Map<string, string>; // key → content

interface Updater {
  name: string;
  fetch: () => Promise<SpecEntries>;
}

// ── Static URL helper ───────────────────────────────────────────────────

// Fetches in this file are sequential (not Promise.all) to stay polite with
// external APIs and avoid rate limits (e.g. unauthenticated GitHub is 60/hr).
// update-specs is a one-off manual command, so the extra latency is fine.
function staticUpdater(name: string, urls: string[]): Updater {
  return {
    name,
    fetch: async () => {
      const entries = new Map<string, string>();
      for (const url of urls) {
        const res = await fetchRemote(url, `${name}: ${url}`);
        entries.set(url, await res.text());
      }
      return entries;
    },
  };
}

// ── Dynamic updaters ────────────────────────────────────────────────────

const deelUpdater: Updater = {
  name: "deel",
  fetch: async () => {
    const indexUrl = "https://developer.deel.com/openapi.json";

    // 1. Fetch HTML index to discover spec IDs (not cached — ephemeral discovery)
    const res = await fetchRemote(indexUrl, "Deel spec index");
    const html = await res.text();
    const ids = [
      ...new Set(
        [...html.matchAll(/\?api=([0-9a-f-]{36})/g)].map((m) => m[1]!),
      ),
    ];
    if (ids.length === 0) {
      throw new Error("No spec IDs found in Deel docs index page");
    }
    console.error(`  Discovered ${ids.length} spec IDs`);

    // 2. Cache each discovered spec
    const entries = new Map<string, string>();
    for (const id of ids) {
      const url = `${indexUrl}?api=${id}`;
      const specRes = await fetchRemote(url, `deel: ${id.slice(0, 8)}`);
      entries.set(url, await specRes.text());
    }
    return entries;
  },
};

interface GitHubContent {
  name: string;
  download_url: string;
}

const dropboxUpdater: Updater = {
  name: "dropbox",
  fetch: async () => {
    const listUrl =
      "https://api.github.com/repos/dropbox/dropbox-api-spec/contents/";

    // 1. List .stone files via GitHub API (not cached — ephemeral discovery)
    const listRes = await fetchRemote(listUrl, "Dropbox spec file list", {
      headers: { Accept: "application/vnd.github.v3+json" },
    });
    const json: unknown = await listRes.json();
    if (!Array.isArray(json)) {
      throw new Error("Expected array from GitHub contents API");
    }
    const files = (json as GitHubContent[]).filter((f) =>
      f.name.endsWith(".stone"),
    );
    console.error(`  Found ${files.length} .stone files`);

    // 2. Cache each .stone file
    const entries = new Map<string, string>();
    for (const file of files) {
      const res = await fetchRemote(file.download_url, file.name);
      entries.set(file.download_url, await res.text());
    }
    return entries;
  },
};

const slackUpdater: Updater = {
  name: "slack",
  fetch: async () => {
    const tarballUrl =
      "https://github.com/slack-ruby/slack-api-ref/archive/refs/heads/master.tar.gz";
    const tmpDir = fs.mkdtempSync("/tmp/slack-api-ref-");
    try {
      console.error("  Downloading slack-api-ref tarball...");
      // -f makes curl exit non-zero on HTTP errors (otherwise -s would silently
      // pipe an HTML error page into tar). --wildcards is GNU tar specific;
      // macOS users need `brew install gnu-tar` and may need to symlink as `tar`.
      execSync(
        `curl -fsSL "${tarballUrl}" | tar xz -C "${tmpDir}" --strip-components=1 --wildcards "*/docs.slack.dev/methods"`,
        { stdio: ["pipe", "pipe", "inherit"] },
      );

      const methodsDir = path.join(tmpDir, "docs.slack.dev", "methods");
      const files = fs
        .readdirSync(methodsDir)
        .filter((f) => f.endsWith(".json") && f !== "methods.json")
        .sort();
      console.error(`  Extracted ${files.length} method files`);

      const entries = new Map<string, string>();
      for (const file of files) {
        const content = fs.readFileSync(path.join(methodsDir, file), "utf-8");
        entries.set(`methods/${file}`, content);
      }
      return entries;
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  },
};

// ── Updater registry ────────────────────────────────────────────────────

const UPDATERS: Updater[] = [
  // Static generators
  staticUpdater("axiom", [
    "https://axiom.co/docs/restapi/versions/v2.json",
    "https://axiom.co/docs/restapi/versions/v1.json",
    "https://axiom.co/docs/restapi/versions/v1-edge-query.json",
    "https://axiom.co/docs/restapi/versions/v1-edge-ingest.json",
  ]),
  staticUpdater("figma", [
    "https://raw.githubusercontent.com/figma/rest-api-spec/main/openapi/openapi.yaml",
  ]),
  staticUpdater("gmail", [
    "https://gmail.googleapis.com/$discovery/rest?version=v1",
  ]),
  staticUpdater("google-calendar", [
    "https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest",
  ]),
  staticUpdater("google-docs", [
    "https://docs.googleapis.com/$discovery/rest?version=v1",
  ]),
  staticUpdater("google-drive", [
    "https://www.googleapis.com/discovery/v1/apis/drive/v2/rest",
    "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
  ]),
  staticUpdater("google-meet", [
    "https://meet.googleapis.com/$discovery/rest?version=v2",
  ]),
  staticUpdater("google-sheets", [
    "https://sheets.googleapis.com/$discovery/rest?version=v4",
  ]),
  staticUpdater("youtube", [
    "https://www.googleapis.com/discovery/v1/apis/youtube/v3/rest",
  ]),
  staticUpdater("notion", ["https://developers.notion.com/openapi.json"]),
  staticUpdater("sentry", [
    "https://raw.githubusercontent.com/getsentry/sentry-api-schema/refs/heads/main/openapi-derefed.json",
  ]),
  staticUpdater("strava", [
    "https://developers.strava.com/swagger/swagger.json",
  ]),
  staticUpdater("vercel", ["https://openapi.vercel.sh/"]),
  staticUpdater("x", ["https://api.twitter.com/2/openapi.json"]),
  staticUpdater("xero", [
    "https://raw.githubusercontent.com/XeroAPI/Xero-OpenAPI/master/xero_accounting.yaml",
    "https://raw.githubusercontent.com/XeroAPI/Xero-OpenAPI/master/xero-app-store.yaml",
    "https://raw.githubusercontent.com/XeroAPI/Xero-OpenAPI/master/xero_assets.yaml",
    "https://raw.githubusercontent.com/XeroAPI/Xero-OpenAPI/master/xero_bankfeeds.yaml",
    "https://raw.githubusercontent.com/XeroAPI/Xero-OpenAPI/master/xero_files.yaml",
    "https://raw.githubusercontent.com/XeroAPI/Xero-OpenAPI/master/xero-finance.yaml",
    "https://raw.githubusercontent.com/XeroAPI/Xero-OpenAPI/master/xero-identity.yaml",
    "https://raw.githubusercontent.com/XeroAPI/Xero-OpenAPI/master/xero-payroll-au.yaml",
    "https://raw.githubusercontent.com/XeroAPI/Xero-OpenAPI/master/xero-payroll-au-v2.yaml",
    "https://raw.githubusercontent.com/XeroAPI/Xero-OpenAPI/master/xero-payroll-nz.yaml",
    "https://raw.githubusercontent.com/XeroAPI/Xero-OpenAPI/master/xero-payroll-uk.yaml",
    "https://raw.githubusercontent.com/XeroAPI/Xero-OpenAPI/master/xero-projects.yaml",
  ]),

  // Dynamic generators
  deelUpdater,
  dropboxUpdater,
  slackUpdater,
];

// ── Orchestrator ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const targets = process.argv.slice(2);

  fs.mkdirSync(SPECS_DIR, { recursive: true });
  const map: SpecsMap = fs.existsSync(MAP_PATH)
    ? (JSON.parse(fs.readFileSync(MAP_PATH, "utf-8")) as SpecsMap)
    : {};

  const updaters =
    targets.length > 0
      ? UPDATERS.filter((u) => targets.includes(u.name))
      : UPDATERS;

  if (targets.length > 0) {
    const unknown = targets.filter((t) => !UPDATERS.some((u) => u.name === t));
    if (unknown.length > 0) {
      console.error(
        `Unknown generators: ${unknown.join(", ")}\nAvailable: ${UPDATERS.map((u) => u.name).join(", ")}`,
      );
      process.exit(1);
    }
  }

  const orphanDirs: Array<{ dir: string; keep: Set<string> }> = [];

  for (const updater of updaters) {
    console.error(`\n=== ${updater.name} ===`);
    const entries = await updater.fetch();
    const genDir = path.join(SPECS_DIR, updater.name);
    fs.mkdirSync(genDir, { recursive: true });
    const section: Record<string, string> = {};

    for (const [key, content] of entries) {
      const hash = hashContent(content);
      const specPath = path.join(genDir, hash);
      if (!fs.existsSync(specPath)) {
        writeSpecFile(specPath, content);
      }
      section[key] = hash;
    }

    map[updater.name] = section;
    orphanDirs.push({ dir: genDir, keep: new Set(Object.values(section)) });
    console.error(`  ${entries.size} specs cached`);
  }

  // Write map BEFORE cleaning up orphans — if we crash after cleanup
  // but before map write, the map would reference deleted files.
  const sorted: SpecsMap = {};
  for (const key of Object.keys(map).sort()) {
    sorted[key] = Object.fromEntries(
      Object.entries(map[key]!).sort(([a], [b]) => a.localeCompare(b)),
    );
  }
  fs.writeFileSync(MAP_PATH, JSON.stringify(sorted, null, 2) + "\n");

  // Now safe to remove orphaned files
  for (const { dir, keep } of orphanDirs) {
    for (const file of fs.readdirSync(dir)) {
      if (!keep.has(file)) {
        fs.unlinkSync(path.join(dir, file));
      }
    }
  }

  // On a full update (no targets), remove generator directories that are
  // no longer in the map (i.e. removed from UPDATERS).
  if (targets.length === 0) {
    const knownGenerators = new Set(Object.keys(map));
    for (const entry of fs.readdirSync(SPECS_DIR)) {
      const entryPath = path.join(SPECS_DIR, entry);
      if (fs.statSync(entryPath).isDirectory() && !knownGenerators.has(entry)) {
        fs.rmSync(entryPath, { recursive: true });
        console.error(`Removed obsolete generator dir: ${entry}`);
      }
    }
  }

  console.error("\nDone.");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
