import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import path from "path";

interface VolumeConfig {
  name: string;
}

const CONFIG_DIR = ".vm0";
const CONFIG_FILE = "volume.yaml";

/**
 * Validate volume name format
 * Length: 3-64 characters
 * Characters: lowercase letters, numbers, hyphens
 * Must start and end with alphanumeric
 * No consecutive hyphens
 */
export function isValidVolumeName(name: string): boolean {
  if (name.length < 3 || name.length > 64) {
    return false;
  }
  const pattern = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
  return pattern.test(name) && !name.includes("--");
}

/**
 * Generate suggested volume name from directory name
 */
export function suggestVolumeName(dirName: string): string {
  // Convert to lowercase
  let suggested = dirName.toLowerCase();

  // Replace invalid characters with hyphens
  suggested = suggested.replace(/[^a-z0-9-]/g, "-");

  // Remove consecutive hyphens
  suggested = suggested.replace(/--+/g, "-");

  // Remove leading/trailing hyphens
  suggested = suggested.replace(/^-+|-+$/g, "");

  // Ensure it starts and ends with alphanumeric
  if (suggested.length > 0 && suggested.match(/^[a-z0-9]/)) {
    if (!suggested.match(/[a-z0-9]$/)) {
      suggested = suggested.replace(/-+$/, "");
    }
  }

  // Truncate to max length
  if (suggested.length > 64) {
    suggested = suggested.substring(0, 64);
    // Ensure it ends with alphanumeric after truncation
    suggested = suggested.replace(/-+$/, "");
  }

  // Ensure minimum length
  if (suggested.length < 3) {
    return "volume";
  }

  return suggested;
}

/**
 * Read volume config from .vm0/volume.yaml
 */
export async function readVolumeConfig(
  basePath: string = process.cwd(),
): Promise<VolumeConfig | null> {
  const configPath = path.join(basePath, CONFIG_DIR, CONFIG_FILE);

  if (!existsSync(configPath)) {
    return null;
  }

  const content = await readFile(configPath, "utf8");
  const config = parseYaml(content) as VolumeConfig;

  return config;
}

/**
 * Write volume config to .vm0/volume.yaml
 */
export async function writeVolumeConfig(
  volumeName: string,
  basePath: string = process.cwd(),
): Promise<void> {
  const configDir = path.join(basePath, CONFIG_DIR);
  const configPath = path.join(configDir, CONFIG_FILE);

  // Create .vm0 directory if it doesn't exist
  if (!existsSync(configDir)) {
    await mkdir(configDir, { recursive: true });
  }

  const config: VolumeConfig = {
    name: volumeName,
  };

  const yamlContent = stringifyYaml(config);
  await writeFile(configPath, yamlContent, "utf8");
}
