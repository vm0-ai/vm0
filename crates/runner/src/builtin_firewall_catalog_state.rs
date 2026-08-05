//! Shared runner state for the last durably published builtin firewall catalog.

use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};

use crate::types::Firewall;

type FirewallCatalogSnapshot = Arc<BTreeMap<String, Firewall>>;

/// Cloneable current-catalog view shared by refresh and VM registration.
///
/// The refresh path publishes a new value only after the matching on-disk
/// catalog cache is durable. A registration therefore never snapshots a
/// definition newer than the cache consumed by the mitm addon.
#[derive(Clone, Default)]
pub(crate) struct BuiltinFirewallCatalogState {
    firewalls: Arc<RwLock<Option<FirewallCatalogSnapshot>>>,
}

impl BuiltinFirewallCatalogState {
    pub(crate) fn publish(&self, firewalls: BTreeMap<String, Firewall>) {
        *self
            .firewalls
            .write()
            .unwrap_or_else(|poison| poison.into_inner()) = Some(Arc::new(firewalls));
    }

    pub(crate) fn snapshot(&self) -> Option<FirewallCatalogSnapshot> {
        self.firewalls
            .read()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
    }
}
