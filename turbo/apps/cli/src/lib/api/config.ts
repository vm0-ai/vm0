import { homedir } from "os";
import { join } from "path";
import { readFile, writeFile, mkdir, unlink } from "fs/promises";
import { existsSync } from "fs";

interface CliConfig {
  token?: string;
  apiUrl?: string;
  activeOrg?: string;
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

interface ZeroTokenPayload {
  userId: string;
  runId: string;
  orgId: string;
  scope: string;
  capabilities: string[];
  iat: number;
  exp: number;
}

/**
 * Decode the ZERO_TOKEN JWT payload.
 * Only decodes — does NOT verify signature (server does that).
 * Returns undefined if token is missing, malformed, or not a zero-scoped token.
 */
export function decodeZeroTokenPayload(): ZeroTokenPayload | undefined {
  const token = process.env.ZERO_TOKEN;
  if (!token) return undefined;

  const prefix = "vm0_sandbox_";
  if (!token.startsWith(prefix)) return undefined;
  const jwt = token.slice(prefix.length);

  const parts = jwt.split(".");
  if (parts.length !== 3) return undefined;

  try {
    const payload = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString(),
    ) as ZeroTokenPayload;
    if (payload.scope === "zero") return payload;
  } catch {
    // Malformed token — fall through
  }
  return undefined;
}

/**
 * Get the active organization for API requests.
 * Priority: ZERO_TOKEN JWT orgId > VM0_ACTIVE_ORG env var > activeOrg from config file
 */
export async function getActiveOrg(): Promise<string | undefined> {
  // Prefer orgId decoded from ZERO_TOKEN JWT (zero agent runs)
  const zeroPayload = decodeZeroTokenPayload();
  if (zeroPayload) return zeroPayload.orgId;

  // Fall back to VM0_ACTIVE_ORG env var (legacy)
  if (process.env.VM0_ACTIVE_ORG) {
    return process.env.VM0_ACTIVE_ORG;
  }

  // Fall back to config file
  const config = await loadConfig();
  return config.activeOrg;
}

export async function clearConfig(): Promise<void> {
  const configFile = getConfigFile();
  if (existsSync(configFile)) {
    await unlink(configFile);
  }
}
