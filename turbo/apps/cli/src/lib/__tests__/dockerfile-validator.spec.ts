import { describe, it, expect } from "vitest";
import { validateDockerfile } from "../dockerfile-validator";

describe("validateDockerfile", () => {
  it("should accept valid Dockerfile with only FROM and RUN", () => {
    const dockerfile = `FROM node:24
RUN apt-get update && apt-get install -y git
RUN npm install -g @anthropic-ai/claude-code@latest`;

    const result = validateDockerfile(dockerfile);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("should accept multi-line RUN with backslash", () => {
    const dockerfile = `FROM ubuntu:22.04
RUN apt-get update && apt-get install -y \\
    git \\
    curl \\
    python3`;

    const result = validateDockerfile(dockerfile);
    expect(result.valid).toBe(true);
  });

  it("should accept comments and empty lines", () => {
    const dockerfile = `# This is a comment
FROM node:24

# Another comment
RUN npm install`;

    const result = validateDockerfile(dockerfile);
    expect(result.valid).toBe(true);
  });

  it("should accept parser directives", () => {
    const dockerfile = `# syntax=docker/dockerfile:1
FROM node:24
RUN npm install`;

    const result = validateDockerfile(dockerfile);
    expect(result.valid).toBe(true);
  });

  it("should reject COPY instruction", () => {
    const dockerfile = `FROM node:24
COPY package.json .
RUN npm install`;

    const result = validateDockerfile(dockerfile);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Unsupported instruction: COPY (line 2)");
  });

  it("should reject multiple unsupported instructions", () => {
    const dockerfile = `FROM node:24
WORKDIR /app
COPY . .
ENV NODE_ENV=production
RUN npm install`;

    const result = validateDockerfile(dockerfile);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(3);
    expect(result.errors).toContain(
      "Unsupported instruction: WORKDIR (line 2)",
    );
    expect(result.errors).toContain("Unsupported instruction: COPY (line 3)");
    expect(result.errors).toContain("Unsupported instruction: ENV (line 4)");
  });

  it("should handle case-insensitive instructions", () => {
    const dockerfile = `from node:24
run npm install`;

    const result = validateDockerfile(dockerfile);
    expect(result.valid).toBe(true);
  });

  it("should reject ADD instruction", () => {
    const dockerfile = `FROM node:24
ADD https://example.com/file.tar.gz /tmp/
RUN tar -xzf /tmp/file.tar.gz`;

    const result = validateDockerfile(dockerfile);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Unsupported instruction: ADD (line 2)");
  });

  it("should reject CMD instruction", () => {
    const dockerfile = `FROM node:24
RUN npm install
CMD ["node", "index.js"]`;

    const result = validateDockerfile(dockerfile);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Unsupported instruction: CMD (line 3)");
  });

  it("should reject ENTRYPOINT instruction", () => {
    const dockerfile = `FROM node:24
RUN npm install
ENTRYPOINT ["node"]`;

    const result = validateDockerfile(dockerfile);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "Unsupported instruction: ENTRYPOINT (line 3)",
    );
  });

  it("should reject USER instruction", () => {
    const dockerfile = `FROM node:24
USER node
RUN npm install`;

    const result = validateDockerfile(dockerfile);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Unsupported instruction: USER (line 2)");
  });

  it("should reject EXPOSE instruction", () => {
    const dockerfile = `FROM node:24
EXPOSE 3000
RUN npm install`;

    const result = validateDockerfile(dockerfile);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Unsupported instruction: EXPOSE (line 2)");
  });

  it("should reject VOLUME instruction", () => {
    const dockerfile = `FROM node:24
VOLUME /data
RUN npm install`;

    const result = validateDockerfile(dockerfile);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Unsupported instruction: VOLUME (line 2)");
  });

  it("should reject ARG instruction", () => {
    const dockerfile = `FROM node:24
ARG VERSION=1.0
RUN npm install`;

    const result = validateDockerfile(dockerfile);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Unsupported instruction: ARG (line 2)");
  });

  it("should reject LABEL instruction", () => {
    const dockerfile = `FROM node:24
LABEL maintainer="test@example.com"
RUN npm install`;

    const result = validateDockerfile(dockerfile);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Unsupported instruction: LABEL (line 2)");
  });
});
