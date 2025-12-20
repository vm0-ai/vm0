/**
 * Configure Vercel Build Output based on VM0_EDITION
 *
 * For Community Edition: removes crons (Vercel Hobby Plan compatibility)
 * For Cloud Edition: keeps crons for automatic sandbox cleanup
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "../.vercel/output/config.json");

const edition = process.env.VM0_EDITION;

// Only modify for community edition
if (edition !== "community") {
  console.log(
    `[configure-vercel-output] Edition: ${edition || "cloud (default)"} - keeping crons`
  );
  process.exit(0);
}

// Check if config file exists
if (!fs.existsSync(CONFIG_PATH)) {
  console.log(
    "[configure-vercel-output] No .vercel/output/config.json found, skipping"
  );
  process.exit(0);
}

// Read, modify, and write the config
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
if (config.crons) {
  delete config.crons;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log(
    "[configure-vercel-output] Community Edition: removed crons from build output"
  );
} else {
  console.log("[configure-vercel-output] Community Edition: no crons to remove");
}
