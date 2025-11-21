import { Template, defaultBuildLogger } from "e2b";
import { template } from "./template";

// E2B_API_KEY should be set as an environment variable
// In CI: from GitHub secrets
// Locally: from turbo/apps/web/.env.local (loaded by build command)
if (!process.env.E2B_API_KEY) {
  console.error("Error: E2B_API_KEY environment variable is not set");
  console.error(
    "Please set E2B_API_KEY in turbo/apps/web/.env.local or as an environment variable",
  );
  process.exit(1);
}

async function main() {
  await Template.build(template, {
    alias: "vm0-claude-code-dev",
    onBuildLogs: defaultBuildLogger(),
  });
}

main().catch(console.error);
