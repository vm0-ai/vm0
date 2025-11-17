#!/usr/bin/env node

const { execSync, spawn } = require("child_process");
const path = require("path");

const CADDYFILE = path.join(__dirname, "../Caddyfile");

console.log("🚀 Starting Caddy reverse proxy...\n");

// Check if certificates exist
try {
  execSync("node " + path.join(__dirname, "check-certs.js"), {
    stdio: "inherit",
  });
} catch (error) {
  console.error("\n❌ Cannot start Caddy without certificates.");
  process.exit(1);
}

// Stop any existing Caddy instance
try {
  console.log("Stopping any existing Caddy instances...");
  execSync("pkill -9 caddy 2>/dev/null || true", { stdio: "pipe" });
} catch (error) {
  // Ignore errors if no Caddy is running
}

console.log("\n🌐 Starting Caddy with HTTPS support...");
console.log(`   Using Caddyfile: ${CADDYFILE}\n`);

// Start Caddy
const caddy = spawn("caddy", ["run", "--config", CADDYFILE], {
  stdio: "inherit",
  cwd: path.join(__dirname, ".."),
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
  console.log("   Web:  https://www.vm7.ai:8443");
  console.log("   Docs: https://docs.vm7.ai:8443");
  console.log("\n💡 Make sure your applications are running:");
  console.log("   Web:  pnpm --filter web dev (port 3000)");
  console.log("   Docs: pnpm --filter docs dev (port 3001)");
  console.log("\n🛑 Press Ctrl+C to stop Caddy\n");
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
