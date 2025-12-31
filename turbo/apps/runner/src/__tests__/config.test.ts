import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
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
      sandbox: {
        max_concurrent: 2,
        vcpu: 4,
        memory_mb: 4096,
      },
      firecracker: {
        binary: "/usr/bin/firecracker",
        kernel: "/opt/vmlinux",
        rootfs: "/opt/rootfs.ext4",
      },
    };

    const result = runnerConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("test-runner");
      expect(result.data.group).toBe("test/e2e");
      expect(result.data.sandbox.max_concurrent).toBe(2);
    }
  });

  it("should apply default sandbox values", () => {
    const config = {
      name: "test",
      group: "scope/name",
      firecracker: {
        binary: "/usr/bin/firecracker",
        kernel: "/opt/vmlinux",
        rootfs: "/opt/rootfs.ext4",
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
      sandbox: {},
      firecracker: {
        binary: "/usr/bin/firecracker",
        kernel: "/opt/vmlinux",
        rootfs: "/opt/rootfs.ext4",
      },
    };

    const result = runnerConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it("should reject invalid group format - uppercase", () => {
    const config = {
      name: "test",
      group: "Scope/Name",
      sandbox: {},
      firecracker: {
        binary: "/usr/bin/firecracker",
        kernel: "/opt/vmlinux",
        rootfs: "/opt/rootfs.ext4",
      },
    };

    const result = runnerConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it("should reject empty name", () => {
    const config = {
      name: "",
      group: "scope/name",
      firecracker: {
        binary: "/usr/bin/firecracker",
        kernel: "/opt/vmlinux",
        rootfs: "/opt/rootfs.ext4",
      },
    };

    const result = runnerConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it("should reject missing firecracker paths", () => {
    const config = {
      name: "test",
      group: "scope/name",
      firecracker: {
        binary: "",
        kernel: "/opt/vmlinux",
        rootfs: "/opt/rootfs.ext4",
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
sandbox:
  max_concurrent: 1
  vcpu: 2
  memory_mb: 2048
firecracker:
  binary: /usr/bin/firecracker
  kernel: /opt/vmlinux
  rootfs: /opt/rootfs.ext4
`;
    fs.writeFileSync(testConfigPath, yamlContent);

    const config = loadConfig(testConfigPath);
    expect(config.name).toBe("test-runner");
    expect(config.group).toBe("e2e/test");
  });

  it("should throw error for invalid YAML config", () => {
    const yamlContent = `
name: test-runner
group: invalid-group
firecracker:
  binary: /usr/bin/firecracker
  kernel: /opt/vmlinux
  rootfs: /opt/rootfs.ext4
`;
    fs.writeFileSync(testConfigPath, yamlContent);

    expect(() => loadConfig(testConfigPath)).toThrow("Invalid configuration");
  });
});

describe("validateFirecrackerPaths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(fs, "existsSync");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should pass when all paths exist", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    const config = {
      binary: "/usr/bin/firecracker",
      kernel: "/opt/vmlinux",
      rootfs: "/opt/rootfs.ext4",
    };

    expect(() => validateFirecrackerPaths(config)).not.toThrow();
  });

  it("should throw error when binary is missing", () => {
    vi.mocked(fs.existsSync).mockImplementation((path) => {
      return path !== "/usr/bin/firecracker";
    });

    const config = {
      binary: "/usr/bin/firecracker",
      kernel: "/opt/vmlinux",
      rootfs: "/opt/rootfs.ext4",
    };

    expect(() => validateFirecrackerPaths(config)).toThrow(
      "Firecracker binary not found",
    );
  });

  it("should throw error when kernel is missing", () => {
    vi.mocked(fs.existsSync).mockImplementation((path) => {
      return path !== "/opt/vmlinux";
    });

    const config = {
      binary: "/usr/bin/firecracker",
      kernel: "/opt/vmlinux",
      rootfs: "/opt/rootfs.ext4",
    };

    expect(() => validateFirecrackerPaths(config)).toThrow("Kernel not found");
  });

  it("should throw error when rootfs is missing", () => {
    vi.mocked(fs.existsSync).mockImplementation((path) => {
      return path !== "/opt/rootfs.ext4";
    });

    const config = {
      binary: "/usr/bin/firecracker",
      kernel: "/opt/vmlinux",
      rootfs: "/opt/rootfs.ext4",
    };

    expect(() => validateFirecrackerPaths(config)).toThrow("Rootfs not found");
  });
});
