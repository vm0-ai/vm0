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
const runningTrayFrameCount = 60;

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
    const render =
      iconName === "tray-iconRunning" ? runningTrayPngBuffer : pngBuffer;
    const [regularPng, retinaPng] = await Promise.all([
      render(svg, 18),
      render(svg, 36),
    ]);
    await Promise.all([
      writeFile(path.join(assetsDirectory, `${iconName}.png`), regularPng),
      writeFile(path.join(assetsDirectory, `${iconName}@2x.png`), retinaPng),
    ]);
  }
}

async function runningTrayPngBuffer(svg, size) {
  const frames = await Promise.all(
    Array.from({ length: runningTrayFrameCount }, async (_, index) => {
      const angle = (index * 360) / runningTrayFrameCount;
      const rotatedSvg = svg
        .toString()
        .replace(/<g transform="/, `<g transform="rotate(${angle} 256 256) `);
      return {
        input: await pngBuffer(Buffer.from(rotatedSvg), size),
        left: index * size,
        top: 0,
      };
    }),
  );
  return sharp({
    create: {
      width: size * runningTrayFrameCount,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(frames)
    .png({ adaptiveFiltering: false, compressionLevel: 9 })
    .toBuffer();
}

await Promise.all([generateAppIcon(), generateTrayIcons()]);
