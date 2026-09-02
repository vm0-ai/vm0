/**
 * okou presentation screenshot — render a presentation to page PNGs.
 *
 * A PPT, PPTX, or PDF deck is rasterised through LibreOffice and Poppler.
 * HTML — one page, a directory of layouts, or an assembled deck — is captured
 * through a browser. Both land on the same fixed page surface and write the
 * same ordered page-NNN.png.
 */
import { execFileSync } from "child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "fs";
import { basename, extname, join, resolve } from "path";
import { pathToFileURL } from "url";

import { Command, InvalidArgumentError } from "commander";

import { withErrorHandler } from "../../lib/command/with-error-handler";

const DEFAULT_WIDTH = 1600;
const DEFAULT_HEIGHT = 900;
const RETRIES = 2;
const RENDER_DPI = "150";
const TIMEOUT_MS = 300_000;
const DECK_EXTENSIONS = [".ppt", ".pptx", ".pdf"];

/** Waits for fonts, images, and CSS background images, then two paint frames. */
const SETTLE = `(async()=>{
  await Promise.race([document.fonts.ready,new Promise(r=>setTimeout(r,12000))]);
  await Promise.race([
    Promise.all(Array.from(document.images).filter(i=>!i.complete).map(i=>new Promise(r=>{i.onload=i.onerror=r}))),
    new Promise(r=>setTimeout(r,12000))
  ]);
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  return 1;
})()`;

const NEXT_FRAME =
  "(async()=>{await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return 1})()";

interface Options {
  readonly input: string;
  readonly out: string;
  readonly width: number;
  readonly height: number;
  readonly slides: string;
  readonly json?: boolean;
}

function run(command: string, args: readonly string[]): string {
  return execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: TIMEOUT_MS,
  }).trim();
}

/** PNG stores width and height in the IHDR chunk, always the first one. */
function pngSize(file: string): { width: number; height: number } {
  const header = readFileSync(file).subarray(16, 24);
  return { width: header.readUInt32BE(0), height: header.readUInt32BE(4) };
}

function clearPages(outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  for (const name of readdirSync(outDir)) {
    if (/^page-\d+\.png$/u.test(name)) {
      // Local CLI output paths are intentionally operator-selected.
      // nosemgrep
      rmSync(join(outDir, name), { force: true });
    }
  }
}

// --- deck sources -----------------------------------------------------------

function requireTool(binary: string, packageName: string): void {
  try {
    run("which", [binary]);
  } catch {
    throw new Error(
      `Rendering this deck needs ${packageName}. Install with: sudo apt-get install -y --no-install-recommends ${packageName}`,
    );
  }
}

/**
 * Poppler numbers pages by the page count's digit width, so renumber through
 * staged names to avoid colliding with what it just wrote.
 */
function renumber(outDir: string): string[] {
  const rendered = readdirSync(outDir)
    .map((name) => {
      return { name, page: Number(/^page-(\d+)\.png$/u.exec(name)?.[1]) };
    })
    .filter((item) => {
      return Number.isInteger(item.page);
    })
    .sort((left, right) => {
      return left.page - right.page;
    });
  if (rendered.length === 0) {
    throw new Error("pdftocairo produced no page PNGs");
  }

  const staged = rendered.map((item, index) => {
    const name = `.staged-${process.pid.toString()}-${index.toString()}.png`;
    // Local CLI output paths are intentionally operator-selected.
    // nosemgrep
    renameSync(join(outDir, item.name), join(outDir, name));
    return name;
  });
  return staged.map((name, index) => {
    const final = `page-${(index + 1).toString().padStart(3, "0")}.png`;
    // Local CLI output paths are intentionally operator-selected.
    // nosemgrep
    renameSync(join(outDir, name), join(outDir, final));
    return final;
  });
}

function captureDeck(options: Options, outDir: string): string[] {
  const converts = extname(options.input).toLowerCase() !== ".pdf";
  if (converts) {
    requireTool("soffice", "libreoffice-impress");
  }
  requireTool("pdftocairo", "poppler-utils");
  clearPages(outDir);

  // Local CLI output paths are intentionally operator-selected.
  // nosemgrep
  const scratch = mkdtempSync(join(outDir, ".okou-convert-"));
  try {
    let pdf = options.input;
    if (converts) {
      run("soffice", [
        "--headless",
        "--convert-to",
        "pdf",
        "--outdir",
        scratch,
        options.input,
      ]);
      const produced = readdirSync(scratch).find((name) => {
        return extname(name).toLowerCase() === ".pdf";
      });
      if (produced === undefined) {
        throw new Error("LibreOffice produced no PDF");
      }
      // The file name comes directly from readdirSync(scratch).
      // nosemgrep
      pdf = join(scratch, produced);
    }
    run("pdftocairo", [
      "-png",
      "-r",
      RENDER_DPI,
      "-scale-to-x",
      options.width.toString(),
      "-scale-to-y",
      options.height.toString(),
      pdf,
      // Local CLI output paths are intentionally operator-selected.
      // nosemgrep
      join(outDir, "page"),
    ]);
    return renumber(outDir);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// --- HTML sources -----------------------------------------------------------

interface SlideBox {
  readonly top: number;
  readonly left: number;
}

function browser(session: string) {
  const call = (args: readonly string[]): string => {
    return run("agent-browser", [
      "--session",
      session,
      "--allow-file-access",
      ...args,
    ]);
  };
  const quiet = (args: readonly string[]): void => {
    try {
      call(args);
    } catch {
      // Shaping calls only; the capture itself is what matters.
    }
  };
  return {
    call,
    /** agent-browser prints the evaluated value JSON-encoded on the last line. */
    evaluate: (expression: string): unknown => {
      const last = call(["eval", expression]).split("\n").filter(Boolean).pop();
      try {
        const value: unknown = JSON.parse(last ?? "");
        return typeof value === "string" ? JSON.parse(value) : value;
      } catch {
        return last;
      }
    },
    quiet,
  };
}

function htmlSources(input: string): { url: string; label: string }[] {
  if (/^https?:\/\//u.test(input)) {
    return [{ url: input, label: input }];
  }
  // Reading an operator-selected local input is this CLI's contract.
  // nosemgrep
  const path = resolve(input);
  if (statSync(path).isDirectory()) {
    const names = readdirSync(path)
      .filter((name) => {
        // `_shell.html` and friends are shared partials, not pages.
        return extname(name).toLowerCase() === ".html" && !name.startsWith("_");
      })
      .sort((left, right) => {
        return left.localeCompare(right, "en", { numeric: true });
      });
    if (names.length === 0) {
      throw new Error(`No page-level .html files in ${path}`);
    }
    return names.map((name) => {
      // The file name comes directly from readdirSync(path).
      // nosemgrep
      return { url: pathToFileURL(join(path, name)).href, label: name };
    });
  }
  if (extname(path).toLowerCase() !== ".html") {
    throw new Error(`Unsupported input extension: ${extname(path) || "none"}`);
  }
  return [{ url: pathToFileURL(path).href, label: basename(path) }];
}

function slideBoxes(
  page: ReturnType<typeof browser>,
  selector: string,
): SlideBox[] {
  if (selector === "") {
    return [{ top: 0, left: 0 }];
  }
  const found = page.evaluate(`(()=>{
    const nodes=[...document.querySelectorAll(${JSON.stringify(selector)})];
    return JSON.stringify(nodes.map(n=>{const b=n.getBoundingClientRect();
      return {top:Math.round(b.top+window.scrollY),left:Math.round(b.left+window.scrollX)};}));
  })()`);
  if (!Array.isArray(found) || found.length < 2) {
    return [{ top: 0, left: 0 }];
  }
  return found as SlideBox[];
}

function captureHtml(options: Options, outDir: string): string[] {
  clearPages(outDir);
  const page = browser(`okou-shot-${process.pid.toString()}`);
  const files: string[] = [];

  try {
    page.call([
      "set",
      "viewport",
      options.width.toString(),
      options.height.toString(),
    ]);
    page.quiet(["set", "media", "reduced-motion"]);

    for (const source of htmlSources(options.input)) {
      page.call(["open", source.url]);
      page.quiet(["eval", SETTLE]);

      for (const box of slideBoxes(page, options.slides)) {
        const file = `page-${(files.length + 1).toString().padStart(3, "0")}.png`;
        // Local CLI output paths are intentionally operator-selected.
        // nosemgrep
        const target = join(outDir, file);
        capturePage(page, box, target, options);
        files.push(file);
      }
    }
  } finally {
    page.quiet(["close"]);
  }
  return files;
}

function capturePage(
  page: ReturnType<typeof browser>,
  box: SlideBox,
  target: string,
  options: Options,
): void {
  const probe = `${target}.probe`;
  try {
    for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
      if (attempt > 0) {
        page.call(["reload"]);
        page.quiet(["eval", SETTLE]);
      }
      // An element-scoped screenshot returns the page background for a slide
      // below the fold, so scroll it to the viewport origin and capture that.
      page.evaluate(
        `(()=>{window.scrollTo(${box.left.toString()},${box.top.toString()});return window.scrollY})()`,
      );
      page.evaluate(NEXT_FRAME);

      // Capture twice: a settled static page yields byte-identical PNGs, one
      // still painting or animating does not.
      page.call(["screenshot", probe]);
      page.evaluate(NEXT_FRAME);
      page.call(["screenshot", target]);

      const size = pngSize(target);
      if (size.width !== options.width || size.height !== options.height) {
        throw new Error(
          `Captured ${size.width.toString()}x${size.height.toString()}, expected ${options.width.toString()}x${options.height.toString()}`,
        );
      }
      if (readFileSync(probe).equals(readFileSync(target))) {
        return;
      }
    }
    throw new Error(`${target} never stopped changing between captures`);
  } finally {
    rmSync(probe, { force: true });
  }
}

// --- command ----------------------------------------------------------------

function positiveInteger(label: string): (value: string) => number {
  return (value: string): number => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new InvalidArgumentError(`${label} must be a positive integer`);
    }
    return parsed;
  };
}

export const presentationScreenshotCommand = new Command()
  .name("screenshot")
  .description(
    "Render a presentation (.ppt, .pptx, .pdf, .html) to ordered page PNGs",
  )
  .requiredOption(
    "--input <path>",
    "A .ppt, .pptx, .pdf or .html file, a directory of .html files, or an http(s) URL",
  )
  .requiredOption("--out <dir>", "Output directory for page-001.png, ...")
  .option(
    "--width <px>",
    "Page width in CSS pixels",
    positiveInteger("width"),
    DEFAULT_WIDTH,
  )
  .option(
    "--height <px>",
    "Page height in CSS pixels",
    positiveInteger("height"),
    DEFAULT_HEIGHT,
  )
  .option(
    "--slides <selector>",
    'HTML only: slide selector, or "none" for one page per file',
    ".deck > .slide",
  )
  .option("--json", "Print the result as JSON")
  .action(
    withErrorHandler(async (options: Options) => {
      // Writing to an operator-selected output is this CLI's contract.
      // nosemgrep
      const outDir = resolve(options.out);
      const resolved: Options = {
        ...options,
        slides: options.slides === "none" ? "" : options.slides,
      };
      const isDeck = DECK_EXTENSIONS.includes(
        extname(options.input).toLowerCase(),
      );
      const files = isDeck
        ? captureDeck(resolved, outDir)
        : captureHtml(resolved, outDir);

      if (options.json === true) {
        console.log(
          JSON.stringify(
            {
              pages: files.length,
              width: options.width,
              height: options.height,
              outDir,
            },
            null,
            2,
          ),
        );
        return;
      }
      console.log(
        `Captured ${files.length.toString()} page(s) at ${options.width.toString()}x${options.height.toString()} into ${outDir}`,
      );
    }),
  );
