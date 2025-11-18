import { readFile } from "fs/promises";
import { parse } from "yaml";
import type { VM0Config } from "../types/config";

/**
 * Load and parse VM0 config file
 */
export async function loadConfig(filePath: string): Promise<VM0Config> {
  try {
    const content = await readFile(filePath, "utf-8");
    const config = parse(content);
    return config as VM0Config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Config file not found: ${filePath}`);
    }
    if (error instanceof Error && error.name === "YAMLParseError") {
      throw new Error(`Invalid YAML format:\n${error.message}`);
    }
    throw error;
  }
}
