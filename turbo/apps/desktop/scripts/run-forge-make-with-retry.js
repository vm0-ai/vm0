const { spawnSync } = require("node:child_process");
const path = require("node:path");

const maxAttempts = 3;
const retryDelayMs = 15_000;
const forgeArgs = process.argv.slice(2);
const turboRoot = path.resolve(__dirname, "../../..");

const wait = (delayMs) =>
  new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });

async function main() {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    console.log(
      `Running electron-forge make (attempt ${attempt}/${maxAttempts})`,
    );

    const result = spawnSync(
      "pnpm",
      ["--dir", "apps/desktop", "exec", "electron-forge", "make", ...forgeArgs],
      {
        cwd: turboRoot,
        stdio: "inherit",
      },
    );

    if (result.status === 0) {
      return;
    }

    if (result.error) {
      console.error(result.error.message);
    }

    if (attempt === maxAttempts) {
      process.exit(result.status ?? 1);
    }

    console.log(`electron-forge make failed; retrying in 15 seconds`);
    await wait(retryDelayMs);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
