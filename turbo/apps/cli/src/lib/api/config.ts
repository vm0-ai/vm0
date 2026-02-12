import { homedir } from "os";
import { join } from "path";
import { readFile, writeFile, mkdir, unlink } from "fs/promises";
import { existsSync } from "fs";

interface CliConfig {
  token?: string;
  apiUrl?: string;
  orgToken?: string;
  orgTokenExpiresAt?: string;
  activeScope?: string;
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

/**
 * Attempt to refresh an expired org access token by re-calling /api/scope/use.
 * Uses raw fetch to avoid circular dependency with the API client layer.
 * Returns the new org token on success, or null on failure.
 */
async function refreshOrgToken(
  userToken: string,
  activeScope: string,
): Promise<string | null> {
  try {
    const apiUrl = await getApiUrl();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${userToken}`,
      "Content-Type": "application/json",
    };
    const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    if (bypassSecret) {
      headers["x-vercel-protection-bypass"] = bypassSecret;
    }

    const response = await fetch(`${apiUrl}/api/scope/use`, {
      method: "POST",
      headers,
      body: JSON.stringify({ slug: activeScope }),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as {
      token?: string;
      expiresAt?: string;
      scope?: { slug?: string };
    };
    if (data.token && data.expiresAt && data.scope?.slug) {
      await setOrgToken(data.token, data.expiresAt, data.scope.slug);
      return data.token;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get the active token for API requests.
 * Priority: VM0_TOKEN env var > orgToken (if not expired) > auto-refresh org token > user token
 */
export async function getActiveToken(): Promise<string | undefined> {
  if (process.env.VM0_TOKEN) {
    return process.env.VM0_TOKEN;
  }

  const config = await loadConfig();

  if (config.orgToken && config.orgTokenExpiresAt) {
    const expiresAt = new Date(config.orgTokenExpiresAt);
    if (expiresAt > new Date()) {
      return config.orgToken;
    }

    // Org token expired — try to refresh transparently
    if (config.activeScope && config.token) {
      const refreshed = await refreshOrgToken(config.token, config.activeScope);
      if (refreshed) {
        return refreshed;
      }
    }
  }

  return config.token;
}

/**
 * Save org access token to config
 */
export async function setOrgToken(
  token: string,
  expiresAt: string,
  scope: string,
): Promise<void> {
  await saveConfig({
    orgToken: token,
    orgTokenExpiresAt: expiresAt,
    activeScope: scope,
  });
}

/**
 * Clear org access token from config
 */
export async function clearOrgToken(): Promise<void> {
  const config = await loadConfig();
  delete config.orgToken;
  delete config.orgTokenExpiresAt;
  delete config.activeScope;

  const configDir = getConfigDir();
  const configFile = getConfigFile();
  await mkdir(configDir, { recursive: true });
  await writeFile(configFile, JSON.stringify(config, null, 2), "utf8");
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
