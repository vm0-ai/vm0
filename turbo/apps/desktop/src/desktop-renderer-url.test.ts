import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  desktopRendererFilePath,
  desktopRendererRoot,
  desktopRendererUrl,
} from "./desktop-renderer-url";

describe("desktop renderer URL", () => {
  it("uses the privileged Desktop renderer protocol", () => {
    expect(desktopRendererUrl()).toBe("vm0-desktop://renderer/index.html");
  });

  it("maps renderer URLs to packaged files", () => {
    const distDir = "/Applications/Zero.app/Contents/Resources/app/dist";
    expect(desktopRendererRoot(distDir)).toBe(path.join(distDir, "renderer"));
    expect(desktopRendererFilePath(desktopRendererUrl(), distDir)).toBe(
      path.join(distDir, "renderer", "index.html"),
    );
    expect(
      desktopRendererFilePath(
        "vm0-desktop://renderer/assets/index.js",
        distDir,
      ),
    ).toBe(path.join(distDir, "renderer", "assets", "index.js"));
  });

  it("rejects other protocol targets and path traversal", () => {
    const distDir = "/Applications/Zero.app/Contents/Resources/app/dist";
    expect(desktopRendererFilePath("https://app.vm0.ai/", distDir)).toBeNull();
    expect(
      desktopRendererFilePath("vm0-desktop://other/index.html", distDir),
    ).toBeNull();
    expect(
      desktopRendererFilePath(
        "vm0-desktop://renderer/%2e%2e%2fmain.js",
        distDir,
      ),
    ).toBeNull();
  });
});
