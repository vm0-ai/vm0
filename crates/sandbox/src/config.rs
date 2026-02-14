pub struct ResourceLimits {
    pub cpu_count: u32,
    pub memory_mb: u32,
}

pub struct SandboxConfig {
    pub id: uuid::Uuid,
    pub resources: ResourceLimits,
    /// Whether this sandbox's traffic should be routed through the transparent proxy.
    pub use_proxy: bool,
}
