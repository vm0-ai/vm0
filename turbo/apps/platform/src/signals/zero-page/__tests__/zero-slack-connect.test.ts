import { describe, it, expect } from "vitest";
import { testContext } from "../../__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { effectiveStatus$, effectiveError$ } from "../slack-connect-signals.ts";

const context = testContext();

async function setup(path: string) {
  await setupPage({
    context,
    path,
    withoutRender: true,
  });
}

describe("slack-connect-page signals", () => {
  describe("effective status from URL params", () => {
    it("should return success when status=connected in URL", async () => {
      await setup("/settings/slack?status=connected");

      expect(context.store.get(effectiveStatus$)).toBe("success");
    });

    it("should return error when error param in URL", async () => {
      await setup("/settings/slack?error=Something+went+wrong");

      expect(context.store.get(effectiveStatus$)).toBe("error");
      expect(context.store.get(effectiveError$)).toBe("Something went wrong");
    });

    it("should return idle when no special URL params", async () => {
      await setup("/settings/slack");

      expect(context.store.get(effectiveStatus$)).toBe("idle");
    });
  });
});
