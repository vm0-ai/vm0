import { homedir } from "os";
import { join } from "path";
import { readFile, writeFile, mkdir, unlink } from "fs/promises";
import { existsSync } from "fs";

interface CliConfig {
  token?: string;
  apiUrl?: string;
}

const CONFIG_DIR = join(homedir(), ".vm0");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export async function loadConfig(): Promise<CliConfig> {
  if (!existsSync(CONFIG_FILE)) {
    return {};
  }
  const content = await readFile(CONFIG_FILE, "utf8");
  return JSON.parse(content) as CliConfig;
}

export async function saveConfig(config: CliConfig): Promise<void> {
  // Ensure config directory exists
  await mkdir(CONFIG_DIR, { recursive: true });

  // Merge with existing config
  const existing = await loadConfig();
  const merged = { ...existing, ...config };

  // Write config file
  await writeFile(CONFIG_FILE, JSON.stringify(merged, null, 2), "utf8");
}

export async function getToken(): Promise<string | undefined> {
  // Check environment variable first
  if (process.env.VM0_TOKEN) {
    return process.env.VM0_TOKEN;
  }

  const config = await loadConfig();
  return config.token;
}

export async function getApiUrl(): Promise<string> {
  const config = await loadConfig();
  const apiUrl = process.env.VM0_API_URL;
  if (apiUrl) {
    // Add protocol if missing
    return apiUrl.startsWith("http") ? apiUrl : `https://${apiUrl}`;
  }
  // Fallback to production API if no config or env var
  return config.apiUrl ?? "https://www.vm0.ai";
}

export async function clearConfig(): Promise<void> {
  if (existsSync(CONFIG_FILE)) {
    await unlink(CONFIG_FILE);
  }
}
