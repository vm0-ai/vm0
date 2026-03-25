import { homedir } from "os";
import { join } from "path";
import { readFile, writeFile, mkdir, unlink } from "fs/promises";
import { existsSync } from "fs";
import { decodeCliTokenPayload } from "./cli-token.js";
import { decodeZeroTokenPayload } from "./zero-token.js";

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
  // Check environment variables first (ZERO_TOKEN takes priority)
  if (process.env.ZERO_TOKEN) {
    return process.env.ZERO_TOKEN;
  }
  if (process.env.VM0_TOKEN) {
    return process.env.VM0_TOKEN;
  }

  const config = await loadConfig();
  return config.token;
}

/**
 * Get the active token for API requests.
 * Priority: ZERO_TOKEN env var > VM0_TOKEN env var > user token from config
 */
export async function getActiveToken(): Promise<string | undefined> {
  return getToken();
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

export { decodeZeroTokenPayload };

/**
 * Get the active organization for API requests.
 * Priority: ZERO_TOKEN JWT orgId > CLI JWT orgId
 */
export async function getActiveOrg(): Promise<string | undefined> {
  // Prefer orgId decoded from ZERO_TOKEN JWT (zero agent runs)
  const zeroPayload = decodeZeroTokenPayload();
  if (zeroPayload) return zeroPayload.orgId;

  // Try CLI JWT token (format: vm0_pat_ with scope "cli")
  const token = await getToken();
  const cliPayload = decodeCliTokenPayload(token);
  if (cliPayload) return cliPayload.orgId;

  return undefined;
}

export async function clearConfig(): Promise<void> {
  const configFile = getConfigFile();
  if (existsSync(configFile)) {
    await unlink(configFile);
  }
}
