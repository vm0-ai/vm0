import { homedir } from "os";
import { join } from "path";
import { readFile, writeFile, mkdir, unlink } from "fs/promises";
import { existsSync } from "fs";

/**
 * Runner token storage - separate from CLI config
 * Stored at ~/.vm0/runner-token
 */

interface RunnerTokenConfig {
  token?: string;
  apiUrl?: string;
}

const CONFIG_DIR = join(homedir(), ".vm0");
const TOKEN_FILE = join(CONFIG_DIR, "runner-token.json");

export async function loadToken(): Promise<RunnerTokenConfig> {
  if (!existsSync(TOKEN_FILE)) {
    return {};
  }
  const content = await readFile(TOKEN_FILE, "utf8");
  return JSON.parse(content) as RunnerTokenConfig;
}

export async function saveToken(config: RunnerTokenConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  const existing = await loadToken();
  const merged = { ...existing, ...config };
  await writeFile(TOKEN_FILE, JSON.stringify(merged, null, 2), "utf8");
}

export async function getToken(): Promise<string | undefined> {
  // Check environment variable first
  if (process.env.VM0_RUNNER_TOKEN) {
    return process.env.VM0_RUNNER_TOKEN;
  }
  // Fall back to CLI token if runner token not set
  if (process.env.VM0_TOKEN) {
    return process.env.VM0_TOKEN;
  }
  const config = await loadToken();
  return config.token;
}

export async function getApiUrl(): Promise<string> {
  const config = await loadToken();
  const apiUrl = process.env.VM0_API_URL;
  if (apiUrl) {
    return apiUrl.startsWith("http") ? apiUrl : `https://${apiUrl}`;
  }
  return config.apiUrl ?? "https://www.vm0.ai";
}

export async function clearToken(): Promise<void> {
  if (existsSync(TOKEN_FILE)) {
    await unlink(TOKEN_FILE);
  }
}
