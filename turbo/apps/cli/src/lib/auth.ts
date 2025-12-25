import chalk from "chalk";
import {
  saveConfig,
  clearConfig,
  loadConfig,
  getApiUrl,
  getToken,
} from "./config";

/**
 * Build headers with optional Vercel bypass secret
 * Used to bypass Vercel deployment protection in CI/preview environments
 */
function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // Add Vercel bypass secret if available (for CI/preview deployments)
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypassSecret) {
    headers["x-vercel-protection-bypass"] = bypassSecret;
  }

  return headers;
}

async function requestDeviceCode(apiUrl: string): Promise<{
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}> {
  const response = await fetch(`${apiUrl}/api/cli/auth/device`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    throw new Error(`Failed to request device code: ${response.statusText}`);
  }

  return response.json() as Promise<{
    device_code: string;
    user_code: string;
    verification_url: string;
    expires_in: number;
    interval: number;
  }>;
}

async function exchangeToken(
  apiUrl: string,
  deviceCode: string,
): Promise<{
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}> {
  const response = await fetch(`${apiUrl}/api/cli/auth/token`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({ device_code: deviceCode }),
  });

  return response.json() as Promise<{
    access_token?: string;
    refresh_token?: string;
    token_type?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  }>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function authenticate(apiUrl?: string): Promise<void> {
  // Use provided apiUrl or get from config/env (with fallback to production)
  const targetApiUrl = apiUrl ?? (await getApiUrl());
  console.log("Initiating authentication...");

  // Request device code
  const deviceAuth = await requestDeviceCode(targetApiUrl);

  console.log(chalk.green("\nDevice code generated"));

  // Construct verification URL from API URL
  const verificationUrl = `${targetApiUrl}/cli-auth`;
  console.log(chalk.cyan(`\nTo authenticate, visit: ${verificationUrl}`));
  console.log(`And enter this code: ${chalk.bold(deviceAuth.user_code)}`);
  console.log(
    `\nThe code expires in ${Math.floor(deviceAuth.expires_in / 60)} minutes.`,
  );

  console.log("\nWaiting for authentication...");

  // Poll for token
  const startTime = Date.now();
  const maxWaitTime = deviceAuth.expires_in * 1000; // Convert to milliseconds
  const pollInterval = (deviceAuth.interval || 5) * 1000; // Use server-specified interval or default to 5 seconds

  let isFirstPoll = true;

  while (Date.now() - startTime < maxWaitTime) {
    // Skip delay on first poll for faster response
    if (!isFirstPoll) {
      await delay(pollInterval); // Use dynamic polling interval
    }
    isFirstPoll = false;

    const tokenResult = await exchangeToken(
      targetApiUrl,
      deviceAuth.device_code,
    );

    if (tokenResult.access_token) {
      // Success! Store the token
      await saveConfig({
        token: tokenResult.access_token,
        apiUrl: targetApiUrl,
      });

      console.log(chalk.green("\nAuthentication successful!"));
      console.log("Your credentials have been saved.");
      return;
    }

    if (tokenResult.error === "authorization_pending") {
      // Still waiting for user to authenticate
      process.stdout.write(chalk.dim("."));
      continue;
    }

    // Handle other errors
    if (tokenResult.error === "expired_token") {
      console.log(
        chalk.red("\nThe device code has expired. Please try again."),
      );
      process.exit(1);
    }

    if (tokenResult.error) {
      console.log(
        chalk.red(
          `\nAuthentication failed: ${tokenResult.error_description ?? tokenResult.error}`,
        ),
      );
      process.exit(1);
    }
  }

  // Timeout
  console.log(chalk.red("\nAuthentication timed out. Please try again."));
  process.exit(1);
}

export async function logout(): Promise<void> {
  await clearConfig();
  console.log(chalk.green("Successfully logged out"));
  console.log("Your credentials have been cleared.");
}

export async function checkAuthStatus(): Promise<void> {
  const config = await loadConfig();

  if (config.token) {
    console.log(chalk.green("Authenticated"));
    console.log("You are logged in to VM0.");
  } else {
    console.log(chalk.yellow("Not authenticated"));
    console.log("Run 'vm0 auth login' to authenticate.");
  }

  // Also check for environment variable
  if (process.env.VM0_TOKEN) {
    console.log("Using token from VM0_TOKEN environment variable");
  }
}

export async function setupToken(): Promise<void> {
  const token = await getToken();

  if (!token) {
    console.error(chalk.red("Error: Not authenticated."));
    console.error("");
    console.error("To get a token for CI/CD:");
    console.error("  1. Run 'vm0 auth login' to authenticate");
    console.error("  2. Run 'vm0 auth setup-token' to get your token");
    console.error(
      "  3. Store the token in your CI/CD secrets (e.g., VM0_TOKEN)",
    );
    process.exit(1);
  }

  console.log(chalk.green("✓ Authentication token exported successfully!"));
  console.log("");
  console.log("Your token:");
  console.log("");
  console.log(token);
  console.log("");
  console.log(
    `Use this token by setting: ${chalk.cyan("export VM0_TOKEN=<token>")}`,
  );
}
