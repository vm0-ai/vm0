import { describe, it, expect } from "vitest";
import { pickBestPhoto, formatTelegramFileForContext } from "../images";

describe("pickBestPhoto", () => {
  it("should return undefined for empty array", () => {
    expect(pickBestPhoto([])).toBeUndefined();
  });

  it("should return the single photo when only one is provided", () => {
    const photos = [{ file_id: "a", width: 100, height: 100 }];
    expect(pickBestPhoto(photos)).toBe(photos[0]);
  });

  it("should pick the largest photo by area", () => {
    const photos = [
      { file_id: "small", width: 100, height: 100, file_size: 1000 },
      { file_id: "large", width: 800, height: 600, file_size: 50000 },
      { file_id: "medium", width: 320, height: 240, file_size: 10000 },
    ];
    const result = pickBestPhoto(photos);
    expect(result?.file_id).toBe("large");
  });

  it("should skip photos exceeding 10MB size limit", () => {
    const photos = [
      {
        file_id: "huge",
        width: 4000,
        height: 3000,
        file_size: 15 * 1024 * 1024,
      },
      { file_id: "ok", width: 800, height: 600, file_size: 500000 },
    ];
    const result = pickBestPhoto(photos);
    expect(result?.file_id).toBe("ok");
  });

  it("should accept photos without file_size (treats as within limit)", () => {
    const photos = [
      { file_id: "no-size", width: 1920, height: 1080 },
      { file_id: "with-size", width: 800, height: 600, file_size: 50000 },
    ];
    const result = pickBestPhoto(photos);
    expect(result?.file_id).toBe("no-size");
  });

  it("should fall back to smallest when all exceed size limit", () => {
    const photos = [
      {
        file_id: "huge1",
        width: 4000,
        height: 3000,
        file_size: 15 * 1024 * 1024,
      },
      {
        file_id: "huge2",
        width: 2000,
        height: 1500,
        file_size: 12 * 1024 * 1024,
      },
    ];
    // Falls back to the smallest by area (last in sorted order)
    const result = pickBestPhoto(photos);
    expect(result?.file_id).toBe("huge2");
  });

  it("should pick photo exactly at size limit", () => {
    const limit = 10 * 1024 * 1024;
    const photos = [
      { file_id: "exact", width: 1920, height: 1080, file_size: limit },
      { file_id: "small", width: 320, height: 240, file_size: 1000 },
    ];
    const result = pickBestPhoto(photos);
    expect(result?.file_id).toBe("exact");
  });
});

describe("formatTelegramFileForContext", () => {
  it("should include image type and dimensions", () => {
    const result = formatTelegramFileForContext({
      file_id: "abc123",
      width: 800,
      height: 600,
    });

    expect(result).toContain("[Telegram file] photo (image/jpeg)");
    expect(result).toContain("[Dimensions] 800x600");
  });

  it("should include file id for zero telegram download-file", () => {
    const result = formatTelegramFileForContext(
      {
        file_id: "file_1",
        width: 400,
        height: 300,
      },
      { botId: "bot_1" },
    );

    expect(result).toContain("[ID] file_1");
    expect(result).toContain("[Bot ID] bot_1");
    expect(result).not.toContain("curl -sS");
  });

  it("should include file size when available", () => {
    const result = formatTelegramFileForContext({
      file_id: "my_file_id",
      width: 100,
      height: 100,
      file_size: 1234,
    });

    expect(result).toContain("[Size] 1234 bytes");
  });

  it("should skip dimensions when width or height is 0", () => {
    const result = formatTelegramFileForContext({
      file_id: "abc",
      width: 0,
      height: 0,
    });

    expect(result).not.toContain("Dimensions");
  });
});
