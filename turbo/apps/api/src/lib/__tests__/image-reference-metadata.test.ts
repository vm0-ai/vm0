import { describe, expect, it } from "vitest";

import { parseImageReferenceMetadata } from "../image-reference-metadata";

const validJpeg = [
  "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsj",
  "HBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgo",
  "KCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAAR",
  "CAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAA",
  "AAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAA",
  "AAAAAAAAAAD/2gAMAwEAAhEDEQA/AKpAB//Z",
].join("");

const supportedImages = [
  [
    "image/png",
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z0YQAAAAASUVORK5CYII=",
  ],
  ["image/jpeg", validJpeg],
  [
    "image/webp",
    "UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vz0AAA=",
  ],
] as const;

describe("parseImageReferenceMetadata", () => {
  it.each(supportedImages)(
    "reads the actual format and dimensions for %s",
    (contentType, encoded) => {
      expect(
        parseImageReferenceMetadata(Buffer.from(encoded, "base64")),
      ).toStrictEqual({ contentType, width: 1, height: 1 });
    },
  );

  it("rejects unsupported and malformed image bytes", () => {
    const gif = Buffer.from(
      "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
      "base64",
    );

    expect(parseImageReferenceMetadata(gif)).toBeNull();
    expect(parseImageReferenceMetadata(Buffer.from("not an image"))).toBeNull();
  });
});
