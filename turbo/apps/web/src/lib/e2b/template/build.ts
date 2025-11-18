import { Template, defaultBuildLogger } from "e2b";
import { vm0Template } from "./template";

/**
 * Build VM0 E2B Template
 *
 * Usage:
 *   pnpm e2b:build
 *
 * This will build and push the template to E2B.
 * The template ID will be output at the end.
 * Set it in your environment as E2B_TEMPLATE_ID.
 */
async function main() {
  console.log("Building VM0 E2B template...");

  const result = await Template.build(vm0Template, {
    alias: "vm0-claude-code",
    onBuildLogs: defaultBuildLogger(),
  });

  console.log("\n✅ Template built successfully!");
  console.log(
    `\n📦 Template ID: ${result.templateId || "namnmt5bl80j5oon0pr6"}`,
  );
  console.log(`\n💡 Add this to your .env.local:`);
  console.log(`E2B_TEMPLATE_ID=${result.templateId || "namnmt5bl80j5oon0pr6"}`);
}

main().catch((error) => {
  console.error("❌ Failed to build template:", error);
  process.exit(1);
});
