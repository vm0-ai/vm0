import { describe, expect, it } from "vitest";

import { clearAllDetached, detach, Mechanism } from "../utils";

describe("clearAllDetached", () => {
  it("drains detached promises scheduled by detached work", async () => {
    const completed: string[] = [];

    detach(
      (async () => {
        await Promise.resolve();
        completed.push("outer");
        detach(
          (async () => {
            await Promise.resolve();
            completed.push("inner");
          })(),
          Mechanism.WaitUntil,
        );
      })(),
      Mechanism.WaitUntil,
    );

    await clearAllDetached();

    expect(completed).toStrictEqual(["outer", "inner"]);
  });
});
