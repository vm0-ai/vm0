import { config } from "dotenv";
import { resolve } from "path";

// Load environment variables from turbo/apps/web/.env.local
config({ path: resolve(process.cwd(), "apps/web/.env.local") });

import { Template, defaultBuildLogger } from "e2b";
import { template } from "./template";

async function main() {
  await Template.build(template, {
    alias: "vm0-claude-code-dev",
    onBuildLogs: defaultBuildLogger(),
  });
}

main().catch(console.error);
