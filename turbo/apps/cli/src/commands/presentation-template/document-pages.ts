/**
 * Rasterise a PPT, PPTX, or PDF deck into ordered page PNGs.
 *
 * PDF goes straight through Poppler. PPT and PPTX are converted to PDF by
 * LibreOffice first, so both formats share one rasteriser and land on the same
 * fixed page surface as the browser path.
 */
import { execFileSync } from "child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "fs";
import { basename, extname, join } from "path";

import type {
  CaptureSummary,
  FailureRecord,
  PageGeometry,
} from "./capture-types";
import { decodePng, verifyCapture } from "./page-capture";

const RENDER_DPI = "150";
const CONVERT_TIMEOUT_MS = 300_000;

const DOCUMENT_EXTENSIONS = [".ppt", ".pptx", ".pdf"] as const;

export function isDocumentInput(path: string): boolean {
  const extension = extname(path).toLowerCase();
  return DOCUMENT_EXTENSIONS.some((candidate) => {
    return candidate === extension;
  });
}

function run(command: string, args: readonly string[]): void {
  execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: CONVERT_TIMEOUT_MS,
  });
}

/**
 * Missing rasterisers are a setup problem with one fix, so say what to install
 * rather than surfacing a bare ENOENT from deep inside a conversion.
 */
function requireTools(needsLibreOffice: boolean): void {
  const missing: string[] = [];
  const probes: [string, string][] = needsLibreOffice
    ? [
        ["soffice", "libreoffice-impress"],
        ["pdftocairo", "poppler-utils"],
      ]
    : [["pdftocairo", "poppler-utils"]];

  for (const [binary, packageName] of probes) {
    try {
      execFileSync("which", [binary], { encoding: "utf8" });
    } catch {
      missing.push(packageName);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Rendering this deck needs ${missing.join(" and ")}. Install with: sudo apt-get install -y --no-install-recommends ${missing.join(" ")}`,
    );
  }
}

function convertToPdf(input: string, scratch: string): string {
  run("soffice", [
    "--headless",
    "--convert-to",
    "pdf",
    "--outdir",
    scratch,
    input,
  ]);
  const produced = readdirSync(scratch).find((name) => {
    return extname(name).toLowerCase() === ".pdf";
  });
  if (produced === undefined) {
    throw new Error("LibreOffice produced no PDF");
  }
  return join(scratch, produced);
}

/**
 * Poppler numbers pages by the page count's digit width, so collect whatever it
 * wrote and renumber through staged names to avoid colliding with its output.
 */
function renumberPages(outDir: string): string[] {
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
    const stagedName = `.page-staged-${process.pid.toString()}-${index.toString()}.png`;
    renameSync(join(outDir, item.name), join(outDir, stagedName));
    return stagedName;
  });

  return staged.map((stagedName, index) => {
    const finalName = `page-${(index + 1).toString().padStart(3, "0")}.png`;
    renameSync(join(outDir, stagedName), join(outDir, finalName));
    return finalName;
  });
}

export function captureDocumentPages(
  input: string,
  outDir: string,
  geometry: PageGeometry,
): CaptureSummary {
  const extension = extname(input).toLowerCase();
  const needsConversion = extension !== ".pdf";
  requireTools(needsConversion);

  mkdirSync(outDir, { recursive: true });
  for (const name of readdirSync(outDir)) {
    if (/^page-\d+\.png$/u.test(name)) {
      rmSync(join(outDir, name), { force: true });
    }
  }

  const scratch = mkdtempSync(join(outDir, ".okou-convert-"));
  let files: string[];
  try {
    const pdf = needsConversion ? convertToPdf(input, scratch) : input;
    run("pdftocairo", [
      "-png",
      "-r",
      RENDER_DPI,
      "-scale-to-x",
      geometry.width.toString(),
      "-scale-to-y",
      geometry.height.toString(),
      pdf,
      join(outDir, "page"),
    ]);
    files = renumberPages(outDir);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const label = basename(input);
  const failed: FailureRecord[] = [];
  let blank = 0;

  for (const [index, file] of files.entries()) {
    const image = decodePng(readFileSync(join(outDir, file)));
    const problems = verifyCapture(image, geometry, { edgeBand: false });
    // A source deck may legitimately contain a blank page, so an individual one
    // is not a failure here. Every page blank means the conversion failed.
    const isBlank = problems.some((problem) => {
      return problem.includes("one flat colour");
    });
    if (isBlank) {
      blank += 1;
    }
    const real = problems.filter((problem) => {
      return !problem.includes("one flat colour");
    });
    if (real.length > 0) {
      failed.push({ page: index + 1, document: label, problems: real });
    }
  }

  if (blank === files.length) {
    throw new Error(
      `Every rendered page is blank; the ${extension.replace(".", "")} conversion produced no content`,
    );
  }

  return {
    pages: files.map((file, index) => {
      return { page: index + 1, file, document: label, slide: index + 1 };
    }),
    retried: [],
    failed,
    // A PDF never touches LibreOffice, so report what actually ran.
    method: needsConversion ? "libreoffice" : "poppler",
  };
}
