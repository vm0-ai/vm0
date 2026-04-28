import { normalizeRouteBindings, renderRustRoutes } from "../generate";
import { type RustRouteBinding, rustRouteBindings } from "../routes";

const expectedBindings = [
  {
    method: "POST",
    path: "/api/webhooks/agent/events",
    rustModulePath: ["webhooks", "agent_events"],
    rustConstName: "SEND",
  },
  {
    method: "POST",
    path: "/api/webhooks/agent/checkpoints",
    rustModulePath: ["webhooks", "agent_checkpoints"],
    rustConstName: "CREATE",
  },
  {
    method: "POST",
    path: "/api/webhooks/agent/checkpoints/prepare-history",
    rustModulePath: ["webhooks", "agent_checkpoint_prepare_history"],
    rustConstName: "PREPARE",
  },
  {
    method: "POST",
    path: "/api/webhooks/agent/complete",
    rustModulePath: ["webhooks", "agent_complete"],
    rustConstName: "COMPLETE",
  },
  {
    method: "POST",
    path: "/api/webhooks/agent/heartbeat",
    rustModulePath: ["webhooks", "agent_heartbeat"],
    rustConstName: "SEND",
  },
  {
    method: "POST",
    path: "/api/webhooks/agent/telemetry",
    rustModulePath: ["webhooks", "agent_telemetry"],
    rustConstName: "SEND",
  },
  {
    method: "POST",
    path: "/api/webhooks/agent/storages/prepare",
    rustModulePath: ["webhooks", "agent_storage_prepare"],
    rustConstName: "PREPARE",
  },
  {
    method: "POST",
    path: "/api/webhooks/agent/storages/commit",
    rustModulePath: ["webhooks", "agent_storage_commit"],
    rustConstName: "COMMIT",
  },
] as const;

function validBinding(
  overrides: Partial<RustRouteBinding> = {},
): RustRouteBinding {
  return {
    route: { method: "POST", path: "/api/webhooks/agent/events" },
    rustModulePath: ["webhooks", "agent_events"],
    rustConstName: "SEND",
    ...overrides,
  };
}

describe("Rust route bindings", () => {
  it("contains exactly the initial guest-agent webhook route set", () => {
    const actualBindings = rustRouteBindings.map((binding) => {
      return {
        method: binding.route.method,
        path: binding.route.path,
        rustModulePath: [...binding.rustModulePath],
        rustConstName: binding.rustConstName,
      };
    });

    expect(actualBindings).toEqual(expectedBindings);
  });

  it("normalizes the supported registry into unique Rust routes", () => {
    const normalized = normalizeRouteBindings(rustRouteBindings);
    const rustNames = normalized.map((binding) => {
      return [...binding.rustModulePath, binding.rustConstName].join("::");
    });

    expect(normalized).toHaveLength(expectedBindings.length);
    expect(new Set(rustNames).size).toBe(rustNames.length);
  });

  it("renders deterministic Rust route constants", () => {
    const firstRender = renderRustRoutes(rustRouteBindings);
    const secondRender = renderRustRoutes(rustRouteBindings);

    expect(secondRender).toBe(firstRender);
    for (const binding of expectedBindings) {
      expect(firstRender).toContain("crate::Method::Post");
      expect(firstRender).toContain(`"${binding.path}"`);
    }
  });

  it("fails clearly when a registry entry is malformed", () => {
    const malformedBindings = [
      validBinding({
        route: { method: "TRACE", path: "/api/webhooks/agent/events" },
      }),
    ];

    expect(() => {
      normalizeRouteBindings(malformedBindings);
    }).toThrow("unsupported HTTP method");
  });

  it("fails clearly when a route path is invalid", () => {
    const malformedBindings = [
      validBinding({
        route: { method: "POST", path: "api/webhooks/agent/events" },
      }),
    ];

    expect(() => {
      normalizeRouteBindings(malformedBindings);
    }).toThrow("route path must start with '/'");
  });

  it("fails clearly when a Rust module segment is invalid", () => {
    const malformedBindings = [
      validBinding({
        rustModulePath: ["webhooks", "agent-events"],
      }),
    ];

    expect(() => {
      normalizeRouteBindings(malformedBindings);
    }).toThrow("invalid Rust module segment");
  });

  it("fails clearly when a Rust const name is invalid", () => {
    const malformedBindings = [
      validBinding({
        rustConstName: "send",
      }),
    ];

    expect(() => {
      normalizeRouteBindings(malformedBindings);
    }).toThrow("invalid Rust const name");
  });

  it("fails clearly when Rust route names are duplicated", () => {
    const malformedBindings = [
      validBinding(),
      validBinding({
        route: { method: "POST", path: "/api/webhooks/agent/heartbeat" },
      }),
    ];

    expect(() => {
      normalizeRouteBindings(malformedBindings);
    }).toThrow("duplicate Rust route binding");
  });

  it("fails clearly when method and path route pairs are duplicated", () => {
    const malformedBindings = [
      validBinding(),
      validBinding({
        rustModulePath: ["webhooks", "agent_heartbeat"],
      }),
    ];

    expect(() => {
      normalizeRouteBindings(malformedBindings);
    }).toThrow("duplicate route binding");
  });
});
