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
});
