use std::io;
use std::thread::{self, JoinHandle, ScopedJoinHandle};

pub(crate) type UnitTask = Box<dyn FnOnce() + Send + 'static>;
pub(crate) type VecTask = Box<dyn FnOnce() -> Vec<u8> + Send + 'static>;

pub(crate) trait ThreadSpawner: Clone + Send + Sync + 'static {
    fn spawn_unit(&self, name: &'static str, task: UnitTask) -> io::Result<JoinHandle<()>>;

    fn spawn_vec(&self, name: &'static str, task: VecTask) -> io::Result<JoinHandle<Vec<u8>>>;
}

#[derive(Clone, Copy, Default)]
pub(crate) struct SystemThreadSpawner;

impl ThreadSpawner for SystemThreadSpawner {
    fn spawn_unit(&self, name: &'static str, task: UnitTask) -> io::Result<JoinHandle<()>> {
        thread::Builder::new().name(name.to_string()).spawn(task)
    }

    fn spawn_vec(&self, name: &'static str, task: VecTask) -> io::Result<JoinHandle<Vec<u8>>> {
        thread::Builder::new().name(name.to_string()).spawn(task)
    }
}

pub(crate) fn spawn_scoped_named<'scope, 'env, T, F>(
    scope: &'scope thread::Scope<'scope, 'env>,
    name: &'static str,
    f: F,
) -> io::Result<ScopedJoinHandle<'scope, T>>
where
    T: Send + 'scope,
    F: FnOnce() -> T + Send + 'scope,
{
    thread::Builder::new()
        .name(name.to_string())
        .spawn_scoped(scope, f)
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::collections::VecDeque;
    use std::io;
    use std::sync::{Arc, Mutex};
    use std::thread::JoinHandle;

    use super::{SystemThreadSpawner, ThreadSpawner, UnitTask, VecTask};

    #[derive(Clone)]
    pub(crate) struct FailingThreadSpawner {
        failures: Arc<Mutex<VecDeque<&'static str>>>,
    }

    impl FailingThreadSpawner {
        pub(crate) fn fail_once(name: &'static str) -> Self {
            Self::fail_sequence([name])
        }

        pub(crate) fn fail_sequence(names: impl IntoIterator<Item = &'static str>) -> Self {
            Self {
                failures: Arc::new(Mutex::new(names.into_iter().collect())),
            }
        }

        fn should_fail(&self, name: &'static str) -> bool {
            let mut failures = self.failures.lock().unwrap_or_else(|e| e.into_inner());
            if failures.front().is_some_and(|next| *next == name) {
                failures.pop_front();
                true
            } else {
                false
            }
        }
    }

    impl ThreadSpawner for FailingThreadSpawner {
        fn spawn_unit(&self, name: &'static str, task: UnitTask) -> io::Result<JoinHandle<()>> {
            if self.should_fail(name) {
                drop(task);
                Err(io::Error::other(format!(
                    "injected thread spawn failure for {name}",
                )))
            } else {
                SystemThreadSpawner.spawn_unit(name, task)
            }
        }

        fn spawn_vec(&self, name: &'static str, task: VecTask) -> io::Result<JoinHandle<Vec<u8>>> {
            if self.should_fail(name) {
                drop(task);
                Err(io::Error::other(format!(
                    "injected thread spawn failure for {name}",
                )))
            } else {
                SystemThreadSpawner.spawn_vec(name, task)
            }
        }
    }
}
