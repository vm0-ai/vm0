/**
 * okou presentation-template screenshot — render HTML pages to ordered PNGs.
 *
 * The counterpart of the source-deck rasteriser: this captures HTML that
 * already renders in a browser — a rebuilt layout, an assembled deck, or a
 * published template — onto a fixed page surface, and verifies every capture
 * before keeping it. See page-capture.ts for what "verifies" means and why.
 */
import { execFileSync } from "child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
} from "fs";
import { extname, join, resolve } from "path";
import { pathToFileURL } from "url";

import chalk from "chalk";
import { Command, InvalidArgumentError } from "commander";

import { withErrorHandler } from "../../lib/command/with-error-handler";
import { decodePng, verifyCapture, type PageGeometry } from "./page-capture";

const DEFAULT_WIDTH = 1600;
const DEFAULT_HEIGHT = 900;
const DEFAULT_RETRIES = 2;
const MAX_PAGES = 100;
const SETTLE_TIMEOUT_MS = 12_000;
const CALL_TIMEOUT_MS = 120_000;

/**
 * Ordered by specificity. Auto-detection accepts the first selector matching
 * more than one element, so a single-page layout is never split on an
 * incidental `.slide` wrapper.
 */
const SLIDE_SELECTORS = [
  ".deck > .slide",
  ".deck > section",
  ".slide",
  "section.slide",
] as const;

const SETTLE_SCRIPT = `(async()=>{
  await Promise.race([document.fonts.ready,new Promise(r=>setTimeout(r,${SETTLE_TIMEOUT_MS.toString()}))]);
  await Promise.race([
    Promise.all(Array.from(document.images).filter(i=>!i.complete).map(i=>new Promise(r=>{i.onload=i.onerror=r}))),
    new Promise(r=>setTimeout(r,${SETTLE_TIMEOUT_MS.toString()}))
  ]);
  const urls = s => Array.from(String(s).matchAll(/url\\("?([^"\\)]+)"?\\)/gi)).map(m=>m[1]);
  await Promise.race([
    Promise.all(Array.from(document.querySelectorAll("*")).flatMap(node=>{
      const image = getComputedStyle(node).backgroundImage;
      if (!image || image === "none") return [];
      return urls(image).map(src=>new Promise(r=>{const i=new Image();i.onload=i.onerror=r;i.src=src;}));
    })),
    new Promise(r=>setTimeout(r,${SETTLE_TIMEOUT_MS.toString()}))
  ]);
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  return 1;
})()`;

const NEXT_FRAME_SCRIPT =
  "(async()=>{await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return 1})()";

interface SlideBox {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

interface PageRecord {
  readonly page: number;
  readonly file: string;
  readonly document: string;
  readonly slide: number;
}

interface RetakeRecord {
  readonly page: number;
  readonly attempts: number;
  readonly rejected: readonly string[];
}

interface FailureRecord {
  readonly page: number;
  readonly document: string;
  readonly problems: readonly string[];
}

interface ScreenshotOptions {
  readonly input: string;
  readonly out: string;
  readonly width: number;
  readonly height: number;
  readonly slides: string;
  readonly retries: number;
  readonly json?: boolean;
}

function parsePositiveInteger(label: string): (value: string) => number {
  return (value: string): number => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new InvalidArgumentError(`${label} must be a positive integer`);
    }
    return parsed;
  };
}

function parseRetries(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError(
      "retries must be zero or a positive integer",
    );
  }
  return parsed;
}

/** Drives agent-browser, the only external boundary this command touches. */
class PageBrowser {
  private readonly session: string;
  private opened = false;

  constructor(session: string) {
    this.session = session;
  }

  private call(args: readonly string[]): string {
    return execFileSync(
      "agent-browser",
      ["--session", this.session, "--allow-file-access", ...args],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: CALL_TIMEOUT_MS,
      },
    ).trim();
  }

  /**
   * Best-effort calls: a viewport preference that the browser declines and a
   * close on an already-gone session are both fine to lose.
   */
  private callOptional(args: readonly string[]): void {
    try {
      this.call(args);
    } catch {
      // The capture itself is what matters; these only shape it.
    }
  }

  /** agent-browser prints the evaluated value on the last line, JSON-encoded. */
  evaluate(expression: string): unknown {
    const last = this.call(["eval", expression])
      .split("\n")
      .filter(Boolean)
      .pop();
    if (last === undefined) {
      return undefined;
    }
    let value: unknown;
    try {
      value = JSON.parse(last);
    } catch {
      return last;
    }
    if (typeof value === "string") {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    return value;
  }

  setViewport(width: number, height: number): void {
    this.call(["set", "viewport", width.toString(), height.toString()]);
    this.callOptional(["set", "media", "reduced-motion"]);
  }

  open(url: string): void {
    this.call(["open", url]);
    this.opened = true;
  }

  reload(): void {
    this.call(["reload"]);
  }

  settle(): void {
    this.callOptional(["eval", SETTLE_SCRIPT]);
  }

  screenshot(path: string): void {
    this.call(["screenshot", path]);
  }

  close(): void {
    if (this.opened) {
      this.callOptional(["close"]);
    }
  }
}

interface SourceDocument {
  readonly url: string;
  readonly label: string;
}

function resolveDocuments(input: string): SourceDocument[] {
  if (/^https?:\/\//u.test(input)) {
    return [{ url: input, label: input }];
  }

  const path = resolve(input);
  if (statSync(path).isDirectory()) {
    const names = readdirSync(path)
      .filter((name) => {
        return extname(name).toLowerCase() === ".html";
      })
      // `_shell.html` and friends are shared partials, not pages. Capturing one
      // yields a picture of an empty canvas.
      .filter((name) => {
        return !name.startsWith("_") && !name.startsWith(".");
      })
      .sort((left, right) => {
        return left.localeCompare(right, "en", {
          numeric: true,
          sensitivity: "base",
        });
      });
    if (names.length === 0) {
      throw new Error(`No page-level .html files in ${path}`);
    }
    return names.map((name) => {
      return { url: pathToFileURL(join(path, name)).href, label: name };
    });
  }

  if (extname(path).toLowerCase() !== ".html") {
    throw new Error(`Unsupported input extension: ${extname(path) || "none"}`);
  }
  return [
    { url: pathToFileURL(path).href, label: path.split("/").pop() ?? path },
  ];
}

function isSlideBox(value: unknown): value is SlideBox {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const box = value as Record<string, unknown>;
  return (
    typeof box.top === "number" &&
    typeof box.left === "number" &&
    typeof box.width === "number" &&
    typeof box.height === "number"
  );
}

function discoverSlides(
  browser: PageBrowser,
  selector: string,
  geometry: PageGeometry,
): SlideBox[] {
  const candidates = selector === "auto" ? SLIDE_SELECTORS : [selector];
  for (const candidate of candidates) {
    if (candidate === "") {
      break;
    }
    const found = browser.evaluate(`(()=>{
      const nodes=[...document.querySelectorAll(${JSON.stringify(candidate)})];
      return JSON.stringify(nodes.map(node=>{
        const box=node.getBoundingClientRect();
        return {top:Math.round(box.top+window.scrollY),left:Math.round(box.left+window.scrollX),
                width:Math.round(box.width),height:Math.round(box.height)};
      }));
    })()`);
    if (!Array.isArray(found) || found.length === 0) {
      continue;
    }
    const boxes = found.filter(isSlideBox);
    if (boxes.length !== found.length) {
      continue;
    }
    if (selector === "auto" && boxes.length < 2) {
      continue;
    }
    return boxes;
  }
  return [{ top: 0, left: 0, width: geometry.width, height: geometry.height }];
}

interface CaptureResult {
  readonly ok: boolean;
  readonly attempts: readonly (readonly string[])[];
}

function captureOne(
  browser: PageBrowser,
  target: SlideBox,
  destination: string,
  geometry: PageGeometry,
  retries: number,
): CaptureResult {
  const attempts: (readonly string[])[] = [];

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) {
      browser.reload();
      browser.settle();
    }

    // Playwright's element-scoped screenshot returns the page background for a
    // slide below the fold, so scroll the slide to the viewport origin and take
    // an ordinary viewport capture instead.
    browser.evaluate(
      `(()=>{window.scrollTo(${target.left.toString()},${target.top.toString()});return window.scrollY})()`,
    );
    browser.evaluate(NEXT_FRAME_SCRIPT);

    // Capture twice. A settled static page yields byte-identical PNGs; anything
    // still painting, animating, or loading does not. This catches partial
    // paints whose colours look plausible, which no single-frame check can.
    const probe = `${destination}.probe`;
    let problems: string[];
    try {
      browser.screenshot(probe);
      browser.evaluate(NEXT_FRAME_SCRIPT);
      browser.screenshot(destination);
      const first = readFileSync(probe);
      const second = readFileSync(destination);
      problems = verifyCapture(decodePng(second), geometry);
      if (!first.equals(second)) {
        problems.push(
          "two consecutive captures differ; the page had not settled",
        );
      }
    } catch (error) {
      problems = [error instanceof Error ? error.message : String(error)];
    } finally {
      rmSync(probe, { force: true });
    }

    attempts.push(problems);
    if (problems.length === 0) {
      return { ok: true, attempts };
    }
  }

  return { ok: false, attempts };
}

interface ScreenshotSummary {
  readonly pages: PageRecord[];
  readonly retried: RetakeRecord[];
  readonly failed: FailureRecord[];
}

async function capturePages(
  options: ScreenshotOptions,
  outDir: string,
): Promise<ScreenshotSummary> {
  mkdirSync(outDir, { recursive: true });
  for (const name of readdirSync(outDir)) {
    if (/^page-\d+\.png$/u.test(name)) {
      unlinkSync(join(outDir, name));
    }
  }

  const documents = resolveDocuments(options.input);
  const geometry: PageGeometry = {
    width: options.width,
    height: options.height,
  };
  const browser = new PageBrowser(`okou-shot-${process.pid.toString()}`);
  const pages: PageRecord[] = [];
  const retried: RetakeRecord[] = [];
  const failed: FailureRecord[] = [];

  try {
    browser.setViewport(options.width, options.height);
    for (const document of documents) {
      browser.open(document.url);
      browser.settle();
      const boxes = discoverSlides(browser, options.slides, geometry);

      for (const [index, box] of boxes.entries()) {
        const page = pages.length + 1;
        if (page > MAX_PAGES) {
          throw new Error(`More than ${MAX_PAGES.toString()} pages`);
        }
        const file = `page-${page.toString().padStart(3, "0")}.png`;
        const result = captureOne(
          browser,
          box,
          join(outDir, file),
          geometry,
          options.retries,
        );
        pages.push({ page, file, document: document.label, slide: index + 1 });

        if (result.attempts.length > 1) {
          retried.push({
            page,
            attempts: result.attempts.length,
            rejected: result.attempts.flat(),
          });
        }
        if (!result.ok) {
          failed.push({
            page,
            document: document.label,
            problems: result.attempts.at(-1) ?? [],
          });
        }
      }
    }
  } finally {
    browser.close();
  }

  return { pages, retried, failed };
}

function renderSummary(
  summary: ScreenshotSummary,
  options: ScreenshotOptions,
  outDir: string,
): void {
  console.log(
    `Captured ${summary.pages.length.toString()} page(s) at ${options.width.toString()}x${options.height.toString()} into ${outDir}`,
  );
  for (const retake of summary.retried) {
    console.log(
      chalk.yellow(
        `  page ${retake.page.toString()} needed ${retake.attempts.toString()} attempts: ${retake.rejected[0] ?? ""}`,
      ),
    );
  }
  if (summary.failed.length > 0) {
    console.error(
      chalk.red(
        `\n${summary.failed.length.toString()} page(s) never captured cleanly:`,
      ),
    );
    for (const failure of summary.failed) {
      console.error(
        chalk.red(
          `  page ${failure.page.toString()} (${failure.document}): ${failure.problems.join("; ")}`,
        ),
      );
    }
    console.error(
      "\nFix the page in the template, then rerun. Do not publish these images.",
    );
    return;
  }
  console.log(
    chalk.dim(
      "\nInspect the images, then publish with: okou presentation-template publish --pages <dir> ...",
    ),
  );
}

export const screenshotCommand = new Command()
  .name("screenshot")
  .description(
    "Render an HTML page, layout directory, or deck to ordered page PNGs, verifying every capture before keeping it",
  )
  .requiredOption(
    "--input <path>",
    "HTML file, directory of HTML files, or http(s) URL",
  )
  .requiredOption("--out <dir>", "Output directory for page-001.png, ...")
  .option(
    "--width <px>",
    "Page width in CSS pixels",
    parsePositiveInteger("width"),
    DEFAULT_WIDTH,
  )
  .option(
    "--height <px>",
    "Page height in CSS pixels",
    parsePositiveInteger("height"),
    DEFAULT_HEIGHT,
  )
  .option(
    "--slides <selector>",
    'Slide selector within one document, or "none" for one page per file',
    "auto",
  )
  .option(
    "--retries <count>",
    "Reload-and-retake attempts per page",
    parseRetries,
    DEFAULT_RETRIES,
  )
  .option("--json", "Print the complete result as JSON")
  .action(
    withErrorHandler(async (options: ScreenshotOptions) => {
      const outDir = resolve(options.out);
      const resolved: ScreenshotOptions = {
        ...options,
        slides: options.slides === "none" ? "" : options.slides,
      };
      const summary = await capturePages(resolved, outDir);

      if (options.json === true) {
        console.log(
          JSON.stringify(
            {
              pages: summary.pages.length,
              width: options.width,
              height: options.height,
              outDir,
              documents: [
                ...new Set(
                  summary.pages.map((page) => {
                    return page.document;
                  }),
                ),
              ],
              // Retaken pages are reported rather than hidden: a template that
              // only captures cleanly on the second try is worth knowing about.
              retried: summary.retried,
              failed: summary.failed,
            },
            null,
            2,
          ),
        );
      } else {
        renderSummary(summary, options, outDir);
      }

      if (summary.failed.length > 0) {
        process.exitCode = 1;
      }
    }),
  );
