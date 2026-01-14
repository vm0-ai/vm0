import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import path from "path";

/**
 * Storage type
 * - "volume": Static storage that doesn't auto-version after runs
 * - "artifact": Work products that auto-version after runs
 */
export type StorageType = "volume" | "artifact";

export interface StorageConfig {
  name: string;
  type: StorageType;
}

const CONFIG_DIR = ".vm0";
const CONFIG_FILE = "storage.yaml";

/**
 * Validate storage name format
 * Length: 3-64 characters
 * Characters: lowercase letters, numbers, hyphens
 * Must start and end with alphanumeric
 * No consecutive hyphens
 */
export function isValidStorageName(name: string): boolean {
  if (name.length < 3 || name.length > 64) {
    return false;
  }
  const pattern = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
  return pattern.test(name) && !name.includes("--");
}

/**
 * Read storage config from .vm0/storage.yaml
 * Also supports legacy .vm0/volume.yaml for backward compatibility
 */
export async function readStorageConfig(
  basePath: string = process.cwd(),
): Promise<StorageConfig | null> {
  const configPath = path.join(basePath, CONFIG_DIR, CONFIG_FILE);
  const legacyConfigPath = path.join(basePath, CONFIG_DIR, "volume.yaml");

  // Check for new config file first, then legacy
  let actualPath: string | null = null;
  if (existsSync(configPath)) {
    actualPath = configPath;
  } else if (existsSync(legacyConfigPath)) {
    actualPath = legacyConfigPath;
  }

  if (!actualPath) {
    return null;
  }

  const content = await readFile(actualPath, "utf8");
  const config = parseYaml(content) as StorageConfig;

  // Default to "volume" type for backward compatibility
  if (!config.type) {
    config.type = "volume";
  }

  return config;
}

/**
 * Write storage config to .vm0/storage.yaml
 */
export async function writeStorageConfig(
  storageName: string,
  basePath: string = process.cwd(),
  type: StorageType = "volume",
): Promise<void> {
  const configDir = path.join(basePath, CONFIG_DIR);
  const configPath = path.join(configDir, CONFIG_FILE);

  // Create .vm0 directory if it doesn't exist
  if (!existsSync(configDir)) {
    await mkdir(configDir, { recursive: true });
  }

  const config: StorageConfig = {
    name: storageName,
    type,
  };

  const yamlContent = stringifyYaml(config);
  await writeFile(configPath, yamlContent, "utf8");
}
