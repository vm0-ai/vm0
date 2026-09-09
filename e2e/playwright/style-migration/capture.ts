import type { Page } from "@playwright/test";

// Full-tile raster avoids retaining clipped antialiasing from earlier paints.
export const browserArgs = [
  "--disable-gpu",
  "--force-color-profile=srgb",
  "--deterministic-mode",
  "--disable-partial-raster",
];

async function frames(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

export async function stableScreenshot(page: Page): Promise<Buffer> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      Array.from(document.images)
        .filter((image) => image.currentSrc)
        .map((image) => image.decode()),
    );
    await Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished),
    );
    for (const animation of document.getAnimations()) {
      if (animation.effect?.getComputedTiming().iterations === Infinity) {
        animation.pause();
        animation.currentTime = 0;
      }
    }
  });
  let previous: Buffer | undefined;
  let consecutive = 0;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await frames(page);
    const image = await page.screenshot({ fullPage: true, caret: "initial" });
    consecutive = previous?.equals(image) ? consecutive + 1 : 1;
    if (consecutive === 3) return image;
    previous = image;
  }
  throw new Error(
    "Three identical painted frames were not observed; baseline is not stable",
  );
}
