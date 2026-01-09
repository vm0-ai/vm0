import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import { VMRegistry, DEFAULT_REGISTRY_PATH } from "../vm-registry";

// Mock fs module
vi.mock("fs");

describe("VMRegistry", () => {
  let registry: VMRegistry;
  const testRegistryPath = "/tmp/test-vm-registry.json";
  const testTempPath = `${testRegistryPath}.tmp`;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new VMRegistry(testRegistryPath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("should use default path when not specified", () => {
      const defaultRegistry = new VMRegistry();
      expect(defaultRegistry["registryPath"]).toBe(DEFAULT_REGISTRY_PATH);
    });

    it("should use custom path when specified", () => {
      expect(registry["registryPath"]).toBe(testRegistryPath);
    });
  });

  describe("register", () => {
    it("should register a VM with correct data", () => {
      const mockWriteFileSync = vi.mocked(fs.writeFileSync);
      const mockRenameSync = vi.mocked(fs.renameSync);

      registry.register("172.16.0.2", "run-123", "token-abc");

      // Atomic write: writes to .tmp file first, then renames
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        testTempPath,
        expect.any(String),
        { mode: 0o644 },
      );
      expect(mockRenameSync).toHaveBeenCalledWith(
        testTempPath,
        testRegistryPath,
      );

      // Parse the written data
      const firstCall = mockWriteFileSync.mock.calls[0];
      expect(firstCall).toBeDefined();
      const writtenData = JSON.parse(firstCall![1] as string);
      expect(writtenData.vms["172.16.0.2"]).toMatchObject({
        runId: "run-123",
        sandboxToken: "token-abc",
      });
      expect(writtenData.vms["172.16.0.2"].registeredAt).toBeDefined();
    });

    it("should allow registering multiple VMs", () => {
      const mockWriteFileSync = vi.mocked(fs.writeFileSync);

      registry.register("172.16.0.2", "run-123", "token-abc");
      registry.register("172.16.0.3", "run-456", "token-def");

      // Get the last write call
      const lastCall =
        mockWriteFileSync.mock.calls[mockWriteFileSync.mock.calls.length - 1];
      expect(lastCall).toBeDefined();
      const writtenData = JSON.parse(lastCall![1] as string);

      expect(Object.keys(writtenData.vms)).toHaveLength(2);
      expect(writtenData.vms["172.16.0.2"].runId).toBe("run-123");
      expect(writtenData.vms["172.16.0.3"].runId).toBe("run-456");
    });
  });

  describe("unregister", () => {
    it("should remove a registered VM", () => {
      const mockWriteFileSync = vi.mocked(fs.writeFileSync);

      // Register first
      registry.register("172.16.0.2", "run-123", "token-abc");
      registry.register("172.16.0.3", "run-456", "token-def");

      // Unregister one
      registry.unregister("172.16.0.2");

      // Get the last write call
      const unregisterLastCall =
        mockWriteFileSync.mock.calls[mockWriteFileSync.mock.calls.length - 1];
      expect(unregisterLastCall).toBeDefined();
      const writtenData = JSON.parse(unregisterLastCall![1] as string);

      expect(writtenData.vms["172.16.0.2"]).toBeUndefined();
      expect(writtenData.vms["172.16.0.3"]).toBeDefined();
    });

    it("should handle unregistering non-existent VM gracefully", () => {
      const mockWriteFileSync = vi.mocked(fs.writeFileSync);

      // Should not throw
      registry.unregister("172.16.0.99");

      // Should NOT write when VM doesn't exist (no-op)
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });
  });

  describe("lookup", () => {
    it("should return registration for registered VM", () => {
      registry.register("172.16.0.2", "run-123", "token-abc");

      const result = registry.lookup("172.16.0.2");

      expect(result).toMatchObject({
        runId: "run-123",
        sandboxToken: "token-abc",
      });
    });

    it("should return undefined for non-registered VM", () => {
      const result = registry.lookup("172.16.0.99");

      expect(result).toBeUndefined();
    });
  });

  describe("getAll", () => {
    it("should return all registered VMs", () => {
      registry.register("172.16.0.2", "run-123", "token-abc");
      registry.register("172.16.0.3", "run-456", "token-def");

      const all = registry.getAll();

      expect(Object.keys(all)).toHaveLength(2);
      expect(all["172.16.0.2"]?.runId).toBe("run-123");
      expect(all["172.16.0.3"]?.runId).toBe("run-456");
    });

    it("should return empty object when no VMs registered", () => {
      const all = registry.getAll();

      expect(all).toEqual({});
    });
  });

  describe("clear", () => {
    it("should remove all registered VMs", () => {
      const mockWriteFileSync = vi.mocked(fs.writeFileSync);

      registry.register("172.16.0.2", "run-123", "token-abc");
      registry.register("172.16.0.3", "run-456", "token-def");

      registry.clear();

      const clearLastCall =
        mockWriteFileSync.mock.calls[mockWriteFileSync.mock.calls.length - 1];
      expect(clearLastCall).toBeDefined();
      const writtenData = JSON.parse(clearLastCall![1] as string);

      expect(writtenData.vms).toEqual({});
    });
  });

  describe("register with firewall options", () => {
    it("should register a VM with firewall rules", () => {
      const mockWriteFileSync = vi.mocked(fs.writeFileSync);

      const firewallRules = [
        { domain: "*.anthropic.com", action: "ALLOW" as const },
        { final: "DENY" as const },
      ];

      registry.register("172.16.0.2", "run-123", "token-abc", {
        firewallRules,
        mitmEnabled: true,
        sealSecretsEnabled: true,
      });

      const firstCall = mockWriteFileSync.mock.calls[0];
      expect(firstCall).toBeDefined();
      const writtenData = JSON.parse(firstCall![1] as string);

      expect(writtenData.vms["172.16.0.2"]).toMatchObject({
        runId: "run-123",
        sandboxToken: "token-abc",
        firewallRules,
        mitmEnabled: true,
        sealSecretsEnabled: true,
      });
    });

    it("should register a VM with firewall but without MITM", () => {
      const mockWriteFileSync = vi.mocked(fs.writeFileSync);

      const firewallRules = [
        { domain: "httpbin.org", action: "ALLOW" as const },
        { final: "DENY" as const },
      ];

      registry.register("172.16.0.2", "run-123", "token-abc", {
        firewallRules,
        mitmEnabled: false,
        sealSecretsEnabled: false,
      });

      const firstCall = mockWriteFileSync.mock.calls[0];
      expect(firstCall).toBeDefined();
      const writtenData = JSON.parse(firstCall![1] as string);

      expect(writtenData.vms["172.16.0.2"]).toMatchObject({
        runId: "run-123",
        firewallRules,
        mitmEnabled: false,
        sealSecretsEnabled: false,
      });
    });

    it("should register a VM with IP CIDR rules", () => {
      const mockWriteFileSync = vi.mocked(fs.writeFileSync);

      const firewallRules = [
        { ip: "10.0.0.0/8", action: "DENY" as const },
        { ip: "8.8.8.8", action: "ALLOW" as const },
        { final: "DENY" as const },
      ];

      registry.register("172.16.0.2", "run-123", "token-abc", {
        firewallRules,
        mitmEnabled: true,
      });

      const firstCall = mockWriteFileSync.mock.calls[0];
      expect(firstCall).toBeDefined();
      const writtenData = JSON.parse(firstCall![1] as string);

      expect(writtenData.vms["172.16.0.2"].firewallRules).toEqual(
        firewallRules,
      );
    });

    it("should lookup VM with firewall options", () => {
      const firewallRules = [
        { domain: "*.vm0.ai", action: "ALLOW" as const },
        { domain: "*.anthropic.com", action: "ALLOW" as const },
        { final: "DENY" as const },
      ];

      registry.register("172.16.0.2", "run-123", "token-abc", {
        firewallRules,
        mitmEnabled: true,
        sealSecretsEnabled: true,
      });

      const result = registry.lookup("172.16.0.2");

      expect(result).toMatchObject({
        runId: "run-123",
        sandboxToken: "token-abc",
        firewallRules,
        mitmEnabled: true,
        sealSecretsEnabled: true,
      });
    });

    it("should handle registration without options (backwards compatibility)", () => {
      const mockWriteFileSync = vi.mocked(fs.writeFileSync);

      registry.register("172.16.0.2", "run-123", "token-abc");

      const firstCall = mockWriteFileSync.mock.calls[0];
      expect(firstCall).toBeDefined();
      const writtenData = JSON.parse(firstCall![1] as string);

      expect(writtenData.vms["172.16.0.2"].firewallRules).toBeUndefined();
      expect(writtenData.vms["172.16.0.2"].mitmEnabled).toBeUndefined();
      expect(writtenData.vms["172.16.0.2"].sealSecretsEnabled).toBeUndefined();
    });
  });
});
