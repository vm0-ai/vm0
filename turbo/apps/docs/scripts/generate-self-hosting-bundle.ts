/**
 * Generate self-hosting bundle for docs.
 *
 * Reads the multi-file Docker Compose setup from /docker and produces:
 *   1. A single standalone docker-compose.yml (resolves include/extends)
 *   2. A tar.gz bundle containing docker-compose.yml, Caddyfile, .env.example
 *
 * Output: public/self-hosting/
 */

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import archiver from "archiver";
import { parse, stringify } from "yaml";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const DOCKER_DIR = resolve(scriptDir, "../../../../docker");
const OUTPUT_DIR = resolve(scriptDir, "../public/self-hosting");

interface ComposeService {
  [key: string]: unknown;
}

interface ComposeFile {
  services?: Record<string, ComposeService>;
  volumes?: Record<string, unknown>;
  networks?: Record<string, unknown>;
}

function readYaml(filename: string): ComposeFile {
  const content = readFileSync(resolve(DOCKER_DIR, filename), "utf-8");
  return parse(content) as ComposeFile;
}

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof result[key] === "object" &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

function mergeComposeFiles(): string {
  const base = readYaml("docker-compose.base.yml");
  const webBase = readYaml("docker-compose.web-base.yml");
  const main = readYaml("docker-compose.yml");

  const services: Record<string, ComposeService> = {};

  // Copy infrastructure services from base
  if (base.services) {
    for (const [name, svc] of Object.entries(base.services)) {
      services[name] = { ...svc };
    }
  }

  // Resolve extends: web = web-base + main.web overrides
  const webBaseTemplate =
    (webBase.services?.["web-base"] as ComposeService) ?? {};
  const webOverrides = (main.services?.["web"] as ComposeService) ?? {};
  const { extends: _ignoreWebExtends, ...webClean } = webOverrides;
  void _ignoreWebExtends;
  services["web"] = deepMerge(
    webBaseTemplate as Record<string, unknown>,
    webClean as Record<string, unknown>,
  ) as ComposeService;

  // Resolve extends: platform = platform-base + main.platform overrides
  const platformBaseTemplate =
    (webBase.services?.["platform-base"] as ComposeService) ?? {};
  const platformOverrides =
    (main.services?.["platform"] as ComposeService) ?? {};
  const { extends: _ignorePlatformExtends, ...platformClean } =
    platformOverrides;
  void _ignorePlatformExtends;
  services["platform"] = deepMerge(
    platformBaseTemplate as Record<string, unknown>,
    platformClean as Record<string, unknown>,
  ) as ComposeService;

  // Deterministic service order
  const orderedServices: Record<string, ComposeService> = {};
  const order = [
    "postgres",
    "minio",
    "minio-init",
    "web",
    "platform",
    "caddy",
    "cron",
  ];
  for (const name of order) {
    if (services[name]) {
      orderedServices[name] = services[name];
    }
  }
  for (const [name, svc] of Object.entries(services)) {
    if (!orderedServices[name]) {
      orderedServices[name] = svc;
    }
  }

  const composed: ComposeFile = {
    services: orderedServices,
    volumes: base.volumes ?? {},
    networks: base.networks ?? {},
  };

  return stringify(composed, {
    lineWidth: 0,
    blockQuote: "literal",
    defaultStringType: "PLAIN",
    defaultKeyType: "PLAIN",
    nullStr: "",
  });
}

function createTarGz(
  files: Array<{ name: string; content: string }>,
  outputPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const archive = archiver("tar", { gzip: true });

    output.on("close", () => resolve());
    archive.on("error", (err) => reject(err));

    archive.pipe(output);
    for (const file of files) {
      archive.append(file.content, { name: file.name });
    }
    archive.finalize().catch(reject);
  });
}

async function main(): Promise<void> {
  console.log("[self-hosting] Generating self-hosting bundle...");

  if (!existsSync(DOCKER_DIR)) {
    console.warn(
      `[self-hosting] Docker directory not found at ${DOCKER_DIR}, skipping`,
    );
    return;
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });

  // 1. Merge compose files
  const composedYaml = mergeComposeFiles();
  const composeOutPath = resolve(OUTPUT_DIR, "docker-compose.yml");
  writeFileSync(composeOutPath, composedYaml);
  console.log(`[self-hosting] Written ${composeOutPath}`);

  // 2. Copy Caddyfile
  const caddyfileContent = readFileSync(
    resolve(DOCKER_DIR, "Caddyfile"),
    "utf-8",
  );
  const caddyfileDst = resolve(OUTPUT_DIR, "Caddyfile");
  writeFileSync(caddyfileDst, caddyfileContent);
  console.log(`[self-hosting] Written ${caddyfileDst}`);

  // 3. Copy .env.example
  const envContent = readFileSync(resolve(DOCKER_DIR, ".env.example"), "utf-8");
  const envDst = resolve(OUTPUT_DIR, ".env.example");
  writeFileSync(envDst, envContent);
  console.log(`[self-hosting] Written ${envDst}`);

  // 4. Create tar.gz bundle
  const tarPath = resolve(OUTPUT_DIR, "vm0-self-hosted.tar.gz");
  await createTarGz(
    [
      { name: "docker-compose.yml", content: composedYaml },
      { name: "Caddyfile", content: caddyfileContent },
      { name: ".env.example", content: envContent },
    ],
    tarPath,
  );
  console.log(`[self-hosting] Written ${tarPath}`);

  console.log("[self-hosting] Bundle generation complete.");
}

await main();
