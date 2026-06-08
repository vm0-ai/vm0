use sandbox::SandboxError;
use tracing::warn;

/// Cloneable metadata for a network namespace.
///
/// Cloning this does not grant release authority. Checked-out ownership is held
/// by [`NetnsLease`].
#[derive(Debug, Clone)]
#[must_use]
pub struct NetnsInfo {
    /// Namespace name (e.g. `vm0-ns-00-00`).
    pub(super) name: String,
    /// Host-side veth device name (e.g. `vm0-ve-00-00`).
    pub(super) host_device: String,
    /// Veth namespace-side IP (e.g. `10.200.0.2`). This is the source IP
    /// that the proxy sees after NAT, used as the VM registry key.
    pub(super) peer_ip: String,
}

impl NetnsInfo {
    pub(super) fn new(name: String, host_device: String, peer_ip: String) -> Self {
        Self {
            name,
            host_device,
            peer_ip,
        }
    }

    /// Returns the host network namespace name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Returns the host-side veth device name for this namespace.
    pub fn host_device(&self) -> &str {
        &self.host_device
    }

    /// Returns the namespace-side veth IP used to identify the VM behind NAT.
    pub fn peer_ip(&self) -> &str {
        &self.peer_ip
    }
}

/// Non-cloneable release authority for a checked-out namespace.
///
/// Dropping a live lease only emits a warning. Call `NetnsPool::release` so
/// the namespace is either recycled into the pool or deleted during shutdown.
#[derive(Debug)]
#[must_use]
pub struct NetnsLease {
    info: NetnsInfo,
    pool_instance_id: u64,
    active: bool,
}

impl NetnsLease {
    pub(super) fn new(info: NetnsInfo, pool_instance_id: u64) -> Self {
        Self {
            info,
            pool_instance_id,
            active: true,
        }
    }

    #[cfg(test)]
    pub(crate) fn new_for_test(name: &str) -> Self {
        Self::new(
            NetnsInfo::new(name.into(), "test-ve".into(), "10.200.0.2".into()),
            0,
        )
    }

    /// Returns cloneable metadata for the checked-out namespace.
    pub fn info(&self) -> &NetnsInfo {
        &self.info
    }

    /// Returns the checked-out namespace name.
    pub fn name(&self) -> &str {
        self.info.name()
    }

    /// Returns the checked-out namespace peer IP.
    pub fn peer_ip(&self) -> &str {
        self.info.peer_ip()
    }

    pub(super) fn pool_instance_id(&self) -> u64 {
        self.pool_instance_id
    }

    pub(super) fn into_info(mut self) -> NetnsInfo {
        self.active = false;
        self.info.clone()
    }

    #[cfg(test)]
    pub(crate) fn into_info_for_test(self) -> NetnsInfo {
        self.into_info()
    }
}

impl Drop for NetnsLease {
    fn drop(&mut self) {
        if self.active {
            warn!(
                name = %self.info.name,
                pool_instance_id = self.pool_instance_id,
                "netns lease dropped without explicit release"
            );
        }
    }
}

/// Configuration for creating a `NetnsPool`.
///
/// When `proxy_port` is set, the pool pre-warms and acquires from the proxy
/// queue only. Without `proxy_port`, it pre-warms and acquires from the plain
/// queue. This avoids keeping an unreachable plain queue alive in proxy mode.
pub struct NetnsPoolConfig {
    /// Proxy port for HTTP/HTTPS redirect (only adds redirect rules when set).
    pub proxy_port: Option<u16>,
    /// DNS proxy port for DNS query redirect. Only meaningful with `proxy_port`.
    pub dns_port: Option<u16>,
}

/// Network pool config after host network prerequisites have been validated.
pub(crate) struct CheckedNetnsPoolConfig {
    pub(super) inner: NetnsPoolConfig,
}

impl NetnsPoolConfig {
    /// Validate host tools required by [`NetnsPool::create`].
    pub(crate) fn into_checked(self) -> std::result::Result<CheckedNetnsPoolConfig, SandboxError> {
        crate::prerequisites::check_network_prerequisites()?;
        Ok(CheckedNetnsPoolConfig { inner: self })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum NetnsReleaseOutcome {
    Released,
    Deleted,
    Abandoned,
    InvalidLease(String),
}

impl NetnsReleaseOutcome {
    pub(crate) fn invalid_message(&self) -> Option<&str> {
        match self {
            Self::InvalidLease(message) => Some(message),
            _ => None,
        }
    }
}
