/**
 * Tests for okou presentation screenshot.
 *
 * Mocks only external binaries (agent-browser, apt, dpkg, LibreOffice, and
 * Poppler). The fakes write real files and PNG bytes, so installation, caching,
 * filesystem traversal, page numbering, and size checks run unchanged.
 */
import { execFileSync } from "child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { presentationCommand } from "../index";

const state = {
  /** Boxes the fake browser reports for the slide selector. */
  slides: [] as unknown[],
  installed: new Set(["soffice", "pdftocairo"]),
  deckPages: 3,
  size: { width: 1600, height: 900 },
  backgroundReady: true,
  settleFails: false,
  installFails: false,
};

function okouToken(orgId: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      userId: "user-presentation-screenshot",
      runId: "run-presentation-screenshot",
      orgId,
      scope: "okou",
      capabilities: [],
      iat: 1,
      exp: 4_102_444_800,
    }),
  ).toString("base64url");
  return `vm0_sandbox_header.${payload}.signature`;
}

/** A 2x2 PNG is enough; only the IHDR dimensions are read back. */
function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 13]),
    Buffer.from("IHDR", "ascii"),
    ihdr,
    Buffer.alloc(4),
  ]);
}

function fakeWhich(args: readonly string[]): string {
  if (!state.installed.has(args[0] ?? "")) {
    throw new Error(`which: no ${args[0] ?? ""}`);
  }
  return "";
}

function fakeAptGet(args: readonly string[]): string {
  if (state.installFails) {
    throw new Error("apt-get failed");
  }
  const install = args.indexOf("install");
  if (install < 0) {
    return "";
  }
  const configured = args.find((arg) => {
    return arg.startsWith("Dir::Cache::archives=");
  });
  const archives = configured?.slice("Dir::Cache::archives=".length);
  if (archives === undefined) {
    throw new Error("missing apt archive directory");
  }
  mkdirSync(archives, { recursive: true });
  for (const packageName of args.slice(install + 1)) {
    writeFileSync(join(archives, `${packageName}.deb`), "fake");
  }
  return "";
}

function fakeLibreOfficePackage(root: string): void {
  const program = join(root, "usr", "lib", "libreoffice", "program");
  mkdirSync(join(root, "usr", "bin"), { recursive: true });
  mkdirSync(program, { recursive: true });
  mkdirSync(join(root, "usr", "lib", "libreoffice", "share", ".registry"), {
    recursive: true,
  });
  mkdirSync(join(root, "etc", "libreoffice", "registry"), {
    recursive: true,
  });
  writeFileSync(join(root, "usr", "bin", "soffice"), "fake");
  writeFileSync(join(program, "soffice.bin"), "fake");
  writeFileSync(
    join(program, "fundamentalrc"),
    "BRAND_BASE_DIR=file:///usr/lib/libreoffice\nCONFIGURATION_LAYERS=xcsxcu:file:///etc/libreoffice/registry res:file:///etc/libreoffice/registry\n",
  );
  writeFileSync(
    join(program, "sofficerc"),
    "FHS_CONFIG_FILE=file:///etc/libreoffice/sofficerc\n",
  );
  writeFileSync(
    join(root, "usr", "lib", "libreoffice", "share", ".registry", "main.xcd"),
    "fake",
  );
  writeFileSync(join(root, "etc", "libreoffice", "sofficerc"), "fake");
}

function fakeDpkgDeb(args: readonly string[]): string {
  const archive = args[1];
  const root = args[2];
  if (archive === undefined || root === undefined) {
    throw new Error("invalid dpkg-deb invocation");
  }
  if (basename(archive).startsWith("libreoffice-impress")) {
    fakeLibreOfficePackage(root);
  }
  if (basename(archive).startsWith("poppler-utils")) {
    mkdirSync(join(root, "usr", "bin"), { recursive: true });
    writeFileSync(join(root, "usr", "bin", "pdftocairo"), "fake");
  }
  return "";
}

function fakeSoffice(args: readonly string[]): string {
  const outdir = args[args.indexOf("--outdir") + 1];
  writeFileSync(join(outdir ?? "", "deck.pdf"), "%PDF-1.4");
  return "";
}

function fakePdftocairo(args: readonly string[]): string {
  // Poppler numbers by the page count's digit width, as it does for real.
  const prefix = args[args.length - 1] ?? "";
  for (let page = 1; page <= state.deckPages; page += 1) {
    writeFileSync(
      `${prefix}-${page.toString()}.png`,
      png(state.size.width, state.size.height),
    );
  }
  return "";
}

function fakeBrowser(args: readonly string[]): string {
  const verb = args[3];
  if (verb === "eval") {
    const expression = args[4] ?? "";
    if (expression.includes("document.fonts.ready")) {
      if (state.settleFails) {
        throw new Error("browser settle failed");
      }
      if (expression.includes("backgroundImage")) {
        state.backgroundReady = true;
      }
      return "1";
    }
    return expression.includes("querySelectorAll")
      ? JSON.stringify(JSON.stringify(state.slides))
      : "1";
  }
  if (verb === "screenshot" && args[4] !== undefined) {
    writeFileSync(
      args[4],
      Buffer.concat([
        png(state.size.width, state.size.height),
        Buffer.from([state.backgroundReady ? 1 : 0]),
      ]),
    );
  }
  return "";
}

function fakeExecFileSync(command: string, args: readonly string[]): string {
  if (command === "which") {
    return fakeWhich(args);
  }
  if (command === "apt-get") {
    return fakeAptGet(args);
  }
  if (command === "dpkg-deb") {
    return fakeDpkgDeb(args);
  }
  if (["soffice", "soffice.bin"].includes(basename(command))) {
    return fakeSoffice(args);
  }
  if (basename(command) === "pdftocairo") {
    return fakePdftocairo(args);
  }
  return command === "agent-browser" ? fakeBrowser(args) : "";
}

vi.mock("child_process", () => {
  return { execFileSync: vi.fn(fakeExecFileSync) };
});

const logSpy = vi.spyOn(console, "log").mockImplementation(() => {
  return undefined;
});
const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {
  return undefined;
});

function stdout(): string {
  return logSpy.mock.calls
    .map((call) => {
      return String(call[0]);
    })
    .join("\n");
}

function stderr(): string {
  return errorSpy.mock.calls
    .map((call) => {
      return String(call[0]);
    })
    .join("\n");
}

let workDir = "";
let outDir = "";

async function run(...args: string[]): Promise<void> {
  await presentationCommand.parseAsync(["screenshot", ...args], {
    from: "user",
  });
}

describe("okou presentation screenshot", () => {
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "okou-shot-"));
    outDir = join(workDir, "pages");
    state.slides = [];
    state.installed = new Set(["soffice", "pdftocairo"]);
    state.deckPages = 3;
    state.size = { width: 1600, height: 900 };
    state.backgroundReady = true;
    state.settleFails = false;
    state.installFails = false;
    vi.stubEnv("OKOU_TOKEN", okouToken("org_3ANttyrbWYJk6JKRSTRLEsbsDLe"));
    vi.stubEnv("XDG_CACHE_HOME", join(workDir, "cache"));
    logSpy.mockClear();
    errorSpy.mockClear();
    vi.mocked(execFileSync).mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(workDir, { recursive: true, force: true });
  });

  it("rasterises a pptx deck through LibreOffice and Poppler", async () => {
    writeFileSync(join(workDir, "deck.pptx"), "fake");

    await run("--input", join(workDir, "deck.pptx"), "--out", outDir);

    expect(readdirSync(outDir).sort()).toEqual([
      "page-001.png",
      "page-002.png",
      "page-003.png",
    ]);
    expect(stdout()).toContain("Captured 3 page(s) at 1600x900");
    expect(
      vi.mocked(execFileSync).mock.calls.some((call) => {
        return call[0] === "apt-get";
      }),
    ).toBe(false);
  });

  it("installs only Poppler when a pdf rasteriser is missing", async () => {
    state.installed = new Set(["apt-get", "dpkg-deb"]);
    writeFileSync(join(workDir, "deck.pdf"), "%PDF-1.4");

    await run("--input", join(workDir, "deck.pdf"), "--out", outDir);

    const install = vi.mocked(execFileSync).mock.calls.find((call) => {
      return call[0] === "apt-get" && call[1]?.includes("install") === true;
    });
    expect(install?.[1]).toContain("poppler-utils");
    expect(install?.[1]).not.toContain("libreoffice-impress");
    expect(
      vi.mocked(execFileSync).mock.calls.some((call) => {
        return basename(String(call[0])) === "soffice";
      }),
    ).toBe(false);
  });

  it("renumbers Poppler output into zero-padded page order", async () => {
    state.deckPages = 11;
    writeFileSync(join(workDir, "deck.pdf"), "%PDF-1.4");

    await run("--input", join(workDir, "deck.pdf"), "--out", outDir);

    const files = readdirSync(outDir).sort();
    expect(files).toHaveLength(11);
    expect(files[0]).toBe("page-001.png");
    expect(files[10]).toBe("page-011.png");
  });

  it("installs and caches missing deck dependencies without root", async () => {
    state.installed = new Set(["apt-get", "dpkg-deb"]);
    writeFileSync(join(workDir, "deck.pptx"), "fake");

    await run("--input", join(workDir, "deck.pptx"), "--out", outDir);
    await run("--input", join(workDir, "deck.pptx"), "--out", outDir);

    const installs = vi.mocked(execFileSync).mock.calls.filter((call) => {
      return call[0] === "apt-get" && call[1]?.includes("install") === true;
    });
    expect(installs).toHaveLength(1);
    expect(installs[0]?.[1]).toEqual(
      expect.arrayContaining(["libreoffice-impress", "poppler-utils"]),
    );
    expect(readdirSync(outDir)).toHaveLength(3);
    expect(stderr()).toContain("Presentation dependencies installed.");
  });

  it("explains how to recover when automatic installation fails", async () => {
    state.installed = new Set(["apt-get", "dpkg-deb"]);
    state.installFails = true;
    writeFileSync(join(workDir, "deck.pptx"), "fake");

    await expect(
      run("--input", join(workDir, "deck.pptx"), "--out", outDir),
    ).rejects.toThrow(/process\.exit/u);

    expect(stderr()).toContain(
      "Could not automatically install presentation dependencies",
    );
    expect(stderr()).toContain(
      "sudo apt-get install -y --no-install-recommends libreoffice-impress poppler-utils",
    );
  });

  it("checks the deck input before installing dependencies", async () => {
    state.installed = new Set(["apt-get", "dpkg-deb"]);

    await expect(
      run("--input", join(workDir, "missing.pptx"), "--out", outDir),
    ).rejects.toThrow(/process\.exit/u);

    expect(stderr()).toContain("Deck input is not a file");
    expect(
      vi.mocked(execFileSync).mock.calls.some((call) => {
        return call[0] === "apt-get";
      }),
    ).toBe(false);
  });

  it("captures one page per slide in an HTML deck", async () => {
    state.slides = [
      { top: 0, left: 0 },
      { top: 900, left: 0 },
      { top: 1800, left: 0 },
    ];
    writeFileSync(join(workDir, "deck.html"), "<html></html>");

    await run("--input", join(workDir, "deck.html"), "--out", outDir);

    expect(readdirSync(outDir)).toHaveLength(3);
  });

  it("waits for CSS background images before keeping a capture", async () => {
    state.backgroundReady = false;
    writeFileSync(join(workDir, "page.html"), "<html></html>");

    await run("--input", join(workDir, "page.html"), "--out", outDir);

    expect(readFileSync(join(outDir, "page-001.png")).at(-1)).toBe(1);
  });

  it("fails closed when browser settling fails", async () => {
    state.settleFails = true;
    writeFileSync(join(workDir, "page.html"), "<html></html>");

    await expect(
      run("--input", join(workDir, "page.html"), "--out", outDir),
    ).rejects.toThrow(/process\.exit/u);

    expect(stderr()).toContain("browser settle failed");
    expect(readdirSync(outDir)).toEqual([]);
  });

  it("captures one page per file in a layout directory, skipping partials", async () => {
    writeFileSync(join(workDir, "_shell.html"), "<html></html>");
    writeFileSync(join(workDir, "cover.html"), "<html></html>");
    writeFileSync(join(workDir, "closing.html"), "<html></html>");

    await run("--input", workDir, "--out", outDir, "--json");

    expect((JSON.parse(stdout()) as { pages: number }).pages).toBe(2);
  });

  it("rejects a capture that is not the requested page size", async () => {
    state.size = { width: 1280, height: 720 };
    writeFileSync(join(workDir, "page.html"), "<html></html>");

    await expect(
      run("--input", join(workDir, "page.html"), "--out", outDir),
    ).rejects.toThrow(/process\.exit/u);
    expect(stderr()).toContain("Captured 1280x720, expected 1600x900");
  });

  it("rejects an input that is neither a deck nor HTML", async () => {
    writeFileSync(join(workDir, "notes.txt"), "text");

    await expect(
      run("--input", join(workDir, "notes.txt"), "--out", outDir),
    ).rejects.toThrow(/process\.exit/u);
    expect(stderr()).toContain("Unsupported input extension: .txt");
  });

  it("rejects execution while the rollout switch is off", async () => {
    vi.stubEnv("OKOU_TOKEN", okouToken("org-external"));
    writeFileSync(join(workDir, "deck.pdf"), "%PDF-1.4");

    await expect(
      run("--input", join(workDir, "deck.pdf"), "--out", outDir),
    ).rejects.toThrow(/process\.exit/u);

    expect(stderr()).toContain(
      "Presentation screenshot is not enabled for this workspace",
    );
  });
});
