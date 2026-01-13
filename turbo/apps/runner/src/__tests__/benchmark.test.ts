import { describe, it, expect } from "vitest";
import { debugConfigSchema } from "../lib/config.js";

describe("debugConfigSchema", () => {
  it("should parse minimal config with only firecracker paths", () => {
    const config = {
      firecracker: {
        binary: "/usr/bin/firecracker",
        kernel: "/opt/vmlinux",
        rootfs: "/opt/rootfs.ext4",
      },
    };

    const result = debugConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("debug-runner");
      expect(result.data.group).toBe("debug/local");
      expect(result.data.server.url).toBe("http://localhost:3000");
      expect(result.data.server.token).toBe("debug-token");
      expect(result.data.sandbox.vcpu).toBe(2);
      expect(result.data.sandbox.memory_mb).toBe(2048);
      expect(result.data.proxy.port).toBe(8080);
    }
  });

  it("should allow custom sandbox settings", () => {
    const config = {
      firecracker: {
        binary: "/usr/bin/firecracker",
        kernel: "/opt/vmlinux",
        rootfs: "/opt/rootfs.ext4",
      },
      sandbox: {
        vcpu: 4,
        memory_mb: 4096,
      },
    };

    const result = debugConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sandbox.vcpu).toBe(4);
      expect(result.data.sandbox.memory_mb).toBe(4096);
      // Other sandbox fields should still have defaults
      expect(result.data.sandbox.max_concurrent).toBe(1);
    }
  });

  it("should allow custom server settings", () => {
    const config = {
      firecracker: {
        binary: "/usr/bin/firecracker",
        kernel: "/opt/vmlinux",
        rootfs: "/opt/rootfs.ext4",
      },
      server: {
        url: "https://custom.example.com",
        token: "custom-token",
      },
    };

    const result = debugConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.server.url).toBe("https://custom.example.com");
      expect(result.data.server.token).toBe("custom-token");
    }
  });

  it("should reject missing firecracker binary", () => {
    const config = {
      firecracker: {
        binary: "",
        kernel: "/opt/vmlinux",
        rootfs: "/opt/rootfs.ext4",
      },
    };

    const result = debugConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it("should reject missing firecracker kernel", () => {
    const config = {
      firecracker: {
        binary: "/usr/bin/firecracker",
        kernel: "",
        rootfs: "/opt/rootfs.ext4",
      },
    };

    const result = debugConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it("should reject missing firecracker rootfs", () => {
    const config = {
      firecracker: {
        binary: "/usr/bin/firecracker",
        kernel: "/opt/vmlinux",
        rootfs: "",
      },
    };

    const result = debugConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it("should reject missing firecracker section entirely", () => {
    const config = {
      name: "test-runner",
    };

    const result = debugConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });
});
