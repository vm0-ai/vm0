import { describe, expect, it } from "vitest";

import { derivePlatformServiceOrigin } from "../platform-service-origin";

describe("derivePlatformServiceOrigin", () => {
  it.each([
    ["https://app.okou.ai", "https://api.okou.ai"],
    ["https://app.vm0.ai", "https://api.vm0.ai"],
    ["https://pr-42-app.omby.ai", "https://pr-42-api.vm6.ai"],
    ["https://staging-app.omby.ai", "https://staging-api.vm6.ai"],
    [
      "https://pr-42-app-okou-app-preview.vm0.workers.dev",
      "https://pr-42-api.vm6.ai",
    ],
    ["http://localhost:3002", "http://localhost:3002"],
  ])("maps %s to %s", (origin, expected) => {
    expect(derivePlatformServiceOrigin(origin, "api")).toBe(expected);
  });
});
