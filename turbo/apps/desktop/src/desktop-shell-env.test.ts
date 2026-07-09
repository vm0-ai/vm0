import { describe, expect, it } from "vitest";
import { resolveLoginShellPath } from "./desktop-shell-env";

describe("resolveLoginShellPath", () => {
  it("resolves PATH from a real login shell", async () => {
    const path = await resolveLoginShellPath({ shell: "/bin/bash" });
    expect(path).toBeTruthy();
    expect(path).toContain("/");
  }, 15_000);

  it("returns null when the shell does not exist", async () => {
    const path = await resolveLoginShellPath({
      shell: "/nonexistent/shell-binary",
    });
    expect(path).toBeNull();
  });

  it("returns null on timeout", async () => {
    // /bin/sleep ignores the -i -l -c arguments and simply never produces
    // the marked JSON payload, so the timeout path settles the promise.
    const path = await resolveLoginShellPath({
      shell: "/bin/sleep",
      timeoutMs: 500,
    });
    expect(path).toBeNull();
  });
});
