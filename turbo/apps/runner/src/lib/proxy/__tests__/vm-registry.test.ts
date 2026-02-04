import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import * as path from "path";
import * as os from "os";
import { VMRegistry } from "../vm-registry";

describe("VMRegistry", () => {
  let registry: VMRegistry;
  let tempDir: string;
  let testRegistryPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-vm-registry-"));
    testRegistryPath = path.join(tempDir, "vm-registry.json");
    registry = new VMRegistry(testRegistryPath);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("constructor", () => {
    it("should use the specified path", () => {
      expect(registry["registryPath"]).toBe(testRegistryPath);
    });
  });

  describe("register", () => {
    it("should register a VM with correct data", () => {
      registry.register("172.16.0.2", "run-123", "token-abc");

      // Verify file was created
      expect(fs.existsSync(testRegistryPath)).toBe(true);

      // Read and parse the written data
      const content = fs.readFileSync(testRegistryPath, "utf8");
      const writtenData = JSON.parse(content);
      expect(writtenData.vms["172.16.0.2"]).toMatchObject({
        runId: "run-123",
        sandboxToken: "token-abc",
      });
      expect(writtenData.vms["172.16.0.2"].registeredAt).toBeDefined();
    });

    it("should allow registering multiple VMs", () => {
      registry.register("172.16.0.2", "run-123", "token-abc");
      registry.register("172.16.0.3", "run-456", "token-def");

      // Read and parse the final state
      const content = fs.readFileSync(testRegistryPath, "utf8");
      const writtenData = JSON.parse(content);

      expect(Object.keys(writtenData.vms)).toHaveLength(2);
      expect(writtenData.vms["172.16.0.2"].runId).toBe("run-123");
      expect(writtenData.vms["172.16.0.3"].runId).toBe("run-456");
    });
  });

  describe("unregister", () => {
    it("should remove a registered VM", () => {
      registry.register("172.16.0.2", "run-123", "token-abc");
      registry.register("172.16.0.3", "run-456", "token-def");

      registry.unregister("172.16.0.2");

      const content = fs.readFileSync(testRegistryPath, "utf8");
      const writtenData = JSON.parse(content);

      expect(writtenData.vms["172.16.0.2"]).toBeUndefined();
      expect(writtenData.vms["172.16.0.3"]).toBeDefined();
    });

    it("should handle unregistering non-existent VM gracefully", () => {
      registry.unregister("172.16.0.99");

      expect(fs.existsSync(testRegistryPath)).toBe(false);
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
      registry.register("172.16.0.2", "run-123", "token-abc");
      registry.register("172.16.0.3", "run-456", "token-def");

      registry.clear();

      // Read and verify final state
      const content = fs.readFileSync(testRegistryPath, "utf8");
      const writtenData = JSON.parse(content);

      expect(writtenData.vms).toEqual({});
    });
  });

  describe("register with firewall options", () => {
    it("should register a VM with firewall rules", () => {
      const firewallRules = [
        { domain: "*.anthropic.com", action: "ALLOW" as const },
        { final: "DENY" as const },
      ];

      registry.register("172.16.0.2", "run-123", "token-abc", {
        firewallRules,
        mitmEnabled: true,
        sealSecretsEnabled: true,
      });

      const content = fs.readFileSync(testRegistryPath, "utf8");
      const writtenData = JSON.parse(content);

      expect(writtenData.vms["172.16.0.2"]).toMatchObject({
        runId: "run-123",
        sandboxToken: "token-abc",
        firewallRules,
        mitmEnabled: true,
        sealSecretsEnabled: true,
      });
    });

    it("should register a VM with firewall but without MITM", () => {
      const firewallRules = [
        { domain: "httpbin.org", action: "ALLOW" as const },
        { final: "DENY" as const },
      ];

      registry.register("172.16.0.2", "run-123", "token-abc", {
        firewallRules,
        mitmEnabled: false,
        sealSecretsEnabled: false,
      });

      const content = fs.readFileSync(testRegistryPath, "utf8");
      const writtenData = JSON.parse(content);

      expect(writtenData.vms["172.16.0.2"]).toMatchObject({
        runId: "run-123",
        firewallRules,
        mitmEnabled: false,
        sealSecretsEnabled: false,
      });
    });

    it("should register a VM with IP CIDR rules", () => {
      const firewallRules = [
        { ip: "10.0.0.0/8", action: "DENY" as const },
        { ip: "8.8.8.8", action: "ALLOW" as const },
        { final: "DENY" as const },
      ];

      registry.register("172.16.0.2", "run-123", "token-abc", {
        firewallRules,
        mitmEnabled: true,
      });

      const content = fs.readFileSync(testRegistryPath, "utf8");
      const writtenData = JSON.parse(content);

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
      registry.register("172.16.0.2", "run-123", "token-abc");

      const content = fs.readFileSync(testRegistryPath, "utf8");
      const writtenData = JSON.parse(content);

      expect(writtenData.vms["172.16.0.2"].firewallRules).toBeUndefined();
      expect(writtenData.vms["172.16.0.2"].mitmEnabled).toBeUndefined();
      expect(writtenData.vms["172.16.0.2"].sealSecretsEnabled).toBeUndefined();
    });
  });
});
