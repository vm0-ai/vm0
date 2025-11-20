import { chromium } from "playwright";
import { clerk, clerkSetup } from "@clerk/testing/playwright";
import { spawn, ChildProcess } from "child_process";
import * as dotenv from "dotenv";

// Load environment variables
dotenv.config({ path: ".env.local" });

/**
 * Automate CLI authentication flow
 *
 * Prerequisites:
 * - CLI must be installed globally: cd turbo/apps/cli && pnpm link --global
 *
 * Steps:
 * 1. Start CLI auth command
 * 2. Parse device code
 * 3. Use Playwright to auto-login and enter code
 *
 * @param apiHost - API server address, defaults to environment variable API_HOST or localhost:3000
 */
export async function automateCliAuth(apiHost?: string) {
  let cliProcess: ChildProcess | null = null;
  let browser = null;

  try {
    console.log("🚀 Starting CLI authentication flow...");

    // Step 1: Start CLI auth command
    // Use provided apiHost or environment variable API_HOST, defaults to localhost:3000
    const apiUrl = apiHost || process.env.API_HOST || "http://localhost:3000";
    console.log(`📡 Connecting to API: ${apiUrl}`);

    // Always use globally installed vm0 command
    // Both GitHub Actions and local development should install CLI via pnpm link --global first
    cliProcess = spawn("vm0", ["auth", "login"], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        API_HOST: apiUrl,  // Set API_HOST environment variable
        // Pass Vercel bypass secret if available (for CI/preview deployments)
        ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET && {
          VERCEL_AUTOMATION_BYPASS_SECRET: process.env.VERCEL_AUTOMATION_BYPASS_SECRET
        })
      }
    });

    // Step 2: Setup persistent stdout/stderr listeners and capture device code
    let cliOutput = "";
    let authSuccess = false;
    let authResolved = false;
    let authResolve: ((value: boolean) => void) | null = null;

    // Setup persistent listeners that will capture all CLI output
    cliProcess!.stdout?.on("data", (data) => {
      const output = data.toString();
      cliOutput += output;

      // Always log CLI output
      if (output.trim()) {
        console.log(output.trim());
      }

      // Check for authentication success
      if (!authResolved && (
        output.includes("Authentication successful") ||
        output.includes("Successfully authenticated") ||
        output.includes("credentials have been saved")
      )) {
        console.log("🎉 Authentication success detected in CLI output!");
        authSuccess = true;
        authResolved = true;
        if (authResolve) {
          authResolve(true);
        }
      }
    });

    cliProcess!.stderr?.on("data", (data) => {
      console.error("CLI error:", data.toString());
    });

    cliProcess!.on("error", (err) => {
      console.error("CLI process error:", err);
    });

    cliProcess!.on("exit", (code) => {
      if (!authResolved) {
        console.log(`CLI process exited with code: ${code}`);
        authResolved = true;
        if (authResolve) {
          authResolve(code === 0);
        }
      }
    });

    // Wait for device code
    const { deviceCode, authUrl } = await new Promise<{ deviceCode: string; authUrl: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timeout: Unable to get device code"));
      }, 10000);

      // Poll for device code in accumulated output
      const checkInterval = setInterval(() => {
        const codeMatch = cliOutput.match(/enter this code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i);
        const urlMatch = cliOutput.match(/visit:\s*(https?:\/\/[^\s]+\/cli-auth)/i);

        if (codeMatch) {
          clearTimeout(timeout);
          clearInterval(checkInterval);
          resolve({
            deviceCode: codeMatch[1],
            authUrl: urlMatch ? urlMatch[1] : `${apiUrl}/cli-auth`
          });
        }
      }, 100);
    });

    console.log(`✅ Got device code: ${deviceCode}`);

    // Step 3: Launch browser and complete authentication
    browser = await chromium.launch({
      headless: true, // Run in headless mode
    });

    const context = await browser.newContext();
    const page = await context.newPage();

    // Step 4: Setup Clerk authentication
    await clerkSetup();

    // Step 5: Login to Clerk
    // Use configured API URL
    const baseUrl = apiUrl;

    // If Vercel bypass secret is available, set bypass cookie via query parameter
    // This avoids CORS issues that occur when using HTTP headers
    const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    let initialUrl = baseUrl;
    if (bypassSecret) {
      initialUrl = `${baseUrl}?x-vercel-set-bypass-cookie=samesitenone&x-vercel-protection-bypass=${bypassSecret}`;
      console.log("🔓 Setting Vercel bypass cookie via query parameter");
    }

    await page.goto(initialUrl);
    await clerk.signIn({
      page,
      emailAddress: "e2e+clerk_test@vm0.ai",
    });

    console.log("✅ Clerk login successful");
    console.log(`🔗 Visiting auth page: ${baseUrl}/cli-auth`);

    // Step 6: Visit CLI auth page
    await page.goto(`${baseUrl}/cli-auth`);
    await page.waitForLoadState("networkidle");

    // Step 7: Enter device code
    // Device code format: XXXX-XXXX, entered into a single input field
    console.log(`📝 Entering device code: ${deviceCode}`);

    // Find the code input field
    const codeInput = page.locator('input[type="text"]').first();

    // Fill the complete device code (with hyphen)
    await codeInput.fill(deviceCode);

    console.log(`✅ Device code entered: ${deviceCode}`);

    // Debug: Screenshot to see page state
    await page.screenshot({ path: 'debug-before-submit.png' });

    // Find and click Authorize Device button
    const authorizeButton = await page.locator('button:has-text("Authorize Device")');
    const buttonExists = await authorizeButton.count() > 0;

    if (buttonExists) {
      console.log("✅ Found Authorize Device button");

      // Click button
      await authorizeButton.first().click();
      console.log("✅ Clicked Authorize Device button");

      // Wait for page response
      await page.waitForTimeout(2000);

      // Screenshot to see post-click state
      await page.screenshot({ path: 'debug-after-click.png' });
      console.log("📸 Saved post-click screenshot");
    } else {
      console.log("❌ Authorize Device button not found");
      // Try pressing Enter on last input
      if (codeInputs.length > 0) {
        await codeInputs[codeInputs.length - 1].press('Enter');
        console.log("⏳ Trying Enter to submit");
      }
    }

    console.log("⏳ Waiting for auth response...");

    // Step 9: Wait for authentication success
    // Check if already authenticated (captured by persistent listener)
    if (authSuccess) {
      console.log("✅ Authentication already completed!");
    } else {
      // Wait for authentication with promise
      const finalAuthSuccess = await new Promise<boolean>((resolve) => {
        authResolve = resolve;

        // Set timeout
        setTimeout(() => {
          if (!authResolved) {
            console.log("⏱️ Timeout (15s), checking auth status...");
            authResolved = true;
            resolve(false);
          }
        }, 15000);
      });

      if (!finalAuthSuccess) {
        throw new Error("CLI authentication appears to have failed");
      }
    }

    console.log("🎉 CLI authentication flow complete!");

    // Verify auth file was created
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const configPath = path.join(os.homedir(), ".vm0", "config.json");

    if (fs.existsSync(configPath)) {
      console.log("✅ Auth file created:", configPath);
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (config.token) {
        console.log("✅ Auth token saved");
      }
    } else {
      console.log("⚠️  Warning: Auth file not found, may need retry");
    }

  } catch (error) {
    console.error("❌ Authentication failed:", error);
    throw error;
  } finally {
    // Clean up resources
    if (browser) {
      await browser.close();
    }
    if (cliProcess && !cliProcess.killed) {
      cliProcess.kill();
    }
  }
}

// If running this script directly
if (require.main === module) {
  // Can specify API_HOST via command line argument or environment variable
  const apiHost = process.argv[2] || process.env.API_HOST;

  automateCliAuth(apiHost)
    .then(() => {
      console.log("✅ Automated authentication completed successfully");
      process.exit(0);
    })
    .catch((error) => {
      console.error("❌ Automated authentication failed:", error);
      process.exit(1);
    });
}
