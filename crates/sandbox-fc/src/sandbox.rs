#![allow(clippy::todo)]

use std::path::PathBuf;

use async_trait::async_trait;
use sandbox::{ExecRequest, ExecResult, ProcessExit, Sandbox, SandboxConfig, SpawnHandle};
use vsock_host::VsockHost;

use crate::config::FirecrackerConfig;
use crate::network::PooledNetns;

pub struct FirecrackerSandbox {
    id: String,
    #[allow(dead_code)]
    config: SandboxConfig,
    #[allow(dead_code)]
    factory_config: FirecrackerConfig,
    workspace: PathBuf,
    #[allow(dead_code)]
    vm_process: Option<tokio::process::Child>,
    #[allow(dead_code)]
    guest: Option<tokio::sync::Mutex<VsockHost>>,
    #[allow(dead_code)]
    network: Option<PooledNetns>,
}

impl FirecrackerSandbox {
    pub(crate) fn new(
        id: String,
        config: SandboxConfig,
        factory_config: FirecrackerConfig,
        workspace: PathBuf,
    ) -> Self {
        Self {
            id,
            config,
            factory_config,
            workspace,
            vm_process: None,
            guest: None,
            network: None,
        }
    }

    pub fn socket_path(&self) -> PathBuf {
        self.workspace.join("firecracker.sock")
    }

    pub fn vsock_path(&self) -> PathBuf {
        self.workspace.join("vm.vsock")
    }

    pub fn config_path(&self) -> PathBuf {
        self.workspace.join("config.json")
    }
}

#[async_trait]
impl Sandbox for FirecrackerSandbox {
    fn id(&self) -> &str {
        &self.id
    }

    async fn start(&mut self) -> sandbox::Result<()> {
        todo!()
    }

    async fn exec(&self, _request: &ExecRequest<'_>) -> sandbox::Result<ExecResult> {
        todo!()
    }

    async fn write_file(&self, _path: &str, _content: &[u8]) -> sandbox::Result<()> {
        todo!()
    }

    async fn spawn_watch(&self, _request: &ExecRequest<'_>) -> sandbox::Result<SpawnHandle> {
        todo!()
    }

    async fn wait_exit(&self, _handle: SpawnHandle) -> sandbox::Result<ProcessExit> {
        todo!()
    }

    async fn stop(&mut self) -> sandbox::Result<()> {
        todo!()
    }

    async fn kill(&mut self) -> sandbox::Result<()> {
        todo!()
    }
}
