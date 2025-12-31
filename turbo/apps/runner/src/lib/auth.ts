import { saveToken, getApiUrl, getToken } from "./token.js";

/**
 * Build headers with optional Vercel bypass secret
 */
function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypassSecret) {
    headers["x-vercel-protection-bypass"] = bypassSecret;
  }
  return headers;
}

interface DeviceAuthResponse {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function requestDeviceCode(apiUrl: string): Promise<DeviceAuthResponse> {
  const response = await fetch(`${apiUrl}/api/cli/auth/device`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    throw new Error(`Failed to request device code: ${response.statusText}`);
  }

  return response.json() as Promise<DeviceAuthResponse>;
}

async function exchangeToken(
  apiUrl: string,
  deviceCode: string,
): Promise<TokenResponse> {
  const response = await fetch(`${apiUrl}/api/cli/auth/token`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({ device_code: deviceCode }),
  });

  return response.json() as Promise<TokenResponse>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Authenticate runner using device flow
 * Reuses the same device flow as CLI
 */
export async function authenticate(apiUrl?: string): Promise<void> {
  const targetApiUrl = apiUrl ?? (await getApiUrl());
  console.log("Initiating authentication...");

  const deviceAuth = await requestDeviceCode(targetApiUrl);

  console.log("\nDevice code generated");

  const verificationUrl = `${targetApiUrl}/cli-auth`;
  console.log(`\nTo authenticate, visit: ${verificationUrl}`);
  console.log(`And enter this code: ${deviceAuth.user_code}`);
  console.log(
    `\nThe code expires in ${Math.floor(deviceAuth.expires_in / 60)} minutes.`,
  );

  console.log("\nWaiting for authentication...");

  const startTime = Date.now();
  const maxWaitTime = deviceAuth.expires_in * 1000;
  const pollInterval = (deviceAuth.interval || 5) * 1000;

  let isFirstPoll = true;

  while (Date.now() - startTime < maxWaitTime) {
    if (!isFirstPoll) {
      await delay(pollInterval);
    }
    isFirstPoll = false;

    const tokenResult = await exchangeToken(
      targetApiUrl,
      deviceAuth.device_code,
    );

    if (tokenResult.access_token) {
      await saveToken({
        token: tokenResult.access_token,
        apiUrl: targetApiUrl,
      });

      console.log("\nAuthentication successful!");
      console.log("Runner credentials have been saved.");
      return;
    }

    if (tokenResult.error === "authorization_pending") {
      process.stdout.write(".");
      continue;
    }

    if (tokenResult.error === "expired_token") {
      console.log("\nThe device code has expired. Please try again.");
      process.exit(1);
    }

    if (tokenResult.error) {
      console.log(
        `\nAuthentication failed: ${tokenResult.error_description ?? tokenResult.error}`,
      );
      process.exit(1);
    }
  }

  console.log("\nAuthentication timed out. Please try again.");
  process.exit(1);
}

/**
 * Test connection to API with current token
 */
export async function testConnection(): Promise<boolean> {
  const token = await getToken();
  const apiUrl = await getApiUrl();

  if (!token) {
    console.log("No token found. Please run setup first.");
    return false;
  }

  try {
    const response = await fetch(`${apiUrl}/api/auth/me`, {
      method: "GET",
      headers: {
        ...buildHeaders(),
        Authorization: `Bearer ${token}`,
      },
    });

    if (response.ok) {
      console.log("Connection test successful!");
      return true;
    }

    console.log(`Connection test failed: ${response.status}`);
    return false;
  } catch (error) {
    console.log(`Connection test failed: ${error}`);
    return false;
  }
}
