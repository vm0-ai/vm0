/**
 * Type-safe environment variables for the app.
 *
 * All environment variables are optional in development mode.
 * In production, VITE_API_URL is required.
 */

declare global {
  interface Window {
    __vitest_index__?: boolean;
  }
}

/**
 * Detect if running in Vitest environment.
 * Used for test-specific behavior like promise tracking.
 */
export const IN_VITEST =
  typeof window !== "undefined" && Boolean(window.__vitest_index__);

/**
 * Parse DEBUG environment variable for logger filtering.
 * Only available in Node.js environment (tests).
 */
const IN_NODE = typeof process !== "undefined" && process.versions?.node;

export const DEBUG: readonly string[] = IN_NODE
  ? (process.env.DEBUG?.split(",") ?? [])
  : [];

interface EnvConfig {
  /** Clerk publishable key for authentication */
  VITE_CLERK_PUBLISHABLE_KEY: string | undefined;
  /** Backend API URL */
  VITE_API_URL: string | undefined;
  /** Current mode */
  MODE: "development" | "production" | "test";
  /** Whether we're in development mode */
  DEV: boolean;
  /** Whether we're in production mode */
  PROD: boolean;
}

function getEnv(): EnvConfig {
  return {
    VITE_CLERK_PUBLISHABLE_KEY: import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
    VITE_API_URL: import.meta.env.VITE_API_URL,
    MODE: import.meta.env.MODE as EnvConfig["MODE"],
    DEV: import.meta.env.DEV,
    PROD: import.meta.env.PROD,
  };
}

/**
 * Validate that required environment variables are set.
 * Throws an error in production if required vars are missing.
 */
function validateEnv(config: EnvConfig): void {
  if (config.PROD) {
    if (!config.VITE_API_URL) {
      throw new Error("VITE_API_URL is required in production mode");
    }
  }
}

const envConfig = getEnv();
validateEnv(envConfig);

export const env = envConfig;
