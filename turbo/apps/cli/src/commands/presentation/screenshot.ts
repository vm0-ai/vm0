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
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import {
  basename,
  delimiter,
  extname,
  isAbsolute,
  join,
  normalize,
  sep,
} from "path";
import { pathToFileURL } from "url";

import { Command, InvalidArgumentError } from "commander";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { decodeSandboxTokenPayload } from "../../lib/api/sandbox-token";
import { withErrorHandler } from "../../lib/command/with-error-handler";

const DEFAULT_WIDTH = 1600;
const DEFAULT_HEIGHT = 900;
const RETRIES = 2;
const RENDER_DPI = "150";
const TIMEOUT_MS = 300_000;
const DECK_EXTENSIONS = [".ppt", ".pptx", ".pdf"];
const DEPENDENCY_CACHE_VERSION = "v1";

interface DeckTool {
  readonly command: string;
  readonly environment?: NodeJS.ProcessEnv;
}

interface DeckTools {
  readonly soffice?: DeckTool;
  readonly pdftocairo: DeckTool;
}

interface DeckDependency {
  readonly binary: string;
  readonly localPath: readonly string[];
  readonly packageName: string;
}

const LIBREOFFICE: DeckDependency = {
  binary: "soffice",
  localPath: ["usr", "lib", "libreoffice", "program", "soffice.bin"],
  packageName: "libreoffice-impress",
};
const POPPLER: DeckDependency = {
  binary: "pdftocairo",
  localPath: ["usr", "bin", "pdftocairo"],
  packageName: "poppler-utils",
};

/** Waits for fonts, images, and CSS background images, then two paint frames. */
const SETTLE = `(async()=>{
  const wait=(promise,label)=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error("Timed out waiting for "+label)),12000);
    promise.then(value=>{clearTimeout(timer);resolve(value)},error=>{clearTimeout(timer);reject(error)});
  });
  const loadImage=src=>new Promise(resolve=>{
    const image=new Image();
    image.onload=image.onerror=resolve;
    image.src=src;
    if(image.complete) resolve();
  });
  await wait(document.fonts.ready,"fonts");
  await wait(
    Promise.all(Array.from(document.images).filter(image=>!image.complete).map(image=>new Promise(resolve=>{image.onload=image.onerror=resolve}))),
    "images"
  );
  const backgroundUrls=[...new Set(
    Array.from(document.querySelectorAll("*")).flatMap(node=>
      Array.from(
        getComputedStyle(node).backgroundImage.matchAll(/url\\((?:"([^"]*)"|'([^']*)'|([^)]*))\\)/gu),
        match=>(match[1]??match[2]??match[3]??"").trim()
      ).filter(Boolean)
    )
  )];
  await wait(Promise.all(backgroundUrls.map(loadImage)),"CSS background images");
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

/**
 * Input and output paths are an explicit local-CLI trust boundary: the operator
 * chooses them and may intentionally address any location they can access.
 */
function operatorPath(input: string): string {
  return normalize(
    isAbsolute(input) ? input : `${process.cwd()}${sep}${input}`,
  );
}

/** Resolve a single directory entry without allowing the entry to escape. */
function childPath(directory: string, name: string): string {
  if (name === "." || name === ".." || basename(name) !== name) {
    throw new Error(`Invalid directory entry: ${name}`);
  }
  return normalize(`${directory}${sep}${name}`);
}

function presentationScreenshotEnabled(): boolean {
  const payload = decodeSandboxTokenPayload();
  return isFeatureEnabled(FeatureSwitchKey.PresentationScreenshot, {
    userId: payload?.userId,
    orgId: payload?.orgId,
  });
}

function run(
  command: string,
  args: readonly string[],
  environment?: NodeJS.ProcessEnv,
): string {
  return execFileSync(command, args, {
    encoding: "utf8",
    env: environment,
    maxBuffer: 64 * 1024 * 1024,
    timeout: TIMEOUT_MS,
  }).trim();
}

function runStreaming(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): void {
  execFileSync(command, args, {
    env: environment,
    stdio: ["ignore", "ignore", process.stderr],
    timeout: TIMEOUT_MS,
  });
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
      rmSync(childPath(outDir, name), { force: true });
    }
  }
}

// --- deck sources -----------------------------------------------------------

function toolOnPath(binary: string): boolean {
  try {
    run("which", [binary]);
    return true;
  } catch {
    return false;
  }
}

function dependencyCacheRoot(): string {
  const configured = process.env.XDG_CACHE_HOME?.trim();
  const cacheHome =
    configured === undefined || configured === ""
      ? join(homedir(), ".cache")
      : configured;
  return join(
    cacheHome,
    "okou",
    "presentation-screenshot",
    DEPENDENCY_CACHE_VERSION,
  );
}

function localToolEnvironment(installRoot: string): NodeJS.ProcessEnv {
  const program = join(installRoot, "usr", "lib", "libreoffice", "program");
  const environment = { ...process.env };
  const libraryDirectories = [program, join(installRoot, "usr", "lib")];
  for (const parent of [
    join(installRoot, "lib"),
    join(installRoot, "usr", "lib"),
  ]) {
    if (!existsSync(parent)) {
      continue;
    }
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.endsWith("-linux-gnu")) {
        libraryDirectories.push(join(parent, entry.name));
      }
    }
  }
  if (
    environment.LD_LIBRARY_PATH !== undefined &&
    environment.LD_LIBRARY_PATH !== ""
  ) {
    libraryDirectories.push(environment.LD_LIBRARY_PATH);
  }

  const pathDirectories = [join(installRoot, "usr", "bin")];
  if (environment.PATH !== undefined && environment.PATH !== "") {
    pathDirectories.push(environment.PATH);
  }

  return {
    ...environment,
    LD_LIBRARY_PATH: libraryDirectories.join(delimiter),
    PATH: pathDirectories.join(delimiter),
    URE_BOOTSTRAP: `vnd.sun.star.pathname:${join(program, "fundamentalrc")}`,
  };
}

function dependencyMarker(
  dependency: DeckDependency,
  installRoot: string,
): string {
  return join(installRoot, `.${dependency.packageName}.ready`);
}

function resolveDeckTool(
  dependency: DeckDependency,
  installRoot: string,
): DeckTool | undefined {
  if (toolOnPath(dependency.binary)) {
    return { command: dependency.binary };
  }
  const command = join(installRoot, ...dependency.localPath);
  return existsSync(dependencyMarker(dependency, installRoot)) &&
    existsSync(command)
    ? { command, environment: localToolEnvironment(installRoot) }
    : undefined;
}

function replaceConfigPaths(
  file: string,
  replacements: readonly (readonly [string, string])[],
): void {
  let content = readFileSync(file, "utf8");
  for (const [from, to] of replacements) {
    content = content.replaceAll(from, to);
  }
  writeFileSync(file, content);
}

function configureLocalLibreOffice(installRoot: string): void {
  const program = join(installRoot, "usr", "lib", "libreoffice", "program");
  const brandBase = pathToFileURL(
    join(installRoot, "usr", "lib", "libreoffice"),
  ).href;
  const registryTarget = join(installRoot, "etc", "libreoffice", "registry");
  const registryUrl = pathToFileURL(registryTarget).href;
  replaceConfigPaths(join(program, "fundamentalrc"), [
    ["file:///usr/lib/libreoffice", brandBase],
    ["file:///etc/libreoffice/registry", registryUrl],
  ]);
  replaceConfigPaths(join(program, "sofficerc"), [
    [
      "file:///etc/libreoffice/sofficerc",
      pathToFileURL(join(installRoot, "etc", "libreoffice", "sofficerc")).href,
    ],
  ]);

  const registrySource = join(
    installRoot,
    "usr",
    "lib",
    "libreoffice",
    "share",
    ".registry",
  );
  mkdirSync(registryTarget, { recursive: true });
  for (const name of readdirSync(registrySource)) {
    cpSync(childPath(registrySource, name), childPath(registryTarget, name), {
      force: true,
      recursive: true,
    });
  }
}

function installLocalDependencies(
  packageNames: readonly string[],
  installRoot: string,
): void {
  const manualCommand = `sudo apt-get install -y --no-install-recommends ${packageNames.join(" ")}`;
  if (!toolOnPath("apt-get") || !toolOnPath("dpkg-deb")) {
    throw new Error(
      `Automatic presentation dependency installation requires apt-get and dpkg-deb. Install manually with: ${manualCommand}`,
    );
  }

  const aptRoot = join(dependencyCacheRoot(), "apt");
  const lists = join(aptRoot, "lists");
  const archives = join(aptRoot, "archives");
  mkdirSync(join(lists, "partial"), { recursive: true });
  mkdirSync(join(archives, "partial"), { recursive: true });

  const aptOptions = [
    "-o",
    "Debug::NoLocking=1",
    "-o",
    `Dir::State::lists=${lists}`,
    "-o",
    `Dir::Cache::archives=${archives}`,
    "-o",
    "Dir::State::status=/var/lib/dpkg/status",
  ];
  const environment = { ...process.env, DEBIAN_FRONTEND: "noninteractive" };
  console.error(
    `Installing presentation dependencies (${packageNames.join(", ")}) into the Okou cache (one-time download)...`,
  );

  try {
    runStreaming("apt-get", [...aptOptions, "update"], environment);
    runStreaming(
      "apt-get",
      [
        "-y",
        "--download-only",
        "--no-install-recommends",
        ...aptOptions,
        "install",
        ...packageNames,
      ],
      environment,
    );

    const packages = readdirSync(archives)
      .filter((name) => {
        return name.endsWith(".deb");
      })
      .sort();
    if (packages.length === 0) {
      throw new Error("apt-get downloaded no Debian packages");
    }
    mkdirSync(installRoot, { recursive: true });
    for (const name of packages) {
      run(
        "dpkg-deb",
        ["-x", childPath(archives, name), installRoot],
        environment,
      );
    }
    if (packageNames.includes(LIBREOFFICE.packageName)) {
      configureLocalLibreOffice(installRoot);
    }
    for (const dependency of [LIBREOFFICE, POPPLER]) {
      if (!packageNames.includes(dependency.packageName)) {
        continue;
      }
      const command = join(installRoot, ...dependency.localPath);
      if (!existsSync(command)) {
        throw new Error(`${dependency.packageName} did not provide ${command}`);
      }
      writeFileSync(dependencyMarker(dependency, installRoot), "ready\n");
    }
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    throw new Error(
      `Could not automatically install presentation dependencies.${detail} Install manually with: ${manualCommand}`,
      { cause: error },
    );
  }

  rmSync(aptRoot, { force: true, recursive: true });
  console.error("Presentation dependencies installed.");
}

function ensureDeckTools(converts: boolean): DeckTools {
  const installRoot = join(dependencyCacheRoot(), "root");
  let soffice = converts
    ? resolveDeckTool(LIBREOFFICE, installRoot)
    : undefined;
  let pdftocairo = resolveDeckTool(POPPLER, installRoot);
  const missingPackages = [
    ...(converts && soffice === undefined ? [LIBREOFFICE.packageName] : []),
    ...(pdftocairo === undefined ? [POPPLER.packageName] : []),
  ];

  if (missingPackages.length > 0) {
    installLocalDependencies(missingPackages, installRoot);
    soffice = converts ? resolveDeckTool(LIBREOFFICE, installRoot) : undefined;
    pdftocairo = resolveDeckTool(POPPLER, installRoot);
  }

  if (pdftocairo === undefined || (converts && soffice === undefined)) {
    throw new Error(
      `Presentation dependencies are still unavailable after installation: ${missingPackages.join(", ")}`,
    );
  }
  return { soffice, pdftocairo };
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
    renameSync(childPath(outDir, item.name), childPath(outDir, name));
    return name;
  });
  return staged.map((name, index) => {
    const final = `page-${(index + 1).toString().padStart(3, "0")}.png`;
    renameSync(childPath(outDir, name), childPath(outDir, final));
    return final;
  });
}

function captureDeck(options: Options, outDir: string): string[] {
  const input = operatorPath(options.input);
  if (!existsSync(input) || !statSync(input).isFile()) {
    throw new Error(`Deck input is not a file: ${input}`);
  }
  const converts = extname(input).toLowerCase() !== ".pdf";
  const tools = ensureDeckTools(converts);
  clearPages(outDir);

  const scratch = mkdtempSync(childPath(outDir, ".okou-convert-"));
  try {
    let pdf = input;
    if (converts) {
      if (tools.soffice === undefined) {
        throw new Error("LibreOffice is unavailable after installation");
      }
      run(
        tools.soffice.command,
        ["--headless", "--convert-to", "pdf", "--outdir", scratch, input],
        tools.soffice.environment,
      );
      const produced = readdirSync(scratch).find((name) => {
        return extname(name).toLowerCase() === ".pdf";
      });
      if (produced === undefined) {
        throw new Error("LibreOffice produced no PDF");
      }
      pdf = childPath(scratch, produced);
    }
    run(
      tools.pdftocairo.command,
      [
        "-png",
        "-r",
        RENDER_DPI,
        "-scale-to-x",
        options.width.toString(),
        "-scale-to-y",
        options.height.toString(),
        pdf,
        childPath(outDir, "page"),
      ],
      tools.pdftocairo.environment,
    );
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
  const path = operatorPath(input);
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
      return { url: pathToFileURL(childPath(path, name)).href, label: name };
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
      page.call(["eval", SETTLE]);

      for (const box of slideBoxes(page, options.slides)) {
        const file = `page-${(files.length + 1).toString().padStart(3, "0")}.png`;
        const target = childPath(outDir, file);
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
        page.call(["eval", SETTLE]);
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
      if (!presentationScreenshotEnabled()) {
        throw new Error(
          "Presentation screenshot is not enabled for this workspace",
        );
      }
      const outDir = operatorPath(options.out);
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
