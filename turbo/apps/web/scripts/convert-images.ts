import sharp from "sharp";
import { readdir } from "fs/promises";
import { join } from "path";

const PUBLIC_DIR = join(process.cwd(), "public", "assets");
const BG_IMAGES = ["bg_1.png", "bg_2.png", "bg_4.png"];

async function convertImage(filename: string) {
  const inputPath = join(PUBLIC_DIR, filename);
  const baseName = filename.replace(".png", "");

  console.log(`\n🔄 Converting ${filename}...`);

  try {
    // Convert to WebP
    const webpPath = join(PUBLIC_DIR, `${baseName}.webp`);
    await sharp(inputPath).webp({ quality: 85, effort: 6 }).toFile(webpPath);
    console.log(`✅ Created ${baseName}.webp`);

    // Convert to AVIF
    const avifPath = join(PUBLIC_DIR, `${baseName}.avif`);
    await sharp(inputPath).avif({ quality: 80, effort: 9 }).toFile(avifPath);
    console.log(`✅ Created ${baseName}.avif`);

    // Get file sizes
    const fs = await import("fs/promises");
    const pngSize = (await fs.stat(inputPath)).size;
    const webpSize = (await fs.stat(webpPath)).size;
    const avifSize = (await fs.stat(avifPath)).size;

    console.log(`📊 Size comparison:`);
    console.log(`   PNG:  ${(pngSize / 1024).toFixed(2)} KB`);
    console.log(
      `   WebP: ${(webpSize / 1024).toFixed(2)} KB (${((1 - webpSize / pngSize) * 100).toFixed(1)}% smaller)`,
    );
    console.log(
      `   AVIF: ${(avifSize / 1024).toFixed(2)} KB (${((1 - avifSize / pngSize) * 100).toFixed(1)}% smaller)`,
    );

    return {
      filename,
      pngSize,
      webpSize,
      avifSize,
    };
  } catch (error) {
    console.error(`❌ Error converting ${filename}:`, error);
    throw error;
  }
}

async function main() {
  console.log("🚀 Starting image conversion...\n");
  console.log(`📁 Working directory: ${PUBLIC_DIR}\n`);

  const results = [];

  for (const filename of BG_IMAGES) {
    const result = await convertImage(filename);
    results.push(result);
  }

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("📈 CONVERSION SUMMARY");
  console.log("=".repeat(60));

  const totalPng = results.reduce((sum, r) => sum + r.pngSize, 0);
  const totalWebp = results.reduce((sum, r) => sum + r.webpSize, 0);
  const totalAvif = results.reduce((sum, r) => sum + r.avifSize, 0);

  console.log(`\nTotal PNG size:  ${(totalPng / 1024).toFixed(2)} KB`);
  console.log(
    `Total WebP size: ${(totalWebp / 1024).toFixed(2)} KB (${((1 - totalWebp / totalPng) * 100).toFixed(1)}% smaller)`,
  );
  console.log(
    `Total AVIF size: ${(totalAvif / 1024).toFixed(2)} KB (${((1 - totalAvif / totalPng) * 100).toFixed(1)}% smaller)`,
  );
  console.log(
    `\n💾 Total savings with AVIF: ${((totalPng - totalAvif) / 1024).toFixed(2)} KB\n`,
  );
}

main().catch(console.error);
