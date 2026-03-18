#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const CERTS_DIR = path.join(__dirname, "../../../../.certs");

const requiredCerts = [
  "vm7.ai.pem",
  "vm7.ai-key.pem",
  "www.vm7.ai.pem",
  "www.vm7.ai-key.pem",
  "docs.vm7.ai.pem",
  "docs.vm7.ai-key.pem",
  "app.vm7.ai.pem",
  "app.vm7.ai-key.pem",
];

console.log("🔍 Checking SSL certificates...\n");

let allExists = true;
let missingCerts = [];

for (const cert of requiredCerts) {
  const certPath = path.join(CERTS_DIR, cert);
  const exists = fs.existsSync(certPath);

  if (exists) {
    console.log(`✓ ${cert}`);
  } else {
    console.log(`✗ ${cert} - MISSING`);
    allExists = false;
    missingCerts.push(cert);
  }
}

console.log();

if (!allExists) {
  console.error("❌ Some certificates are missing!");
  console.error("\nMissing certificates:");
  missingCerts.forEach((cert) => console.error(`  - ${cert}`));
  console.error("\nPlease generate certificates by running:");
  console.error("  npm run generate-certs");
  process.exit(1);
}

console.log("✅ All certificates are present!");
process.exit(0);
