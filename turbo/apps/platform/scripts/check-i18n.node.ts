import { relative } from "node:path";

import {
  runExtractor,
  runStatus,
  type ExtractedKeysMap,
  type I18nextToolkitConfig,
  type Plugin,
} from "i18next-cli";

import platformConfig from "../i18next.config.ts";

async function main(): Promise<void> {
  let extractedKeys: ExtractedKeysMap | undefined;

  const reuseExtractedKeysPlugin: Plugin = {
    name: "platform-reuse-extracted-i18n-keys",
    onEnd(keys) {
      if (extractedKeys === undefined) {
        extractedKeys = new Map(keys);
        return;
      }

      keys.clear();
      for (const [key, value] of extractedKeys) {
        keys.set(key, value);
      }
    },
  };

  const extractorConfig: I18nextToolkitConfig = {
    ...platformConfig,
    extract: { ...platformConfig.extract },
    plugins: [...(platformConfig.plugins ?? []), reuseExtractedKeysPlugin],
  };

  const { anyFileUpdated, hasErrors, results } = await runExtractor(
    extractorConfig,
    { quiet: true },
  );

  if (anyFileUpdated || hasErrors) {
    if (anyFileUpdated) {
      process.stderr.write(
        "❌ Generated translation resources were out of date:\n",
      );
      for (const result of results) {
        if (result.updated) {
          process.stderr.write(`- ${relative(process.cwd(), result.path)}\n`);
        }
      }
    }

    if (hasErrors) {
      process.stderr.write("❌ Source extraction reported errors.\n");
    }

    process.exitCode = 1;
  } else {
    process.stdout.write("✅ No files were updated.\n");

    const statusConfig: I18nextToolkitConfig = {
      ...extractorConfig,
      extract: { ...extractorConfig.extract, input: [] },
      plugins: [reuseExtractedKeysPlugin],
    };

    await runStatus(statusConfig);
  }
}

await main();
