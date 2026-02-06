import { sentryVitePlugin } from "@sentry/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { Schema, ValidateEnv } from "@julr/vite-plugin-validate-env";

export default defineConfig({
  envPrefix: ["VITE_"],
  plugins: [
    // Validate environment variables at build time
    // This plugin only runs during actual builds, not when tools like knip load the config
    ValidateEnv({
      validator: "builtin",
      schema: {
        VITE_CLERK_PUBLISHABLE_KEY: Schema.string(),
        VITE_API_URL: Schema.string(),
      },
    }),
    tailwindcss(),
    react(),
    // Sentry source map upload (production builds only)
    process.env.SENTRY_AUTH_TOKEN &&
      sentryVitePlugin({
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        authToken: process.env.SENTRY_AUTH_TOKEN,
        telemetry: false,
        sourcemaps: {
          // Delete source maps after upload to avoid exposing them
          filesToDeleteAfterUpload: ["./dist/**/*.map"],
        },
      }),
  ].filter(Boolean),
  server: {
    port: 3002,
    strictPort: true,
    host: true,
    allowedHosts: ["platform.vm7.ai"],
  },
  build: {
    outDir: "dist",
    // Generate source maps for Sentry (uploaded and removed by plugin)
    sourcemap: !!process.env.SENTRY_AUTH_TOKEN,
  },
});
