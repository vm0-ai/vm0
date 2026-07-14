import { describe, expect, it } from "vitest";

import {
  clearAllDetached,
  detach,
  Mechanism,
  onRejection,
  tapError,
} from "../utils";

describe("promise error callbacks", () => {
  it("allows silent optional-value fallback through tapError", async () => {
    await expect(
      tapError(Promise.reject(new Error("failed"))),
    ).resolves.toBeUndefined();
  });

  it("awaits asynchronous tapError callbacks before resolving", async () => {
    const events: string[] = [];

    const value = await tapError(
      Promise.reject(new Error("failed")),
      async () => {
        await Promise.resolve();
        events.push("handled");
      },
    );

    expect(value).toBeUndefined();
    expect(events).toStrictEqual(["handled"]);
  });

  it("awaits asynchronous onRejection callbacks before rethrowing", async () => {
    const error = new Error("failed");
    const events: string[] = [];

    await expect(
      onRejection(Promise.reject(error), async () => {
        await Promise.resolve();
        events.push("handled");
      }),
    ).rejects.toBe(error);
    expect(events).toStrictEqual(["handled"]);
  });
});

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
