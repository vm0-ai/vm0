import { expect, test } from "vitest";

import { testContext } from "../../__tests__/test-helpers.ts";
import { createSharedThreadRichContentSignals } from "../shared-thread-rich-content.ts";

const context = testContext();

function createRichContent(content: string) {
  return createSharedThreadRichContentSignals(
    [{ messageIndex: 0, role: "assistant", content }],
    false,
    context.signal,
  );
}

test("Retry invalidates only its shared thread rich content", async () => {
  const first = createRichContent("Primary\n=\n\nFirst body");
  const second = createRichContent("Secondary\n--\n\nSecond body");
  const firstTrees = await context.store.get(first.trees$);
  const secondTrees = await context.store.get(second.trees$);

  await expect(context.store.get(first.trees$)).resolves.toBe(firstTrees);
  context.store.set(first.retry$);

  await expect(context.store.get(first.trees$)).resolves.not.toBe(firstTrees);
  await expect(context.store.get(second.trees$)).resolves.toBe(secondTrees);
});
