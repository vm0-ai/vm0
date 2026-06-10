import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import { formatIntegrationRunError$ } from "../integration-run-errors.service";

const store = createStore();

describe("formatIntegrationRunError$", () => {
  it("preserves Claude Code rate limit messages for integration dispatchers", async () => {
    const message =
      "Claude Code rate limit reached. Your 5-hour limit has been reached; resets 12:50pm (Asia/Shanghai).";

    await expect(
      store.set(
        formatIntegrationRunError$,
        {
          orgId: "org_integration_rate_limit",
          userId: "user_integration_rate_limit",
          code: "UNKNOWN",
          message,
        },
        new AbortController().signal,
      ),
    ).resolves.toBe(message);
  });
});
