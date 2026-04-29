#!/usr/bin/env node

const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const CADDYFILE = path.join(__dirname, "../Caddyfile");

console.log("🚀 Starting Caddy reverse proxy...\n");

// Ensure CF_DNS_AND_TUNNEL_API_TOKEN is available (needed for Let's Encrypt DNS-01 challenge)
if (!process.env.CF_DNS_AND_TUNNEL_API_TOKEN) {
  // Try loading from scripts/.env.local
  const envLocalPath = path.join(__dirname, "../../../../scripts/.env.local");
  if (fs.existsSync(envLocalPath)) {
    const content = fs.readFileSync(envLocalPath, "utf-8");
    const match = content.match(/^CF_DNS_AND_TUNNEL_API_TOKEN=(.+)$/m);
    if (match) {
      process.env.CF_DNS_AND_TUNNEL_API_TOKEN = match[1].trim();
      console.log(
        "✓ Loaded CF_DNS_AND_TUNNEL_API_TOKEN from scripts/.env.local\n",
      );
    }
  }
}

if (!process.env.CF_DNS_AND_TUNNEL_API_TOKEN) {
  console.error("❌ CF_DNS_AND_TUNNEL_API_TOKEN is not set.");
  console.error(
    "\nThis token is required for automatic Let's Encrypt certificate provisioning.",
  );
  console.error("Run 'scripts/sync-env.sh' to sync it from 1Password.\n");
  process.exit(1);
}

// Stop any existing Caddy instance
try {
  console.log("Stopping any existing Caddy instances...");
  execFileSync("pkill", ["-9", "caddy"], { stdio: "pipe" });
} catch (error) {
  // Ignore errors if no Caddy is running
}

console.log("\n🌐 Starting Caddy with automatic HTTPS (Let's Encrypt)...");
console.log(`   Using Caddyfile: ${CADDYFILE}\n`);

// Start Caddy
const caddy = spawn("caddy", ["run", "--config", CADDYFILE], {
  stdio: "inherit",
  cwd: path.join(__dirname, ".."),
  env: process.env,
});

caddy.on("error", (error) => {
  console.error("❌ Failed to start Caddy:", error.message);
  console.error("\nMake sure Caddy is installed:");
  console.error("  Devcontainer: Already included");
  console.error("  macOS: brew install caddy");
  console.error("  Linux: https://caddyserver.com/docs/install");
  process.exit(1);
});

caddy.on("exit", (code) => {
  if (code !== 0) {
    console.error(`\n❌ Caddy exited with code ${code}`);
    process.exit(code);
  }
});

// Print available URLs after a short delay
setTimeout(() => {
  console.log("\n✅ Caddy is running!");
  console.log("\n📱 Available at:");
  console.log("   Web:       https://www.vm7.ai:8443");
  console.log("   App:       https://app.vm7.ai:8443");
  console.log("   API:       https://api.vm7.ai:8443");
  console.log("\n💡 Make sure your applications are running:");
  console.log("   Web:       pnpm --filter web dev (port 3000)");
  console.log("   App:       pnpm --filter @vm0/app dev (port 3002)");
  console.log("   API:       pnpm --filter api dev (port 3001)");
  console.log(
    "\n🔐 Certificates are provisioned automatically via Let's Encrypt.",
  );
  console.log("   First start may take ~30s for certificate issuance.\n");
  console.log("🛑 Press Ctrl+C to stop Caddy\n");
}, 1000);

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.log("\n\n🛑 Stopping Caddy...");
  caddy.kill("SIGTERM");
  process.exit(0);
});

process.on("SIGTERM", () => {
  caddy.kill("SIGTERM");
  process.exit(0);
});
