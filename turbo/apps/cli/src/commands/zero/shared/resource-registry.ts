// Thin re-export shim. The resource registry now lives in `@vm0/core` as the
// single source of truth. Keep importing from this path within the CLI.
export * from "@vm0/core/resource-registry";
