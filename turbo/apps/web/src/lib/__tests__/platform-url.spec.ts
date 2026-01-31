import { describe, expect, test } from "vitest";
import { getPlatformUrl } from "../platform-url";

describe("getPlatformUrl", () => {
  test("transforms localhost:3000 to localhost:3001", () => {
    expect(getPlatformUrl("localhost:3000")).toBe("http://localhost:3001");
  });

  test("transforms 127.0.0.1:3000 to 127.0.0.1:3001", () => {
    expect(getPlatformUrl("127.0.0.1:3000")).toBe("http://127.0.0.1:3001");
  });

  test("transforms localhost without port to localhost:3001", () => {
    expect(getPlatformUrl("localhost")).toBe("http://localhost:3001");
  });

  test("transforms vm0.ai to platform.vm0.ai", () => {
    expect(getPlatformUrl("vm0.ai")).toBe("https://platform.vm0.ai");
  });

  test("transforms www.vm0.ai to platform.vm0.ai", () => {
    expect(getPlatformUrl("www.vm0.ai")).toBe("https://platform.vm0.ai");
  });

  test("transforms vm0.ai:8080 to platform.vm0.ai:8080", () => {
    expect(getPlatformUrl("vm0.ai:8080")).toBe("https://platform.vm0.ai:8080");
  });

  test("transforms staging.vm0.ai to platform.staging.vm0.ai", () => {
    expect(getPlatformUrl("staging.vm0.ai")).toBe(
      "https://platform.staging.vm0.ai",
    );
  });

  test("transforms 127.0.0.1 without port to 127.0.0.1:3001", () => {
    expect(getPlatformUrl("127.0.0.1")).toBe("http://127.0.0.1:3001");
  });
});
