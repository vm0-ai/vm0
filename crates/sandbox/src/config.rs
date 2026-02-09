pub struct ResourceLimits {
    pub cpu_count: u32,
    pub memory_mb: u32,
    pub timeout_secs: u64,
}

pub struct SandboxConfig {
    pub id: uuid::Uuid,
    pub resources: ResourceLimits,
}
