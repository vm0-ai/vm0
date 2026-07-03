import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const TEST_SHA = "0123456789abcdef0123456789abcdef01234567";

describe("global method", () => {
  it("exposes the app build commit SHA after bootstrap", async () => {
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(window._vm0?.getBuildCommitSha()).toBe(TEST_SHA);
    });
  });
});
