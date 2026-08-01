use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};

pub(super) type ActiveReuseKeys = Arc<Mutex<HashMap<String, usize>>>;

pub(super) fn new_active_reuse_keys() -> ActiveReuseKeys {
    Arc::new(Mutex::new(HashMap::new()))
}

pub(super) fn insert_active_reuse_key(active_reuse_keys: &ActiveReuseKeys, reuse_key: &str) {
    let mut counts = lock_counts(active_reuse_keys);
    *counts.entry(reuse_key.to_owned()).or_insert(0) += 1;
}

pub(super) fn remove_active_reuse_key(active_reuse_keys: &ActiveReuseKeys, reuse_key: &str) {
    let mut counts = lock_counts(active_reuse_keys);
    let Some(count) = counts.get_mut(reuse_key) else {
        return;
    };
    *count = count.saturating_sub(1);
    if *count == 0 {
        counts.remove(reuse_key);
    }
}

pub(super) fn active_reuse_keys(active_reuse_keys: &ActiveReuseKeys) -> HashSet<String> {
    lock_counts(active_reuse_keys).keys().cloned().collect()
}

pub(super) struct ActiveReuseKeyGuard {
    active_reuse_keys: ActiveReuseKeys,
    reuse_key: Option<String>,
}

impl ActiveReuseKeyGuard {
    pub(super) fn new(active_reuse_keys: ActiveReuseKeys, reuse_key: Option<String>) -> Self {
        if let Some(reuse_key) = reuse_key.as_deref() {
            insert_active_reuse_key(&active_reuse_keys, reuse_key);
        }
        Self {
            active_reuse_keys,
            reuse_key,
        }
    }
}

impl Drop for ActiveReuseKeyGuard {
    fn drop(&mut self) {
        if let Some(reuse_key) = self.reuse_key.as_deref() {
            remove_active_reuse_key(&self.active_reuse_keys, reuse_key);
        }
    }
}

fn lock_counts(active_reuse_keys: &ActiveReuseKeys) -> MutexGuard<'_, HashMap<String, usize>> {
    active_reuse_keys
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_reuse_keys_are_ref_counted() {
        let registry = new_active_reuse_keys();
        insert_active_reuse_key(&registry, "thread:thread-1");
        insert_active_reuse_key(&registry, "thread:thread-1");

        assert!(active_reuse_keys(&registry).contains("thread:thread-1"));

        remove_active_reuse_key(&registry, "thread:thread-1");
        assert!(active_reuse_keys(&registry).contains("thread:thread-1"));

        remove_active_reuse_key(&registry, "thread:thread-1");
        assert!(!active_reuse_keys(&registry).contains("thread:thread-1"));
    }

    #[test]
    fn active_reuse_key_guard_registers_and_unregisters_initial_key() {
        let registry = new_active_reuse_keys();
        let guard = ActiveReuseKeyGuard::new(Arc::clone(&registry), Some("thread:thread-2".into()));

        assert!(active_reuse_keys(&registry).contains("thread:thread-2"));

        drop(guard);
        assert!(!active_reuse_keys(&registry).contains("thread:thread-2"));
    }
}
