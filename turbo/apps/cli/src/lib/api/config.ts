import { homedir } from "os";
import { join } from "path";
import { readFile, writeFile, mkdir, unlink } from "fs/promises";
import { existsSync } from "fs";

interface CliConfig {
  token?: string;
  apiUrl?: string;
}

// Use functions for lazy evaluation (enables testing with mocked homedir)
function getConfigDir(): string {
  return join(homedir(), ".vm0");
}

function getConfigFile(): string {
  return join(getConfigDir(), "config.json");
}

export async function loadConfig(): Promise<CliConfig> {
  const configFile = getConfigFile();
  if (!existsSync(configFile)) {
    return {};
  }
  const content = await readFile(configFile, "utf8");
  return JSON.parse(content) as CliConfig;
}

export async function saveConfig(config: CliConfig): Promise<void> {
  const configDir = getConfigDir();
  const configFile = getConfigFile();

  // Ensure config directory exists
  await mkdir(configDir, { recursive: true });

  // Merge with existing config
  const existing = await loadConfig();
  const merged = { ...existing, ...config };

  // Write config file
  await writeFile(configFile, JSON.stringify(merged, null, 2), "utf8");
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
  const configFile = getConfigFile();
  if (existsSync(configFile)) {
    await unlink(configFile);
  }
}
