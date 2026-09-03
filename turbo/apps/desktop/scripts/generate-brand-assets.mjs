#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const assetsDirectory = path.resolve(scriptDirectory, "..", "assets");

const icnsRepresentations = [
  ["icp4", 16],
  ["ic11", 32],
  ["icp5", 32],
  ["ic12", 64],
  ["icp6", 64],
  ["ic07", 128],
  ["ic13", 256],
  ["ic08", 256],
  ["ic14", 512],
  ["ic09", 512],
  ["ic10", 1024],
];

const trayIcons = [
  "tray-iconTemplate",
  "tray-iconDisabled",
  "tray-iconRunning",
];

async function pngBuffer(svg, size) {
  return sharp(svg)
    .resize(size, size)
    .png({ adaptiveFiltering: false, compressionLevel: 9 })
    .toBuffer();
}

function icnsChunk(type, png) {
  const chunk = Buffer.alloc(8 + png.length);
  chunk.write(type, 0, 4, "ascii");
  chunk.writeUInt32BE(chunk.length, 4);
  png.copy(chunk, 8);
  return chunk;
}

async function generateAppIcon() {
  const iconSvg = await readFile(path.join(assetsDirectory, "icon.svg"));
  const iconPng = await pngBuffer(iconSvg, 1024);
  await writeFile(path.join(assetsDirectory, "icon.png"), iconPng);

  const chunks = await Promise.all(
    icnsRepresentations.map(async ([type, size]) => {
      return icnsChunk(type, await pngBuffer(iconSvg, size));
    }),
  );
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(header.length + body.length, 4);
  await writeFile(
    path.join(assetsDirectory, "icon.icns"),
    Buffer.concat([header, body]),
  );
}

async function generateTrayIcons() {
  for (const iconName of trayIcons) {
    const svg = await readFile(path.join(assetsDirectory, `${iconName}.svg`));
    const [regularPng, retinaPng] = await Promise.all([
      pngBuffer(svg, 18),
      pngBuffer(svg, 36),
    ]);
    await Promise.all([
      writeFile(path.join(assetsDirectory, `${iconName}.png`), regularPng),
      writeFile(path.join(assetsDirectory, `${iconName}@2x.png`), retinaPng),
    ]);
  }
}

await Promise.all([generateAppIcon(), generateTrayIcons()]);
