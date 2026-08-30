import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { URL } from "node:url";

import emojiGroups from "unicode-emoji-json/data-by-group.json" with { type: "json" };

async function main() {
  const outputUrl = new URL(
    "../src/data/chat-thread-emoji.json",
    import.meta.url,
  );
  const generatedGroups = emojiGroups.map((group) => {
    return {
      name: group.name,
      emojis: group.emojis.map((entry) => {
        return { emoji: entry.emoji, name: entry.name };
      }),
    };
  });
  const generatedJson = `${JSON.stringify(generatedGroups, null, 2)}\n`;

  if (process.argv.includes("--check")) {
    const committedJson = await readFile(outputUrl, "utf8");
    assert.equal(
      committedJson,
      generatedJson,
      "chat-thread-emoji.json is stale; run pnpm generate:emoji-data",
    );
  } else {
    await mkdir(new URL("../src/data/", import.meta.url), { recursive: true });
    await writeFile(outputUrl, generatedJson);
  }
}

await main();
