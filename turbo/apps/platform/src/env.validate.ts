/**
 * Validate required environment variables at build time.
 * This ensures all necessary variables are present before deployment.
 */

const requiredEnvVars = ["VITE_CLERK_PUBLISHABLE_KEY", "VITE_API_URL"] as const;

export function validateEnv() {
  const missing: string[] = [];

  for (const varName of requiredEnvVars) {
    if (!process.env[varName]) {
      missing.push(varName);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables:\n  - ${missing.join("\n  - ")}\n\n` +
        `Please ensure these are set in your .env.local file or CI environment.`,
    );
  }
}
