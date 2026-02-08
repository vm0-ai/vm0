use std::fs;

use async_trait::async_trait;
use sandbox::{Sandbox, SandboxConfig, SandboxError, SandboxFactory};
use uuid::Uuid;

use crate::config::FirecrackerConfig;
use crate::sandbox::FirecrackerSandbox;

pub struct FirecrackerFactory {
    config: FirecrackerConfig,
}

impl FirecrackerFactory {
    pub fn new(config: FirecrackerConfig) -> Self {
        Self { config }
    }
}

#[async_trait]
impl SandboxFactory for FirecrackerFactory {
    fn name(&self) -> &str {
        "firecracker"
    }

    fn is_available(&self) -> bool {
        which::which(&self.config.binary_path).is_ok()
    }

    async fn create(&self, config: SandboxConfig) -> sandbox::Result<Box<dyn Sandbox>> {
        let id = Uuid::new_v4().to_string();
        let workspace = self.config.workspaces_dir.join(&id);

        fs::create_dir_all(&workspace).map_err(|e| SandboxError::CreationFailed(e.to_string()))?;

        let sandbox = FirecrackerSandbox::new(id, config, self.config.clone(), workspace);

        Ok(Box::new(sandbox))
    }
}
