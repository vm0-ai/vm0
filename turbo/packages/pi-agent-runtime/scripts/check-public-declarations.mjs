#!/usr/bin/env node

import fs from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = resolve(packageRoot, "dist");
const nativeExports = new Set(["./node"]);
const forbiddenPackages = [
  "@anthropic-ai",
  "@earendil-works",
  "@google/genai",
  "@google/generative-ai",
  "@modelcontextprotocol",
  "@sinclair/typebox",
  "openai",
  "typebox",
  "undici-types",
];

function fail(message, details = []) {
  process.stderr.write(`${message}\n`);
  for (const detail of details) {
    process.stderr.write(`  ${detail}\n`);
  }
  process.exitCode = 1;
}

function matchesForbiddenPackage(specifier) {
  return forbiddenPackages.some((packageName) => {
    return specifier === packageName || specifier.startsWith(`${packageName}/`);
  });
}

function packageSpecifierFromFile(fileName) {
  const normalized = fileName.replaceAll("\\", "/");
  const marker = "/node_modules/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex === -1) {
    return undefined;
  }
  const segments = normalized.slice(markerIndex + marker.length).split("/");
  if (segments[0]?.startsWith("@")) {
    return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : segments[0];
  }
  return segments[0];
}

function moduleSpecifiers(sourceFile) {
  const specifiers = [];
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return specifiers;
}

function resolveRelativeDeclaration(importer, specifier) {
  const target = resolve(dirname(importer), specifier);
  const extension = extname(target);
  const candidates = [target, `${target}.d.ts`, join(target, "index.d.ts")];
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    candidates.push(`${target.slice(0, -extension.length)}.d.ts`);
  }
  return candidates.find((candidate) => {
    return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
  });
}

const packageJson = JSON.parse(
  fs.readFileSync(resolve(packageRoot, "package.json"), "utf8"),
);
const entryFiles = [];
for (const [exportName, exportTarget] of Object.entries(
  packageJson.exports ?? {},
)) {
  if (nativeExports.has(exportName)) {
    continue;
  }
  const typesTarget = exportTarget?.types;
  if (typeof typesTarget !== "string") {
    fail(`Clean export ${exportName} must declare one types target`);
    continue;
  }
  const entryFile = resolve(packageRoot, typesTarget);
  if (!entryFile.startsWith(`${distRoot}/`) || !fs.existsSync(entryFile)) {
    fail(`Clean export ${exportName} has an invalid generated types target`, [
      typesTarget,
    ]);
    continue;
  }
  entryFiles.push(entryFile);
}

const visitedDeclarations = new Set();
const directViolations = [];
const unresolvedDeclarations = [];
const pendingDeclarations = [...entryFiles];
while (pendingDeclarations.length > 0) {
  const fileName = pendingDeclarations.pop();
  if (!fileName || visitedDeclarations.has(fileName)) {
    continue;
  }
  visitedDeclarations.add(fileName);
  const sourceFile = ts.createSourceFile(
    fileName,
    fs.readFileSync(fileName, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  for (const specifier of moduleSpecifiers(sourceFile)) {
    if (matchesForbiddenPackage(specifier)) {
      directViolations.push(`${fileName}: ${specifier}`);
      continue;
    }
    if (!specifier.startsWith(".")) {
      continue;
    }
    const declaration = resolveRelativeDeclaration(fileName, specifier);
    if (!declaration) {
      unresolvedDeclarations.push(`${fileName}: ${specifier}`);
      continue;
    }
    pendingDeclarations.push(declaration);
  }
}

if (directViolations.length > 0) {
  fail("Clean public declarations reference forbidden SDK packages:", [
    ...directViolations,
  ]);
}
if (unresolvedDeclarations.length > 0) {
  fail("Clean public declarations contain unresolved relative references:", [
    ...unresolvedDeclarations,
  ]);
}

const configPath = resolve(packageRoot, "tsconfig.build.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) {
  throw new Error(
    ts.flattenDiagnosticMessageText(config.error.messageText, "\n"),
  );
}
const parsedConfig = ts.parseJsonConfigFileContent(
  config.config,
  ts.sys,
  packageRoot,
  undefined,
  configPath,
);
const program = ts.createProgram({
  rootNames: entryFiles,
  options: {
    ...parsedConfig.options,
    composite: false,
    declaration: false,
    declarationMap: false,
    incremental: false,
    noEmit: true,
    tsBuildInfoFile: undefined,
    types: [],
  },
});
const resolvedViolations = program.getSourceFiles().flatMap((sourceFile) => {
  const packageSpecifier = packageSpecifierFromFile(sourceFile.fileName);
  return packageSpecifier && matchesForbiddenPackage(packageSpecifier)
    ? [`${packageSpecifier}: ${sourceFile.fileName}`]
    : [];
});
if (resolvedViolations.length > 0) {
  fail("Clean public declaration programs resolve forbidden SDK packages:", [
    ...resolvedViolations,
  ]);
}

if (process.exitCode !== 1) {
  process.stdout.write(
    `Public declaration boundary: entries=${entryFiles.length}; declarations=${visitedDeclarations.size}; forbidden=0\n`,
  );
}
