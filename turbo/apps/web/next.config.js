import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Copy run-agent.sh to build output during build
      config.plugins.push({
        apply: (compiler) => {
          compiler.hooks.afterEmit.tap("CopyRunAgentScript", () => {
            try {
              const sourceScript = join(
                __dirname,
                "../../scripts/e2b/run-agent.sh",
              );
              const destDir = join(__dirname, ".next/server/scripts");
              const destScript = join(destDir, "run-agent.sh");

              // Create directory if it doesn't exist
              if (!existsSync(destDir)) {
                mkdirSync(destDir, { recursive: true });
              }

              // Copy script
              copyFileSync(sourceScript, destScript);
              console.log(
                `[Build] Copied run-agent.sh to ${destScript.replace(__dirname, ".")}`,
              );
            } catch (error) {
              console.error("[Build] Failed to copy run-agent.sh:", error);
              throw error;
            }
          });
        },
      });
    }
    return config;
  },
};

export default nextConfig;
