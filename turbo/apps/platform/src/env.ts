/**
 * Type-safe environment variables for the app.
 *
 * Environment variables are optional until they are actually used.
 * Add validation only when a variable is required by the application.
 */

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

export const env = getEnv();
