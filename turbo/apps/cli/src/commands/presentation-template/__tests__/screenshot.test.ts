/**
 * Tests for okou presentation-template screenshot.
 *
 * Mocks only the external boundary: the agent-browser binary (not available in
 * CI). The fake browser writes real PNG bytes to the path it is handed, so the
 * command's real filesystem walk, real PNG decoding, and real capture
 * verification run unchanged — which is the whole point of the command.
 */
import { execFileSync } from "child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { deflateSync } from "zlib";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { presentationTemplateCommand } from "../index";

/** What the fake browser paints next, keyed by the capture ordinal. */
interface FakePage {
  readonly width?: number;
  readonly height?: number;
  /** "varied" renders content; "flat" renders an unpainted page. */
  readonly kind?: "varied" | "flat";
  /** Makes the two stability captures disagree. */
  readonly unstable?: boolean;
}

const browserState: {
  slideBoxes: unknown;
  pages: FakePage[];
  captureIndex: number;
} = { slideBoxes: [], pages: [], captureIndex: 0 };

function crcTable(): number[] {
  return Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    return value >>> 0;
  });
}

const CRC = crcTable();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

function makePng(
  page: Required<Omit<FakePage, "unstable">>,
  salt: number,
): Buffer {
  const { width, height, kind } = page;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const stride = width * 3;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(stride + 1);
    for (let x = 0; x < width; x += 1) {
      const at = 1 + x * 3;
      if (kind === "flat") {
        row[at] = 136;
        row[at + 1] = 136;
        row[at + 2] = 136;
      } else {
        row[at] = (x * 7 + salt) % 256;
        row[at + 1] = (y * 11) % 256;
        row[at + 2] = (x + y) % 256;
      }
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

vi.mock("child_process", () => {
  return {
    execFileSync: vi.fn((command: string, args: readonly string[]) => {
      if (command !== "agent-browser") {
        return "";
      }
      const verb = args[3];
      if (verb === "eval") {
        const script = args[4] ?? "";
        if (script.includes("querySelectorAll")) {
          return JSON.stringify(JSON.stringify(browserState.slideBoxes));
        }
        return "1";
      }
      if (verb === "screenshot") {
        const path = args[4];
        if (path !== undefined) {
          const isProbe = path.endsWith(".probe");
          const ordinal = isProbe
            ? browserState.captureIndex
            : browserState.captureIndex++;
          const page = browserState.pages[ordinal] ?? {};
          const salt = page.unstable === true && isProbe ? 1 : 0;
          writeFileSync(
            path,
            makePng(
              {
                width: page.width ?? 1600,
                height: page.height ?? 900,
                kind: page.kind ?? "varied",
              },
              salt,
            ),
          );
        }
      }
      return "";
    }),
  };
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
  await presentationTemplateCommand.parseAsync(["screenshot", ...args], {
    from: "user",
  });
}

describe("okou presentation-template screenshot", () => {
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "okou-shot-"));
    outDir = join(workDir, "pages");
    browserState.slideBoxes = [];
    browserState.pages = [];
    browserState.captureIndex = 0;
    logSpy.mockClear();
    errorSpy.mockClear();
    process.exitCode = undefined;
    vi.mocked(execFileSync).mockClear();
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it("captures a single HTML file as one ordered page", async () => {
    const page = join(workDir, "cover.html");
    writeFileSync(page, "<html><body>cover</body></html>");

    await run("--input", page, "--out", outDir);

    expect(readdirSync(outDir)).toEqual(["page-001.png"]);
    expect(stdout()).toContain("Captured 1 page(s) at 1600x900");
    expect(process.exitCode).toBeUndefined();
  });

  it("captures one page per slide when a deck holds several", async () => {
    browserState.slideBoxes = [
      { top: 0, left: 0, width: 1600, height: 900 },
      { top: 900, left: 0, width: 1600, height: 900 },
      { top: 1800, left: 0, width: 1600, height: 900 },
    ];
    const deck = join(workDir, "deck.html");
    writeFileSync(deck, "<html><body>deck</body></html>");

    await run("--input", deck, "--out", outDir);

    expect(readdirSync(outDir).sort()).toEqual([
      "page-001.png",
      "page-002.png",
      "page-003.png",
    ]);
  });

  it("skips underscore-prefixed shared partials in a directory", async () => {
    writeFileSync(join(workDir, "_shell.html"), "<html></html>");
    writeFileSync(join(workDir, "cover.html"), "<html>a</html>");
    writeFileSync(join(workDir, "closing.html"), "<html>b</html>");

    await run("--input", workDir, "--out", outDir, "--json");

    const summary = JSON.parse(stdout()) as {
      pages: number;
      documents: string[];
    };
    expect(summary.pages).toBe(2);
    expect(summary.documents).toEqual(["closing.html", "cover.html"]);
  });

  it("rejects a page that rendered as one flat colour and reports it", async () => {
    browserState.pages = [{ kind: "flat" }, { kind: "flat" }, { kind: "flat" }];
    const page = join(workDir, "blank.html");
    writeFileSync(page, "<html><body></body></html>");

    await run("--input", page, "--out", outDir, "--json");

    const summary = JSON.parse(stdout()) as {
      retried: { page: number; attempts: number }[];
      failed: { page: number; problems: string[] }[];
    };
    expect(summary.retried[0]?.attempts).toBe(3);
    expect(summary.failed[0]?.problems[0]).toContain("one flat colour");
    expect(process.exitCode).toBe(1);
  });

  it("retakes a page whose two captures disagree, then keeps the settled one", async () => {
    browserState.pages = [{ unstable: true }, {}];
    const page = join(workDir, "animated.html");
    writeFileSync(page, "<html><body></body></html>");

    await run("--input", page, "--out", outDir, "--json");

    const summary = JSON.parse(stdout()) as {
      retried: { attempts: number; rejected: string[] }[];
      failed: unknown[];
    };
    expect(summary.retried[0]?.attempts).toBe(2);
    expect(summary.retried[0]?.rejected[0]).toContain("had not settled");
    expect(summary.failed).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  it("rejects a capture whose size does not match the requested page", async () => {
    browserState.pages = [{ width: 1280, height: 720 }];
    const page = join(workDir, "small.html");
    writeFileSync(page, "<html></html>");

    // No --json here, so the human-readable failure path is exercised too.
    await run("--input", page, "--out", outDir, "--retries", "0");

    expect(stderr()).toContain("1 page(s) never captured cleanly");
    expect(stderr()).toContain("expected 1600x900, captured 1280x720");
    expect(stderr()).toContain("Do not publish these images");
    expect(process.exitCode).toBe(1);
  });

  it("honours an explicit page size", async () => {
    browserState.pages = [{ width: 1920, height: 1080 }];
    const page = join(workDir, "wide.html");
    writeFileSync(page, "<html></html>");

    await run(
      "--input",
      page,
      "--out",
      outDir,
      "--width",
      "1920",
      "--height",
      "1080",
    );

    expect(stdout()).toContain("Captured 1 page(s) at 1920x1080");
    expect(process.exitCode).toBeUndefined();
  });

  it("rejects a non-HTML input", async () => {
    const deck = join(workDir, "deck.pptx");
    writeFileSync(deck, "not html");

    // withErrorHandler reports the message and exits; vitest surfaces the exit.
    await expect(run("--input", deck, "--out", outDir)).rejects.toThrow(
      /process\.exit/u,
    );
    expect(stderr()).toContain("Unsupported input extension: .pptx");
  });
});
