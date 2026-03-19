import { chromium, type Browser, type Page } from "playwright";
import { spawn, ChildProcess } from "child_process";
import * as dotenv from "dotenv";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";

// Load environment variables
dotenv.config({ path: ".env.local" });

// ---------------------------------------------------------------------------
// Shared: Clerk sign-in flow (used by both CLI auth and CDP browser login)
// ---------------------------------------------------------------------------

/**
 * Sign in to a VM0 app via Clerk email + OTP.
 *
 * Steps:
 * 1. Navigate to /sign-in
 * 2. Enter email → Continue
 * 3. "Use another method" → "Email code"
 * 4. Enter OTP 424242 (Clerk dev mode test code)
 * 5. Wait for redirect away from /sign-in
 *
 * This function is shared between `automateCliAuth` (CI e2e-auth job)
 * and `browserLogin` (local agent-browser CDP login), so its correctness
 * is continuously verified by CI.
 */
export async function clerkLogin(page: Page, baseUrl: string, email: string) {
  const OTP = "424242";

  // Navigate to www main site first, then to sign-in
  console.log(`🌐 Navigating to ${baseUrl}`);
  await page.goto(baseUrl);
  await page.waitForLoadState("domcontentloaded");

  await page.goto(`${baseUrl}/sign-in`);
  await page.waitForLoadState("domcontentloaded");

  // Wait for Clerk to render sign-in form — if page redirects away from
  // /sign-in the user is already authenticated; but if the email input
  // simply hasn't loaded yet we must NOT treat that as "already signed in".
  const emailInput = page.locator('input[name="identifier"]');
  try {
    await emailInput.waitFor({ state: "visible", timeout: 15000 });
  } catch {
    // Input never appeared — check whether we actually left /sign-in
    if (!page.url().includes("/sign-in")) {
      console.log(`✅ Already signed in (redirected to ${page.url()})`);
      return;
    }
    throw new Error(
      `Clerk sign-in form did not render within 15 s (still on ${page.url()})`
    );
  }

  // Enter email address
  await emailInput.fill(email);
  console.log(`📧 Using test email: ${email}`);

  // Click Continue button
  await page.locator('.cl-formButtonPrimary').click();
  console.log("➡️ Clicked Continue");

  // Clerk shows password by default; switch to email code method
  const useAnotherMethod = page.locator('a:has-text("Use another method"), button:has-text("Use another method")');
  await useAnotherMethod.waitFor({ state: "visible", timeout: 10000 });
  await useAnotherMethod.click();
  console.log("🔄 Clicked 'Use another method'");

  // Select email code option
  const emailCodeOption = page.locator('button:has-text("Email code")');
  await emailCodeOption.waitFor({ state: "visible", timeout: 10000 });
  await emailCodeOption.click();
  console.log("📧 Selected 'Email code'");

  // Wait for OTP input to appear and Clerk to finish sending the code
  const otpInput = page.locator('input[data-input-otp="true"]');
  await otpInput.waitFor({ state: "attached", timeout: 10000 });
  // Wait for Clerk to complete the "prepare" step (sending the email)
  await page.waitForTimeout(2000);

  // Enter test OTP code 424242 (Clerk accepts this in development mode)
  await otpInput.focus();
  await page.keyboard.type(OTP);
  console.log("🔢 Entered OTP code");

  // Wait for Clerk to complete authentication (should redirect away from /sign-in)
  await page.waitForURL((url) => !url.pathname.includes('/sign-in'), { timeout: 15000 });
  console.log(`✅ Clerk login successful (redirected to ${page.url()})`);
}

// ---------------------------------------------------------------------------
// Mode 1: CLI device-code authentication (used by CI e2e-auth job)
// ---------------------------------------------------------------------------

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
 * @param apiHost - API server address, defaults to environment variable VM0_API_URL or localhost:3000
 */
export async function automateCliAuth(apiHost?: string) {
  let cliProcess: ChildProcess | null = null;
  let browser: Browser | null = null;

  try {
    console.log("🚀 Starting CLI authentication flow...");

    // Step 1: Start CLI auth command
    // Use provided apiHost or environment variable VM0_API_URL
    const apiUrl = apiHost || process.env.VM0_API_URL;
    if (!apiUrl) {
      throw new Error(
        "API URL must be provided via apiHost parameter or VM0_API_URL environment variable"
      );
    }
    console.log(`📡 Connecting to API: ${apiUrl}`);

    // Always use globally installed vm0 command
    // Both GitHub Actions and local development should install CLI via pnpm link --global first
    cliProcess = spawn("vm0", ["auth", "login"], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        VM0_API_URL: apiUrl,  // Set VM0_API_URL environment variable
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
    const { deviceCode } = await new Promise<{ deviceCode: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timeout: Unable to get device code"));
      }, 10000);

      // Poll for device code in accumulated output
      const checkInterval = setInterval(() => {
        const codeMatch = cliOutput.match(/enter this code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i);

        if (codeMatch) {
          clearTimeout(timeout);
          clearInterval(checkInterval);
          resolve({
            deviceCode: codeMatch[1],
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

    // Step 4: Login via Clerk
    const testEmail = "e2e+clerk_test@vm0.ai";
    await clerkLogin(page, apiUrl, testEmail);
    console.log(`🔗 Visiting auth page: ${apiUrl}/cli-auth`);

    // Step 6: Visit CLI auth page
    await page.goto(`${apiUrl}/cli-auth`);
    await page.waitForLoadState("domcontentloaded");

    // Step 7: Enter device code
    // Device code format: XXXX-XXXX, entered into 8 separate input boxes
    console.log(`📝 Entering device code: ${deviceCode}`);

    // Remove hyphen from device code to get 8 characters
    const codeWithoutHyphen = deviceCode.replace("-", "");

    // Find all code input boxes (8 individual inputs)
    const codeInputs = page.locator('input[type="text"][maxlength="1"]');
    const inputCount = await codeInputs.count();

    if (inputCount === 8) {
      // Fill each input box with corresponding character
      for (let i = 0; i < 8; i++) {
        await codeInputs.nth(i).fill(codeWithoutHyphen[i]);
      }
      console.log(`✅ Device code entered: ${deviceCode}`);
    } else {
      // Fallback: try single input field (old UI)
      console.log(`⚠️ Expected 8 input boxes, found ${inputCount}. Trying single input fallback.`);
      const singleInput = page.locator('input[type="text"]').first();
      await singleInput.fill(deviceCode);
      console.log(`✅ Device code entered (single input): ${deviceCode}`);
    }

    // Debug: Screenshot to see page state
    await page.screenshot({ path: 'debug-before-submit.png' });

    // Find and click Verify button (or fallback to Authorize Device for backwards compatibility)
    let verifyButton = page.locator('button:has-text("Verify")');
    let buttonExists = await verifyButton.count() > 0;

    if (!buttonExists) {
      // Fallback to old button text
      verifyButton = page.locator('button:has-text("Authorize Device")');
      buttonExists = await verifyButton.count() > 0;
    }

    if (buttonExists) {
      console.log("✅ Found submit button");

      // Click button
      await verifyButton.first().click();
      console.log("✅ Clicked submit button");

      // Wait for page response
      await page.waitForTimeout(2000);

      // Screenshot to see post-click state
      await page.screenshot({ path: 'debug-after-click.png' });
      console.log("📸 Saved post-click screenshot");
    } else {
      console.log("❌ Submit button not found");
      // Try pressing Enter on last input
      if (inputCount > 0) {
        await codeInputs.nth(inputCount - 1).press('Enter');
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

// ---------------------------------------------------------------------------
// Mode 2: CDP browser login (for agent-browser / local dev)
// ---------------------------------------------------------------------------

/**
 * Login to a VM0 app via an already-running Chrome instance (CDP).
 *
 * Connects to the Chrome started by scripts/start-vnc.sh and runs the
 * same Clerk sign-in flow used by the CI e2e-auth job.
 *
 * NOTE: Playwright's connectOverCDP may not see Clerk-rendered DOM in
 * headed Chrome (known issue with shared CDP sessions). If login fails,
 * fall back to manual agent-browser commands.
 *
 * Usage:
 *   npx tsx e2e/cli-auth-automation.ts --cdp [base-url] [--port 9222] [--email user@example.com]
 */
export async function browserLogin(opts: {
  baseUrl: string;
  cdpPort: number;
  email: string;
}) {
  const cdpUrl = `http://localhost:${opts.cdpPort}`;
  console.log(`🔗 Connecting to CDP at ${cdpUrl}`);
  const browser = await chromium.connectOverCDP(cdpUrl);

  const contexts = browser.contexts();
  const context = contexts[0] ?? await browser.newContext();
  const page = context.pages()[0] ?? await context.newPage();

  try {
    await clerkLogin(page, opts.baseUrl, opts.email);
  } finally {
    // Disconnect without killing — browser stays open for agent-browser
    await browser.close();
    console.log("🔌 Disconnected from CDP (browser stays open)");
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  const isCdpMode = args.includes("--cdp");

  if (isCdpMode) {
    // --cdp mode: connect to existing Chrome and login
    const filtered = args.filter(a => a !== "--cdp");
    let baseUrl = "https://www.vm7.ai:8443";
    let cdpPort = 9222;
    let email = `${os.hostname()}+clerk_test@vm0.ai`;

    for (let i = 0; i < filtered.length; i++) {
      if (filtered[i] === "--port" && filtered[i + 1]) {
        cdpPort = parseInt(filtered[++i], 10);
      } else if (filtered[i] === "--email" && filtered[i + 1]) {
        email = filtered[++i];
      } else if (!filtered[i].startsWith("--")) {
        baseUrl = filtered[i];
      }
    }

    browserLogin({ baseUrl, cdpPort, email })
      .then(() => {
        console.log("✅ Browser login complete");
        process.exit(0);
      })
      .catch((error) => {
        console.error("❌ Browser login failed:", error);
        process.exit(1);
      });
  } else {
    // Default mode: CLI device-code auth
    const apiHost = args[0] || process.env.VM0_API_URL;

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
}
