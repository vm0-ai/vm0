import { describe, it, expect } from "vitest";
import { parseS3Uri } from "../s3-client";

describe("parseS3Uri", () => {
  it("should parse valid S3 URI with prefix", () => {
    const result = parseS3Uri("s3://my-bucket/path/to/files");

    expect(result).toEqual({
      bucket: "my-bucket",
      prefix: "path/to/files",
    });
  });

  it("should parse S3 URI without prefix", () => {
    const result = parseS3Uri("s3://my-bucket/");

    expect(result).toEqual({
      bucket: "my-bucket",
      prefix: "",
    });
  });

  it("should parse S3 URI with bucket only", () => {
    const result = parseS3Uri("s3://my-bucket");

    expect(result).toEqual({
      bucket: "my-bucket",
      prefix: "",
    });
  });

  it("should parse S3 URI with nested prefix", () => {
    const result = parseS3Uri("s3://my-bucket/a/b/c/d");

    expect(result).toEqual({
      bucket: "my-bucket",
      prefix: "a/b/c/d",
    });
  });

  it("should throw error for invalid URI format", () => {
    expect(() => parseS3Uri("invalid-uri")).toThrow(
      "Invalid S3 URI format: invalid-uri",
    );
  });

  it("should throw error for http URL", () => {
    expect(() => parseS3Uri("https://bucket.s3.amazonaws.com/key")).toThrow(
      "Invalid S3 URI format",
    );
  });

  it("should throw error for empty string", () => {
    expect(() => parseS3Uri("")).toThrow("Invalid S3 URI format");
  });
});
