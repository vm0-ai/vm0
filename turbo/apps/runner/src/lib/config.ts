import { z } from "zod";
import fs from "fs";
import yaml from "yaml";
import { tempPaths } from "./paths.js";

/**
 * Default values for sandbox configuration
 * Note: In zod 4.x, .default({}) doesn't trigger child defaults,
 * so we must provide the full default object
 */
const SANDBOX_DEFAULTS = {
  max_concurrent: 1,
  vcpu: 2,
  memory_mb: 2048,
  poll_interval_ms: 30000, // 30s fallback polling (push is primary)
} as const;

const PROXY_DEFAULTS = {
  port: 8080,
} as const;

/**
 * Runner configuration schema
 */
export const runnerConfigSchema = z.object({
  name: z.string().min(1, "Name is required"),
  group: z
    .string()
    .regex(
      /^[a-z0-9-]+\/[a-z0-9-]+$/,
      "Group must be in format 'scope/name' (lowercase, hyphens allowed)",
    ),
  server: z.object({
    url: z.string().url("Server URL must be a valid URL"),
    token: z.string().min(1, "Server token is required"),
  }),
  sandbox: z
    .object({
      max_concurrent: z
        .number()
        .int()
        .min(1)
        .default(SANDBOX_DEFAULTS.max_concurrent),
      vcpu: z.number().int().min(1).default(SANDBOX_DEFAULTS.vcpu),
      memory_mb: z.number().int().min(128).default(SANDBOX_DEFAULTS.memory_mb),
      poll_interval_ms: z
        .number()
        .int()
        .min(1000)
        .default(SANDBOX_DEFAULTS.poll_interval_ms),
    })
    .default(SANDBOX_DEFAULTS),
  firecracker: z.object({
    binary: z.string().min(1, "Firecracker binary path is required"),
    kernel: z.string().min(1, "Kernel path is required"),
    rootfs: z.string().min(1, "Rootfs path is required"),
  }),
  proxy: z.object({
    port: z.number().int().min(1024).max(65535).default(PROXY_DEFAULTS.port),
    ca_dir: z.string().min(1, "Proxy CA directory is required"),
  }),
});

export type RunnerConfig = z.infer<typeof runnerConfigSchema>;

const DEBUG_SERVER_DEFAULTS = {
  url: "http://localhost:3000",
  token: "debug-token",
} as const;

/**
 * Debug configuration schema (relaxed - only firecracker paths required)
 * Used by the debug command for local testing without API server
 */
export const debugConfigSchema = z.object({
  name: z.string().default("debug-runner"),
  group: z.string().default("debug/local"),
  server: z
    .object({
      url: z.string().url().default(DEBUG_SERVER_DEFAULTS.url),
      token: z.string().default(DEBUG_SERVER_DEFAULTS.token),
    })
    .default(DEBUG_SERVER_DEFAULTS),
  sandbox: z
    .object({
      max_concurrent: z
        .number()
        .int()
        .min(1)
        .default(SANDBOX_DEFAULTS.max_concurrent),
      vcpu: z.number().int().min(1).default(SANDBOX_DEFAULTS.vcpu),
      memory_mb: z.number().int().min(128).default(SANDBOX_DEFAULTS.memory_mb),
      poll_interval_ms: z
        .number()
        .int()
        .min(1000)
        .default(SANDBOX_DEFAULTS.poll_interval_ms),
    })
    .default(SANDBOX_DEFAULTS),
  firecracker: z.object({
    binary: z.string().min(1, "Firecracker binary path is required"),
    kernel: z.string().min(1, "Kernel path is required"),
    rootfs: z.string().min(1, "Rootfs path is required"),
  }),
  proxy: z
    .object({
      port: z.number().int().min(1024).max(65535).default(PROXY_DEFAULTS.port),
      ca_dir: z.string().default(tempPaths.proxyDir),
    })
    .default({ ...PROXY_DEFAULTS, ca_dir: tempPaths.proxyDir }),
});

type DebugConfig = z.infer<typeof debugConfigSchema>;

/**
 * Load and validate debug configuration from YAML file
 * Only firecracker paths are required; everything else has defaults
 */
export function loadDebugConfig(configPath: string): DebugConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const content = fs.readFileSync(configPath, "utf-8");
  const raw: unknown = yaml.parse(content);

  const result = debugConfigSchema.safeParse(raw);
  if (!result.success) {
    const errors = result.error.issues
      .map((e) => `  - ${e.path.join(".")}: ${e.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${errors}`);
  }

  return result.data;
}

/**
 * Load and validate runner configuration from YAML file
 */
export function loadConfig(configPath: string): RunnerConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`runner.yaml not found: ${configPath}`);
  }

  const content = fs.readFileSync(configPath, "utf-8");
  const raw: unknown = yaml.parse(content);

  const result = runnerConfigSchema.safeParse(raw);
  if (!result.success) {
    const errors = result.error.issues
      .map((e) => `  - ${e.path.join(".")}: ${e.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${errors}`);
  }

  return result.data;
}

/**
 * Validate that firecracker paths exist on the filesystem
 */
export function validateFirecrackerPaths(
  config: RunnerConfig["firecracker"],
): void {
  const checks = [
    { path: config.binary, name: "Firecracker binary" },
    { path: config.kernel, name: "Kernel" },
    { path: config.rootfs, name: "Rootfs" },
  ];

  for (const check of checks) {
    if (!fs.existsSync(check.path)) {
      throw new Error(`${check.name} not found: ${check.path}`);
    }
  }
}
