import { describe, expect, it } from "vitest";
import { inferMimetype } from "../mimetype";

describe("inferMimetype", () => {
  it("infers audio MIME types from filenames", () => {
    expect(inferMimetype("clip.mp3")).toBe("audio/mpeg");
    expect(inferMimetype("clip.m4a")).toBe("audio/mp4");
    expect(inferMimetype("clip.wav")).toBe("audio/wav");
    expect(inferMimetype("clip.ogg")).toBe("audio/ogg");
    expect(inferMimetype("clip.flac")).toBe("audio/flac");
  });

  it("infers common archive, data, and design MIME types", () => {
    expect(inferMimetype("archive.zip")).toBe("application/zip");
    expect(inferMimetype("bundle.tar.gz")).toBe("application/gzip");
    expect(inferMimetype("document.pages")).toBe("application/vnd.apple.pages");
    expect(inferMimetype("photo.heic")).toBe("image/heic");
    expect(inferMimetype("events.parquet")).toBe(
      "application/vnd.apache.parquet",
    );
    expect(inferMimetype("local.sqlite")).toBe("application/vnd.sqlite3");
    expect(inferMimetype("book.epub")).toBe("application/epub+zip");
    expect(inferMimetype("design.psd")).toBe("image/vnd.adobe.photoshop");
  });
});
