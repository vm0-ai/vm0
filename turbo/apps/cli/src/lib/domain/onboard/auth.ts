import { getToken, saveConfig, getApiUrl } from "../../api/config.js";

interface AuthFlowCallbacks {
  onInitiating?: () => void;
  onDeviceCodeReady?: (
    url: string,
    code: string,
    expiresInMinutes: number,
  ) => void;
  onPolling?: () => void;
  onSuccess?: () => void;
  onError?: (error: Error) => void;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_path: string;
  expires_in: number;
  interval: number;
}

interface TokenExchangeResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

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

async function requestDeviceCode(apiUrl: string): Promise<DeviceCodeResponse> {
  const response = await fetch(`${apiUrl}/api/cli/auth/device`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    throw new Error(`Failed to request device code: ${response.statusText}`);
  }

  return response.json() as Promise<DeviceCodeResponse>;
}

async function exchangeToken(
  apiUrl: string,
  deviceCode: string,
): Promise<TokenExchangeResponse> {
  const response = await fetch(`${apiUrl}/api/cli/auth/token`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({ device_code: deviceCode }),
  });

  return response.json() as Promise<TokenExchangeResponse>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if user is authenticated (has valid token)
 * @returns true if authenticated, false otherwise
 */
export async function isAuthenticated(): Promise<boolean> {
  const token = await getToken();
  return !!token;
}

/**
 * Handle token exchange result, returning the access token if successful or throwing an error
 */
function handleTokenResult(tokenResult: TokenExchangeResponse): string | null {
  if (tokenResult.access_token) {
    return tokenResult.access_token;
  }

  if (tokenResult.error === "authorization_pending") {
    return null;
  }

  if (tokenResult.error === "expired_token") {
    throw new Error("The device code has expired. Please try again.");
  }

  if (tokenResult.error) {
    throw new Error(
      `Authentication failed: ${tokenResult.error_description ?? tokenResult.error}`,
    );
  }

  return null;
}

/**
 * Poll for token until success or timeout
 */
async function pollForToken(
  apiUrl: string,
  deviceAuth: DeviceCodeResponse,
  callbacks?: AuthFlowCallbacks,
): Promise<string> {
  const startTime = Date.now();
  const maxWaitTime = deviceAuth.expires_in * 1000;
  const pollInterval = (deviceAuth.interval || 5) * 1000;

  let isFirstPoll = true;

  while (Date.now() - startTime < maxWaitTime) {
    if (!isFirstPoll) {
      await delay(pollInterval);
    }
    isFirstPoll = false;

    const tokenResult = await exchangeToken(apiUrl, deviceAuth.device_code);
    const accessToken = handleTokenResult(tokenResult);

    if (accessToken) {
      return accessToken;
    }

    callbacks?.onPolling?.();
  }

  throw new Error("Authentication timed out. Please try again.");
}

/**
 * Run the device code authentication flow
 * @param callbacks - Optional callbacks for UI updates
 * @param apiUrl - Optional API URL override
 */
export async function runAuthFlow(
  callbacks?: AuthFlowCallbacks,
  apiUrl?: string,
): Promise<void> {
  const targetApiUrl = apiUrl ?? (await getApiUrl());

  callbacks?.onInitiating?.();

  try {
    const deviceAuth = await requestDeviceCode(targetApiUrl);

    const verificationUrl = `${targetApiUrl}${deviceAuth.verification_path}`;
    const expiresInMinutes = Math.floor(deviceAuth.expires_in / 60);

    callbacks?.onDeviceCodeReady?.(
      verificationUrl,
      deviceAuth.user_code,
      expiresInMinutes,
    );

    const accessToken = await pollForToken(targetApiUrl, deviceAuth, callbacks);

    await saveConfig({
      token: accessToken,
      apiUrl: targetApiUrl,
    });

    callbacks?.onSuccess?.();
  } catch (error) {
    callbacks?.onError?.(error as Error);
    throw error;
  }
}
