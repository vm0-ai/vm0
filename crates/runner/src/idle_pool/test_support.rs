use std::sync::Arc;

use sandbox::{DeviceRateLimits, Sandbox, SandboxFactory, SandboxId};
use sandbox_mock::{MockSandbox, MockSandboxFactory};

use crate::executor::RestoredSessionIdentity;
use crate::resource_budget::BudgetLease;
use crate::storage_fingerprints::StorageFingerprints;
use crate::workspace_image_cache::WorkspaceImagePromotionContext;

use super::{IdleSandboxMetadata, IdleSandboxResources, ParkedIdleCandidate};

const DEFAULT_PROFILE_NAME: &str = "vm0/default";
const DEFAULT_SOURCE_IP: &str = "10.0.0.1";
const DEFAULT_SANDBOX_NAME: &str = "idle-test";

pub(crate) struct ParkedIdleCandidateBuilder {
    sandbox: Box<dyn Sandbox>,
    factory: Arc<Box<dyn SandboxFactory>>,
    cli_agent_session_id: String,
    sandbox_id: SandboxId,
    profile_name: String,
    device_rate_limits: Option<DeviceRateLimits>,
    budget_lease: BudgetLease,
    source_ip: String,
    storage_fingerprints: StorageFingerprints,
    restored_session_identity: Option<RestoredSessionIdentity>,
    last_completed_at: Option<String>,
    workspace_promotion: Option<WorkspaceImagePromotionContext>,
}

impl ParkedIdleCandidateBuilder {
    pub(crate) fn new(
        session_id: impl Into<String>,
        budget_lease: BudgetLease,
    ) -> ParkedIdleCandidateBuilder {
        Self {
            sandbox: Box::new(MockSandbox::new(DEFAULT_SANDBOX_NAME)),
            factory: Arc::new(Box::new(MockSandboxFactory::new()) as Box<dyn SandboxFactory>),
            cli_agent_session_id: session_id.into(),
            sandbox_id: SandboxId::new_v4(),
            profile_name: DEFAULT_PROFILE_NAME.into(),
            device_rate_limits: None,
            budget_lease,
            source_ip: DEFAULT_SOURCE_IP.into(),
            storage_fingerprints: StorageFingerprints::default(),
            restored_session_identity: None,
            last_completed_at: None,
            workspace_promotion: None,
        }
    }

    pub(crate) fn with_sandbox(mut self, sandbox: Box<dyn Sandbox>) -> Self {
        self.sandbox = sandbox;
        self
    }

    pub(crate) fn with_mock_sandbox_name(mut self, name: &str) -> Self {
        self.sandbox = Box::new(MockSandbox::new(name));
        self
    }

    pub(crate) fn with_factory(mut self, factory: Arc<Box<dyn SandboxFactory>>) -> Self {
        self.factory = factory;
        self
    }

    pub(crate) fn with_sandbox_id(mut self, sandbox_id: SandboxId) -> Self {
        self.sandbox_id = sandbox_id;
        self
    }

    pub(crate) fn with_profile_name(mut self, profile_name: impl Into<String>) -> Self {
        self.profile_name = profile_name.into();
        self
    }

    pub(crate) fn with_source_ip(mut self, source_ip: impl Into<String>) -> Self {
        self.source_ip = source_ip.into();
        self
    }

    pub(crate) fn with_last_completed_at(mut self, last_completed_at: impl Into<String>) -> Self {
        self.last_completed_at = Some(last_completed_at.into());
        self
    }

    pub(crate) fn with_restored_session_identity(
        mut self,
        restored_session_identity: RestoredSessionIdentity,
    ) -> Self {
        self.restored_session_identity = Some(restored_session_identity);
        self
    }

    pub(crate) fn with_workspace_promotion(
        mut self,
        workspace_promotion: WorkspaceImagePromotionContext,
    ) -> Self {
        self.workspace_promotion = Some(workspace_promotion);
        self
    }

    pub(crate) fn build(self) -> ParkedIdleCandidate {
        let Self {
            sandbox,
            factory,
            cli_agent_session_id,
            sandbox_id,
            profile_name,
            device_rate_limits,
            budget_lease,
            source_ip,
            storage_fingerprints,
            restored_session_identity,
            last_completed_at,
            workspace_promotion,
        } = self;
        let mut metadata = IdleSandboxMetadata::new(
            cli_agent_session_id,
            sandbox_id,
            profile_name,
            device_rate_limits,
            source_ip,
            storage_fingerprints,
            restored_session_identity,
        );
        if let Some(last_completed_at) = last_completed_at {
            metadata = metadata.with_last_completed_at(last_completed_at);
        }
        ParkedIdleCandidate {
            resources: IdleSandboxResources {
                sandbox,
                factory,
                workspace_promotion,
            },
            metadata,
            budget_lease,
        }
    }
}
