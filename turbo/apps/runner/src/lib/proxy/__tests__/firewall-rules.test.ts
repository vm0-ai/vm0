import { describe, it, expect } from "vitest";

/**
 * Unit tests for firewall rule matching logic
 * These tests verify the rule matching algorithms used in the mitmproxy addon
 */

// Rule matching logic (same as in mitm-addon-script.ts)
function matchDomain(pattern: string, hostname: string): boolean {
  if (!pattern || !hostname) {
    return false;
  }

  pattern = pattern.toLowerCase();
  hostname = hostname.toLowerCase();

  if (pattern.startsWith("*.")) {
    // Wildcard: *.example.com matches sub.example.com, www.example.com
    // Also matches example.com itself (without subdomain)
    const suffix = pattern.slice(1); // .example.com
    const base = pattern.slice(2); // example.com
    return hostname.endsWith(suffix) || hostname === base;
  }

  return hostname === pattern;
}

function matchIp(cidr: string, ipStr: string): boolean {
  if (!cidr || !ipStr) {
    return false;
  }

  // Simple IP matching for tests (production uses Python ipaddress module)
  // Handle /32 for single IPs
  const parts = cidr.includes("/") ? cidr.split("/") : [cidr, "32"];
  const network = parts[0];
  const prefixStr = parts[1];
  if (!network || !prefixStr) {
    return false;
  }
  const prefix = parseInt(prefixStr, 10);

  // Parse IP addresses
  const networkOctets = network.split(".").map(Number);
  const ipOctets = ipStr.split(".").map(Number);

  if (networkOctets.length !== 4 || ipOctets.length !== 4) {
    return false;
  }

  // Convert to 32-bit integers
  const networkInt =
    ((networkOctets[0]! << 24) |
      (networkOctets[1]! << 16) |
      (networkOctets[2]! << 8) |
      networkOctets[3]!) >>>
    0;
  const ipInt =
    ((ipOctets[0]! << 24) |
      (ipOctets[1]! << 16) |
      (ipOctets[2]! << 8) |
      ipOctets[3]!) >>>
    0;

  // Create subnet mask
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;

  return (networkInt & mask) === (ipInt & mask);
}

interface FirewallRule {
  domain?: string;
  ip?: string;
  final?: boolean;
  action: "ALLOW" | "DENY";
}

function evaluateRules(
  rules: FirewallRule[],
  hostname: string,
  ipStr?: string,
): [string, string | null] {
  if (!rules.length) {
    return ["ALLOW", null]; // No rules = allow all
  }

  for (const rule of rules) {
    // Final/terminal rule
    if (rule.final) {
      return [rule.action ?? "DENY", "final"];
    }

    // Domain rule
    if (rule.domain && matchDomain(rule.domain, hostname)) {
      return [rule.action ?? "DENY", `domain:${rule.domain}`];
    }

    // IP rule
    if (rule.ip && ipStr && matchIp(rule.ip, ipStr)) {
      return [rule.action ?? "DENY", `ip:${rule.ip}`];
    }
  }

  // No rule matched - default deny (zero-trust)
  return ["DENY", "default"];
}

describe("matchDomain", () => {
  describe("exact match", () => {
    it("should match exact domain", () => {
      expect(matchDomain("example.com", "example.com")).toBe(true);
    });

    it("should be case insensitive", () => {
      expect(matchDomain("Example.COM", "example.com")).toBe(true);
      expect(matchDomain("example.com", "EXAMPLE.COM")).toBe(true);
    });

    it("should not match different domain", () => {
      expect(matchDomain("example.com", "other.com")).toBe(false);
    });

    it("should not match subdomain without wildcard", () => {
      expect(matchDomain("example.com", "sub.example.com")).toBe(false);
    });
  });

  describe("wildcard match", () => {
    it("should match subdomain with wildcard", () => {
      expect(matchDomain("*.example.com", "sub.example.com")).toBe(true);
    });

    it("should match nested subdomain", () => {
      expect(matchDomain("*.example.com", "a.b.example.com")).toBe(true);
    });

    it("should match base domain with wildcard", () => {
      // *.example.com also matches example.com
      expect(matchDomain("*.example.com", "example.com")).toBe(true);
    });

    it("should not match different base domain", () => {
      expect(matchDomain("*.example.com", "other.com")).toBe(false);
      expect(matchDomain("*.example.com", "sub.other.com")).toBe(false);
    });

    it("should be case insensitive", () => {
      expect(matchDomain("*.EXAMPLE.com", "sub.example.COM")).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("should return false for empty pattern", () => {
      expect(matchDomain("", "example.com")).toBe(false);
    });

    it("should return false for empty hostname", () => {
      expect(matchDomain("example.com", "")).toBe(false);
    });
  });
});

describe("matchIp", () => {
  describe("single IP (/32)", () => {
    it("should match exact IP", () => {
      expect(matchIp("1.2.3.4", "1.2.3.4")).toBe(true);
    });

    it("should match with explicit /32", () => {
      expect(matchIp("1.2.3.4/32", "1.2.3.4")).toBe(true);
    });

    it("should not match different IP", () => {
      expect(matchIp("1.2.3.4", "1.2.3.5")).toBe(false);
    });
  });

  describe("CIDR ranges", () => {
    it("should match IP in /24 range", () => {
      expect(matchIp("192.168.1.0/24", "192.168.1.1")).toBe(true);
      expect(matchIp("192.168.1.0/24", "192.168.1.255")).toBe(true);
    });

    it("should not match IP outside /24 range", () => {
      expect(matchIp("192.168.1.0/24", "192.168.2.1")).toBe(false);
    });

    it("should match IP in /8 range", () => {
      expect(matchIp("10.0.0.0/8", "10.0.0.1")).toBe(true);
      expect(matchIp("10.0.0.0/8", "10.255.255.255")).toBe(true);
    });

    it("should not match IP outside /8 range", () => {
      expect(matchIp("10.0.0.0/8", "11.0.0.1")).toBe(false);
    });

    it("should match IP in /16 range", () => {
      expect(matchIp("172.16.0.0/16", "172.16.0.1")).toBe(true);
      expect(matchIp("172.16.0.0/16", "172.16.255.255")).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("should return false for empty CIDR", () => {
      expect(matchIp("", "1.2.3.4")).toBe(false);
    });

    it("should return false for empty IP", () => {
      expect(matchIp("1.2.3.4", "")).toBe(false);
    });

    it("should return false for invalid IP", () => {
      expect(matchIp("1.2.3.4", "invalid")).toBe(false);
    });
  });
});

describe("evaluateRules", () => {
  describe("empty rules", () => {
    it("should allow all when no rules defined", () => {
      const [action, rule] = evaluateRules([], "example.com");
      expect(action).toBe("ALLOW");
      expect(rule).toBeNull();
    });
  });

  describe("domain rules", () => {
    it("should match domain ALLOW rule", () => {
      const rules: FirewallRule[] = [
        { domain: "example.com", action: "ALLOW" },
        { final: true, action: "DENY" },
      ];

      const [action, rule] = evaluateRules(rules, "example.com");
      expect(action).toBe("ALLOW");
      expect(rule).toBe("domain:example.com");
    });

    it("should match wildcard domain rule", () => {
      const rules: FirewallRule[] = [
        { domain: "*.anthropic.com", action: "ALLOW" },
        { final: true, action: "DENY" },
      ];

      const [action, rule] = evaluateRules(rules, "api.anthropic.com");
      expect(action).toBe("ALLOW");
      expect(rule).toBe("domain:*.anthropic.com");
    });

    it("should deny unmatched domain", () => {
      const rules: FirewallRule[] = [
        { domain: "allowed.com", action: "ALLOW" },
        { final: true, action: "DENY" },
      ];

      const [action, rule] = evaluateRules(rules, "blocked.com");
      expect(action).toBe("DENY");
      expect(rule).toBe("final");
    });
  });

  describe("IP rules", () => {
    it("should match IP ALLOW rule", () => {
      const rules: FirewallRule[] = [
        { ip: "1.2.3.4", action: "ALLOW" },
        { final: true, action: "DENY" },
      ];

      const [action, rule] = evaluateRules(rules, "example.com", "1.2.3.4");
      expect(action).toBe("ALLOW");
      expect(rule).toBe("ip:1.2.3.4");
    });

    it("should match CIDR DENY rule", () => {
      const rules: FirewallRule[] = [
        { ip: "10.0.0.0/8", action: "DENY" },
        { final: true, action: "ALLOW" },
      ];

      const [action, rule] = evaluateRules(rules, "internal.local", "10.1.2.3");
      expect(action).toBe("DENY");
      expect(rule).toBe("ip:10.0.0.0/8");
    });
  });

  describe("first-match-wins", () => {
    it("should use first matching rule", () => {
      const rules: FirewallRule[] = [
        { domain: "example.com", action: "ALLOW" },
        { domain: "example.com", action: "DENY" }, // This should never match
        { final: true, action: "DENY" },
      ];

      const [action] = evaluateRules(rules, "example.com");
      expect(action).toBe("ALLOW");
    });

    it("should prefer domain rule over IP rule when domain matches first", () => {
      const rules: FirewallRule[] = [
        { domain: "example.com", action: "ALLOW" },
        { ip: "1.2.3.4", action: "DENY" },
        { final: true, action: "DENY" },
      ];

      const [action] = evaluateRules(rules, "example.com", "1.2.3.4");
      expect(action).toBe("ALLOW");
    });
  });

  describe("final rule", () => {
    it("should stop at final rule", () => {
      const rules: FirewallRule[] = [
        { domain: "allowed.com", action: "ALLOW" },
        { final: true, action: "DENY" },
        { domain: "this-should-never-match.com", action: "ALLOW" },
      ];

      const [action, rule] = evaluateRules(rules, "blocked.com");
      expect(action).toBe("DENY");
      expect(rule).toBe("final");
    });
  });

  describe("default deny (no final rule)", () => {
    it("should default to DENY when no rules match and no final rule", () => {
      const rules: FirewallRule[] = [
        { domain: "allowed.com", action: "ALLOW" },
      ];

      const [action, rule] = evaluateRules(rules, "blocked.com");
      expect(action).toBe("DENY");
      expect(rule).toBe("default");
    });
  });

  describe("typical firewall scenarios", () => {
    it("should handle allowlist with catch-all deny", () => {
      const rules: FirewallRule[] = [
        { domain: "*.vm0.ai", action: "ALLOW" },
        { domain: "*.anthropic.com", action: "ALLOW" },
        { domain: "github.com", action: "ALLOW" },
        { final: true, action: "DENY" },
      ];

      expect(evaluateRules(rules, "api.vm0.ai")[0]).toBe("ALLOW");
      expect(evaluateRules(rules, "api.anthropic.com")[0]).toBe("ALLOW");
      expect(evaluateRules(rules, "github.com")[0]).toBe("ALLOW");
      expect(evaluateRules(rules, "evil.com")[0]).toBe("DENY");
    });

    it("should handle blocklist with catch-all allow", () => {
      const rules: FirewallRule[] = [
        { ip: "10.0.0.0/8", action: "DENY" },
        { ip: "192.168.0.0/16", action: "DENY" },
        { final: true, action: "ALLOW" },
      ];

      expect(evaluateRules(rules, "internal.local", "10.1.2.3")[0]).toBe(
        "DENY",
      );
      expect(evaluateRules(rules, "home.local", "192.168.1.1")[0]).toBe("DENY");
      expect(evaluateRules(rules, "public.com", "8.8.8.8")[0]).toBe("ALLOW");
    });

    it("should handle mixed domain and IP rules", () => {
      const rules: FirewallRule[] = [
        { domain: "*.anthropic.com", action: "ALLOW" },
        { ip: "10.0.0.0/8", action: "DENY" },
        { domain: "internal.corp", action: "ALLOW" },
        { final: true, action: "DENY" },
      ];

      expect(evaluateRules(rules, "api.anthropic.com")[0]).toBe("ALLOW");
      expect(evaluateRules(rules, "random.host", "10.1.2.3")[0]).toBe("DENY");
      expect(evaluateRules(rules, "internal.corp")[0]).toBe("ALLOW");
      expect(evaluateRules(rules, "blocked.com", "8.8.8.8")[0]).toBe("DENY");
    });
  });
});
