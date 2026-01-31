import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  runnerConfigSchema,
  loadConfig,
  validateFirecrackerPaths,
} from "../lib/config.js";

describe("RunnerConfig Schema", () => {
  it("should parse valid config with all fields", () => {
    const config = {
      name: "test-runner",
      group: "test/e2e",
      data_dir: "/opt/runner/data",
      server: {
        url: "https://example.com",
        token: "test-token",
      },
      sandbox: {
        max_concurrent: 2,
        vcpu: 4,
        memory_mb: 4096,
      },
      firecracker: {
        binary: "/usr/bin/firecracker",
        kernel: "/opt/vmlinux",
        rootfs: "/opt/rootfs.squashfs",
      },
      proxy: {
        ca_dir: "/opt/runner/proxy",
      },
    };

    const result = runnerConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("test-runner");
      expect(result.data.group).toBe("test/e2e");
      expect(result.data.sandbox.max_concurrent).toBe(2);
      expect(result.data.server.url).toBe("https://example.com");
    }
  });

  it("should apply default sandbox values", () => {
    const config = {
      name: "test",
      group: "scope/name",
      data_dir: "/opt/runner/data",
      server: {
        url: "https://example.com",
        token: "test-token",
      },
      firecracker: {
        binary: "/usr/bin/firecracker",
        kernel: "/opt/vmlinux",
        rootfs: "/opt/rootfs.squashfs",
      },
      proxy: {
        ca_dir: "/opt/runner/proxy",
      },
    };

    const result = runnerConfigSchema.parse(config);
    expect(result.sandbox.max_concurrent).toBe(1);
    expect(result.sandbox.vcpu).toBe(2);
    expect(result.sandbox.memory_mb).toBe(2048);
  });

  it("should reject invalid group format - no slash", () => {
    const config = {
      name: "test",
      group: "invalid-no-slash",
      server: {
        url: "https://example.com",
        token: "test-token",
      },
      sandbox: {},
      firecracker: {
        binary: "/usr/bin/firecracker",
        kernel: "/opt/vmlinux",
        rootfs: "/opt/rootfs.squashfs",
      },
      proxy: {
        ca_dir: "/opt/runner/proxy",
      },
    };

    const result = runnerConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it("should reject invalid group format - uppercase", () => {
    const config = {
      name: "test",
      group: "Scope/Name",
      server: {
        url: "https://example.com",
        token: "test-token",
      },
      sandbox: {},
      firecracker: {
        binary: "/usr/bin/firecracker",
        kernel: "/opt/vmlinux",
        rootfs: "/opt/rootfs.squashfs",
      },
      proxy: {
        ca_dir: "/opt/runner/proxy",
      },
    };

    const result = runnerConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it("should reject empty name", () => {
    const config = {
      name: "",
      group: "scope/name",
      server: {
        url: "https://example.com",
        token: "test-token",
      },
      firecracker: {
        binary: "/usr/bin/firecracker",
        kernel: "/opt/vmlinux",
        rootfs: "/opt/rootfs.squashfs",
      },
      proxy: {
        ca_dir: "/opt/runner/proxy",
      },
    };

    const result = runnerConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it("should reject missing firecracker paths", () => {
    const config = {
      name: "test",
      group: "scope/name",
      server: {
        url: "https://example.com",
        token: "test-token",
      },
      firecracker: {
        binary: "",
        kernel: "/opt/vmlinux",
        rootfs: "/opt/rootfs.squashfs",
      },
      proxy: {
        ca_dir: "/opt/runner/proxy",
      },
    };

    const result = runnerConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it("should reject missing server config", () => {
    const config = {
      name: "test",
      group: "scope/name",
      firecracker: {
        binary: "/usr/bin/firecracker",
        kernel: "/opt/vmlinux",
        rootfs: "/opt/rootfs.squashfs",
      },
      proxy: {
        ca_dir: "/opt/runner/proxy",
      },
    };

    const result = runnerConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it("should reject invalid server URL", () => {
    const config = {
      name: "test",
      group: "scope/name",
      server: {
        url: "not-a-valid-url",
        token: "test-token",
      },
      firecracker: {
        binary: "/usr/bin/firecracker",
        kernel: "/opt/vmlinux",
        rootfs: "/opt/rootfs.squashfs",
      },
      proxy: {
        ca_dir: "/opt/runner/proxy",
      },
    };

    const result = runnerConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it("should reject missing proxy ca_dir", () => {
    const config = {
      name: "test",
      group: "scope/name",
      server: {
        url: "https://example.com",
        token: "test-token",
      },
      firecracker: {
        binary: "/usr/bin/firecracker",
        kernel: "/opt/vmlinux",
        rootfs: "/opt/rootfs.squashfs",
      },
    };

    const result = runnerConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });
});

describe("loadConfig", () => {
  const testConfigPath = "/tmp/test-runner-config.yaml";

  afterEach(() => {
    if (fs.existsSync(testConfigPath)) {
      fs.unlinkSync(testConfigPath);
    }
  });

  it("should throw error when file does not exist", () => {
    expect(() => loadConfig("/nonexistent/runner.yaml")).toThrow(
      "runner.yaml not found",
    );
  });

  it("should parse valid YAML config", () => {
    const yamlContent = `
name: test-runner
group: e2e/test
data_dir: /opt/runner/data
server:
  url: https://example.com
  token: test-token
sandbox:
  max_concurrent: 1
  vcpu: 2
  memory_mb: 2048
firecracker:
  binary: /usr/bin/firecracker
  kernel: /opt/vmlinux
  rootfs: /opt/rootfs.squashfs
proxy:
  ca_dir: /opt/runner/proxy
`;
    fs.writeFileSync(testConfigPath, yamlContent);

    const config = loadConfig(testConfigPath);
    expect(config.name).toBe("test-runner");
    expect(config.group).toBe("e2e/test");
    expect(config.server.url).toBe("https://example.com");
    expect(config.proxy.ca_dir).toBe("/opt/runner/proxy");
  });

  it("should throw error for invalid YAML config", () => {
    const yamlContent = `
name: test-runner
group: invalid-group
server:
  url: https://example.com
  token: test-token
firecracker:
  binary: /usr/bin/firecracker
  kernel: /opt/vmlinux
  rootfs: /opt/rootfs.squashfs
proxy:
  ca_dir: /opt/runner/proxy
`;
    fs.writeFileSync(testConfigPath, yamlContent);

    expect(() => loadConfig(testConfigPath)).toThrow("Invalid configuration");
  });
});

describe("validateFirecrackerPaths", () => {
  let tempDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-config-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("should pass when all paths exist", () => {
    const firecrackerBin = path.join(tempDir, "firecracker");
    const kernel = path.join(tempDir, "vmlinux");
    const rootfs = path.join(tempDir, "rootfs.squashfs");

    fs.writeFileSync(firecrackerBin, "");
    fs.writeFileSync(kernel, "");
    fs.writeFileSync(rootfs, "");

    const config = {
      binary: firecrackerBin,
      kernel: kernel,
      rootfs: rootfs,
    };

    expect(() => validateFirecrackerPaths(config)).not.toThrow();
  });

  it("should throw error when binary is missing", () => {
    const kernel = path.join(tempDir, "vmlinux");
    const rootfs = path.join(tempDir, "rootfs.squashfs");

    fs.writeFileSync(kernel, "");
    fs.writeFileSync(rootfs, "");

    const config = {
      binary: path.join(tempDir, "firecracker"),
      kernel: kernel,
      rootfs: rootfs,
    };

    expect(() => validateFirecrackerPaths(config)).toThrow(
      "Firecracker binary not found",
    );
  });

  it("should throw error when kernel is missing", () => {
    const firecrackerBin = path.join(tempDir, "firecracker");
    const rootfs = path.join(tempDir, "rootfs.squashfs");

    fs.writeFileSync(firecrackerBin, "");
    fs.writeFileSync(rootfs, "");

    const config = {
      binary: firecrackerBin,
      kernel: path.join(tempDir, "vmlinux"),
      rootfs: rootfs,
    };

    expect(() => validateFirecrackerPaths(config)).toThrow("Kernel not found");
  });

  it("should throw error when rootfs is missing", () => {
    const firecrackerBin = path.join(tempDir, "firecracker");
    const kernel = path.join(tempDir, "vmlinux");

    fs.writeFileSync(firecrackerBin, "");
    fs.writeFileSync(kernel, "");

    const config = {
      binary: firecrackerBin,
      kernel: kernel,
      rootfs: path.join(tempDir, "rootfs.squashfs"),
    };

    expect(() => validateFirecrackerPaths(config)).toThrow("Rootfs not found");
  });
});
