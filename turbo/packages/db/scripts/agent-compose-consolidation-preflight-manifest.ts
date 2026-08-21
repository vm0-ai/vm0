import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import ts from "typescript";

export const CATALOG_DEPENDENCY_KINDS = [
  "constraints",
  "defaults",
  "foreignKeys",
  "functions",
  "indexes",
  "otherDependents",
  "reviewedNonFk",
  "rewriteDependents",
  "triggers",
] as const;

export type CatalogDependencyKind = (typeof CATALOG_DEPENDENCY_KINDS)[number];

export interface CatalogDependencyRow {
  readonly kind: CatalogDependencyKind;
  readonly entry: string;
}

export interface RepositoryDependencyManifest {
  readonly schemaImports: readonly string[];
  readonly legacyIdentifiers: readonly string[];
  readonly rawTableLiterals: readonly string[];
  readonly nonTypeScriptConsumers: readonly string[];
  readonly transitionValidators: readonly string[];
}

export const EXPECTED_CATALOG_DEPENDENCIES = {
  foreignKeys: [
    "public.agent_compose_versions|agent_compose_versions_compose_id_agent_composes_id_fk|FOREIGN KEY (compose_id) REFERENCES agent_composes(id) ON DELETE SET NULL|validated=true|deferrable=false|initially_deferred=false",
    "public.agent_runs|agent_runs_agent_compose_version_id_agent_compose_versions_id_f|FOREIGN KEY (agent_compose_version_id) REFERENCES agent_compose_versions(id) ON DELETE SET NULL|validated=true|deferrable=false|initially_deferred=false",
    "public.agent_sessions|agent_sessions_agent_compose_id_agent_composes_id_fk|FOREIGN KEY (agent_compose_id) REFERENCES agent_composes(id) ON DELETE CASCADE|validated=true|deferrable=false|initially_deferred=false",
    "public.agentphone_user_agent_preferences|agentphone_user_agent_preferences_selected_compose_id_agent_com|FOREIGN KEY (selected_compose_id) REFERENCES agent_composes(id) ON DELETE SET NULL|validated=true|deferrable=false|initially_deferred=false",
    "public.banking_agent_enablements|banking_agent_enablements_agent_id_zero_agents_id_fk|FOREIGN KEY (agent_id) REFERENCES zero_agents(id) ON DELETE CASCADE|validated=true|deferrable=false|initially_deferred=false",
    "public.chat_threads|chat_threads_agent_compose_id_agent_composes_id_fk|FOREIGN KEY (agent_compose_id) REFERENCES agent_composes(id) ON DELETE CASCADE|validated=true|deferrable=false|initially_deferred=false",
    "public.feishu_org_installations|feishu_org_installations_default_compose_id_agent_composes_id_f|FOREIGN KEY (default_compose_id) REFERENCES agent_composes(id) ON DELETE CASCADE|validated=true|deferrable=false|initially_deferred=false",
    "public.feishu_user_agent_preferences|feishu_user_agent_preferences_selected_compose_id_agent_compose|FOREIGN KEY (selected_compose_id) REFERENCES agent_composes(id) ON DELETE SET NULL|validated=true|deferrable=false|initially_deferred=false",
    "public.github_installations|github_installations_default_compose_id_agent_composes_id_fk|FOREIGN KEY (default_compose_id) REFERENCES agent_composes(id) ON DELETE CASCADE|validated=true|deferrable=false|initially_deferred=false",
    "public.org_metadata|org_metadata_default_agent_id_agent_composes_id_fk|FOREIGN KEY (default_agent_id) REFERENCES agent_composes(id) ON DELETE SET NULL|validated=true|deferrable=false|initially_deferred=false",
    "public.slack_user_agent_preferences|slack_user_agent_preferences_selected_compose_id_agent_composes|FOREIGN KEY (selected_compose_id) REFERENCES agent_composes(id) ON DELETE SET NULL|validated=true|deferrable=false|initially_deferred=false",
    "public.teams_user_agent_preferences|teams_user_agent_preferences_selected_compose_id_agent_composes|FOREIGN KEY (selected_compose_id) REFERENCES agent_composes(id) ON DELETE SET NULL|validated=true|deferrable=false|initially_deferred=false",
    "public.telegram_installations|telegram_installations_default_compose_id_agent_composes_id_fk|FOREIGN KEY (default_compose_id) REFERENCES agent_composes(id) ON DELETE CASCADE|validated=true|deferrable=false|initially_deferred=false",
    "public.telegram_user_agent_preferences|telegram_user_agent_preferences_selected_compose_id_agent_compo|FOREIGN KEY (selected_compose_id) REFERENCES agent_composes(id) ON DELETE SET NULL|validated=true|deferrable=false|initially_deferred=false",
    "public.thread_goals|thread_goals_agent_id_zero_agents_id_fk|FOREIGN KEY (agent_id) REFERENCES zero_agents(id) ON DELETE CASCADE|validated=true|deferrable=false|initially_deferred=false",
    "public.user_connectors|user_connectors_agent_id_zero_agents_id_fk|FOREIGN KEY (agent_id) REFERENCES zero_agents(id) ON DELETE CASCADE|validated=true|deferrable=false|initially_deferred=false",
    "public.user_custom_connectors|user_custom_connectors_agent_id_zero_agents_id_fk|FOREIGN KEY (agent_id) REFERENCES zero_agents(id) ON DELETE CASCADE|validated=true|deferrable=false|initially_deferred=false",
    "public.user_permission_grants|user_permission_grants_agent_id_zero_agents_id_fk|FOREIGN KEY (agent_id) REFERENCES zero_agents(id) ON DELETE CASCADE|validated=true|deferrable=false|initially_deferred=false",
    "public.zero_agent_drafts|zero_agent_drafts_agent_id_zero_agents_id_fk|FOREIGN KEY (agent_id) REFERENCES zero_agents(id) ON DELETE CASCADE|validated=true|deferrable=false|initially_deferred=false",
    "public.zero_agents|zero_agents_id_agent_composes_id_fk|FOREIGN KEY (id) REFERENCES agent_composes(id) ON DELETE CASCADE|validated=true|deferrable=false|initially_deferred=false",
    "public.zero_workflows|zero_workflows_agent_id_zero_agents_id_fk|FOREIGN KEY (agent_id) REFERENCES zero_agents(id) ON DELETE CASCADE|validated=true|deferrable=false|initially_deferred=false",
  ],
  constraints: [
    "public.agent_compose_versions|agent_compose_versions_compose_id_agent_composes_id_fk|type=f|FOREIGN KEY (compose_id) REFERENCES agent_composes(id) ON DELETE SET NULL|validated=true|deferrable=false|initially_deferred=false",
    "public.agent_compose_versions|agent_compose_versions_pkey|type=p|PRIMARY KEY (id)|validated=true|deferrable=false|initially_deferred=false",
    "public.agent_compose_versions|content|type=n|NOT NULL",
    "public.agent_compose_versions|created_at|type=n|NOT NULL",
    "public.agent_compose_versions|id|type=n|NOT NULL",
    "public.agent_composes|agent_composes_pkey|type=p|PRIMARY KEY (id)|validated=true|deferrable=false|initially_deferred=false",
    "public.agent_composes|created_at|type=n|NOT NULL",
    "public.agent_composes|id|type=n|NOT NULL",
    "public.agent_composes|name|type=n|NOT NULL",
    "public.agent_composes|org_id|type=n|NOT NULL",
    "public.agent_composes|updated_at|type=n|NOT NULL",
    "public.agent_composes|user_id|type=n|NOT NULL",
    "public.zero_agents|created_at|type=n|NOT NULL",
    "public.zero_agents|id|type=n|NOT NULL",
    "public.zero_agents|name|type=n|NOT NULL",
    "public.zero_agents|org_id|type=n|NOT NULL",
    "public.zero_agents|owner|type=n|NOT NULL",
    "public.zero_agents|prefer_personal_provider|type=n|NOT NULL",
    "public.zero_agents|updated_at|type=n|NOT NULL",
    "public.zero_agents|visibility|type=n|NOT NULL",
    "public.zero_agents|zero_agents_id_agent_composes_id_fk|type=f|FOREIGN KEY (id) REFERENCES agent_composes(id) ON DELETE CASCADE|validated=true|deferrable=false|initially_deferred=false",
    "public.zero_agents|zero_agents_model_provider_id_model_providers_id_fk|type=f|FOREIGN KEY (model_provider_id) REFERENCES model_providers(id) ON DELETE SET NULL|validated=true|deferrable=false|initially_deferred=false",
    "public.zero_agents|zero_agents_pkey|type=p|PRIMARY KEY (id)|validated=true|deferrable=false|initially_deferred=false",
  ],
  reviewedNonFk: [
    "public.agent_composes|head_version_id|character varying(64)|nullable=true",
    "public.agentphone_messages|agentphone_agent_id|character varying(255)|nullable=false",
    "public.banking_access_audit_events|agent_id|uuid|nullable=true",
    "public.chat_agent_run_context|source_agent_id|uuid|nullable=false",
    "public.chat_agentphone_context|agentphone_agent_id|text|nullable=true",
    "public.chat_event_search_messages|agent_compose_id|uuid|nullable=false",
    "public.chat_thread_events|agent_compose_id|uuid|nullable=false",
    "public.checkpoints|agent_compose_snapshot|jsonb|nullable=true",
    "public.connector_external_code_sessions|agent_id|uuid|nullable=true",
    "public.connector_oauth_device_authorization_sessions|agent_id|uuid|nullable=true",
    "public.connector_oauth_states|agent_id|uuid|nullable=true",
    "public.storages|head_version_id|character varying(64)|nullable=true",
  ],
  defaults: [
    "public.agent_compose_versions|created_at|now()",
    "public.agent_composes|created_at|now()",
    "public.agent_composes|id|gen_random_uuid()",
    "public.agent_composes|name|''::character varying",
    "public.agent_composes|updated_at|now()",
    "public.zero_agents|created_at|now()",
    "public.zero_agents|prefer_personal_provider|false",
    "public.zero_agents|updated_at|now()",
    "public.zero_agents|visibility|'public'::character varying",
  ],
  indexes: [
    "public.agent_compose_versions|agent_compose_versions_pkey|CREATE UNIQUE INDEX agent_compose_versions_pkey ON public.agent_compose_versions USING btree (id)|valid=true|ready=true",
    "public.agent_compose_versions|idx_agent_compose_versions_compose_id|CREATE INDEX idx_agent_compose_versions_compose_id ON public.agent_compose_versions USING btree (compose_id)|valid=true|ready=true",
    "public.agent_composes|agent_composes_pkey|CREATE UNIQUE INDEX agent_composes_pkey ON public.agent_composes USING btree (id)|valid=true|ready=true",
    "public.agent_composes|idx_agent_composes_org_name|CREATE UNIQUE INDEX idx_agent_composes_org_name ON public.agent_composes USING btree (org_id, name)|valid=true|ready=true",
    "public.agent_composes|idx_agent_composes_org|CREATE INDEX idx_agent_composes_org ON public.agent_composes USING btree (org_id)|valid=true|ready=true",
    "public.agent_sessions|idx_agent_sessions_user_compose|CREATE INDEX idx_agent_sessions_user_compose ON public.agent_sessions USING btree (user_id, agent_compose_id)|valid=true|ready=true",
    "public.banking_agent_enablements|idx_banking_agent_enablements_agent_user|CREATE INDEX idx_banking_agent_enablements_agent_user ON public.banking_agent_enablements USING btree (agent_id, user_id)|valid=true|ready=true",
    "public.banking_agent_enablements|idx_banking_agent_enablements_unique|CREATE UNIQUE INDEX idx_banking_agent_enablements_unique ON public.banking_agent_enablements USING btree (org_id, user_id, agent_id, connection_id)|valid=true|ready=true",
    "public.chat_event_search_messages|chat_event_search_messages_user_org_agent_created_idx|CREATE INDEX chat_event_search_messages_user_org_agent_created_idx ON public.chat_event_search_messages USING btree (user_id, org_id, agent_compose_id, created_at DESC NULLS LAST)|valid=true|ready=true",
    "public.chat_threads|idx_chat_threads_user_compose_last_message|CREATE INDEX idx_chat_threads_user_compose_last_message ON public.chat_threads USING btree (user_id, agent_compose_id, last_message_at DESC NULLS LAST)|valid=true|ready=true",
    "public.chat_threads|idx_chat_threads_user_compose_pinned|CREATE INDEX idx_chat_threads_user_compose_pinned ON public.chat_threads USING btree (user_id, agent_compose_id) WHERE (pinned_at IS NOT NULL)|valid=true|ready=true",
    "public.chat_threads|idx_chat_threads_user_compose_updated|CREATE INDEX idx_chat_threads_user_compose_updated ON public.chat_threads USING btree (user_id, agent_compose_id, updated_at DESC NULLS LAST)|valid=true|ready=true",
    "public.user_connectors|idx_user_connectors_agent_user|CREATE INDEX idx_user_connectors_agent_user ON public.user_connectors USING btree (agent_id, user_id)|valid=true|ready=true",
    "public.user_connectors|idx_user_connectors_unique_slug|CREATE UNIQUE INDEX idx_user_connectors_unique_slug ON public.user_connectors USING btree (org_id, user_id, agent_id, connector_slug)|valid=true|ready=true",
    "public.user_custom_connectors|idx_user_custom_connectors_agent_user|CREATE INDEX idx_user_custom_connectors_agent_user ON public.user_custom_connectors USING btree (agent_id, user_id)|valid=true|ready=true",
    "public.user_custom_connectors|idx_user_custom_connectors_unique|CREATE UNIQUE INDEX idx_user_custom_connectors_unique ON public.user_custom_connectors USING btree (org_id, user_id, agent_id, custom_connector_id)|valid=true|ready=true",
    "public.user_permission_grants|idx_user_permission_grants_agent_id|CREATE INDEX idx_user_permission_grants_agent_id ON public.user_permission_grants USING btree (agent_id)|valid=true|ready=true",
    "public.user_permission_grants|idx_user_permission_grants_lookup|CREATE INDEX idx_user_permission_grants_lookup ON public.user_permission_grants USING btree (org_id, user_id, agent_id)|valid=true|ready=true",
    "public.user_permission_grants|uq_user_permission_grants_slug_permission|CREATE UNIQUE INDEX uq_user_permission_grants_slug_permission ON public.user_permission_grants USING btree (org_id, user_id, agent_id, connector_slug, permission)|valid=true|ready=true",
    "public.zero_agent_drafts|idx_zero_agent_drafts_user_org_agent|CREATE UNIQUE INDEX idx_zero_agent_drafts_user_org_agent ON public.zero_agent_drafts USING btree (user_id, org_id, agent_id)|valid=true|ready=true",
    "public.zero_agents|idx_zero_agents_org_name|CREATE UNIQUE INDEX idx_zero_agents_org_name ON public.zero_agents USING btree (org_id, name)|valid=true|ready=true",
    "public.zero_agents|idx_zero_agents_org|CREATE INDEX idx_zero_agents_org ON public.zero_agents USING btree (org_id)|valid=true|ready=true",
    "public.zero_agents|zero_agents_pkey|CREATE UNIQUE INDEX zero_agents_pkey ON public.zero_agents USING btree (id)|valid=true|ready=true",
    "public.zero_workflows|idx_zero_workflows_agent|CREATE INDEX idx_zero_workflows_agent ON public.zero_workflows USING btree (agent_id, name)|valid=true|ready=true",
    "public.zero_workflows|idx_zero_workflows_private_owner_agent_name_unique|CREATE UNIQUE INDEX idx_zero_workflows_private_owner_agent_name_unique ON public.zero_workflows USING btree (org_id, agent_id, owner_user_id, name) WHERE ((visibility)::text = 'private'::text)|valid=true|ready=true",
    "public.zero_workflows|idx_zero_workflows_public_agent_name_unique|CREATE UNIQUE INDEX idx_zero_workflows_public_agent_name_unique ON public.zero_workflows USING btree (org_id, agent_id, name) WHERE ((visibility)::text = 'public'::text)|valid=true|ready=true",
  ],
  triggers: [
    "public.agent_compose_versions|agent_compose_versions_delete_veto|CREATE TRIGGER agent_compose_versions_delete_veto BEFORE DELETE ON public.agent_compose_versions FOR EACH STATEMENT EXECUTE FUNCTION veto_agent_compose_version_delete_transition()|enabled=O",
    "public.agent_compose_versions|agent_compose_versions_write_provenance|CREATE TRIGGER agent_compose_versions_write_provenance BEFORE INSERT OR UPDATE OF created_by ON public.agent_compose_versions FOR EACH ROW EXECUTE FUNCTION enforce_agent_compose_version_write_transition()|enabled=O",
    "public.agent_composes|agent_composes_delete_lock_timeout_transition|CREATE TRIGGER agent_composes_delete_lock_timeout_transition BEFORE DELETE ON public.agent_composes FOR EACH STATEMENT EXECUTE FUNCTION set_agent_compose_delete_lock_timeout_transition()|enabled=O",
    "public.users|users_clerk_cleanup_transition_guard|CREATE TRIGGER users_clerk_cleanup_transition_guard BEFORE DELETE ON public.users FOR EACH STATEMENT EXECUTE FUNCTION guard_clerk_user_cleanup_transition()|enabled=O",
    "public.zero_agents|bridge_zero_agent_default_avatar_0927|CREATE TRIGGER bridge_zero_agent_default_avatar_0927 BEFORE INSERT ON public.zero_agents FOR EACH ROW EXECUTE FUNCTION bridge_zero_agent_default_avatar_0927()|enabled=O",
  ],
  functions: [
    "public.bridge_zero_agent_default_avatar_0927()|kind=f|result=trigger|language=plpgsql|volatility=v|security_definer=false|body_md5=b93914b9cf86141a4b0b4b803a3bfe6f",
    "public.enforce_agent_compose_version_write_transition()|kind=f|result=trigger|language=plpgsql|volatility=v|security_definer=false|body_md5=7acddca0ae85d270f257cb5518ff3bda",
    "public.guard_clerk_user_cleanup_transition()|kind=f|result=trigger|language=plpgsql|volatility=v|security_definer=false|body_md5=c801cd71b6f37934943027f281cabc51",
    "public.set_agent_compose_delete_lock_timeout_transition()|kind=f|result=trigger|language=plpgsql|volatility=v|security_definer=false|body_md5=b3f0552e3f7bbb14443665ea8e312427",
    "public.veto_agent_compose_version_delete_transition()|kind=f|result=trigger|language=plpgsql|volatility=v|security_definer=false|body_md5=186bcd97e887d8c241cfba4c810a47d5",
  ],
  otherDependents: [],
  rewriteDependents: [],
} as const satisfies Record<CatalogDependencyKind, readonly string[]>;

export const EXPECTED_REPOSITORY_DEPENDENCIES = {
  schemaImports: [
    "turbo/apps/api/src/signals/routes/agent-instructions.ts|@okouai/db/schema/agent-compose|agentComposes:agentComposes",
    "turbo/apps/api/src/signals/routes/agent-instructions.ts|@okouai/db/schema/zero-agent|zeroAgents:zeroAgents",
    "turbo/apps/api/src/signals/routes/agents.ts|@okouai/db/schema/agent-compose|agentComposes:agentComposes",
    "turbo/apps/api/src/signals/routes/agents.ts|@okouai/db/schema/zero-agent|zeroAgents:zeroAgents",
    "turbo/apps/api/src/signals/routes/chat-threads-mark-agent-read.ts|@okouai/db/schema/zero-agent|zeroAgents:zeroAgents",
    "turbo/apps/api/src/signals/routes/cli-auth-test.ts|@okouai/db/schema/agent-compose|agentComposes:agentComposes",
    "turbo/apps/api/src/signals/routes/cli-auth-test.ts|@okouai/db/schema/zero-agent|zeroAgents:zeroAgents",
    "turbo/apps/api/src/signals/routes/integrations-slack.ts|@okouai/db/schema/agent-compose|agentComposeVersions:agentComposeVersions,agentComposes:agentComposes",
    "turbo/apps/api/src/signals/routes/integrations-telegram-bot-id.ts|@okouai/db/schema/agent-compose|agentComposes:agentComposes",
    "turbo/apps/api/src/signals/routes/integrations-telegram-link.ts|@okouai/db/schema/agent-compose|agentComposes:agentComposes",
    "turbo/apps/api/src/signals/routes/workflows.ts|@okouai/db/schema/zero-agent|zeroAgents:zeroAgents",
    "turbo/apps/api/src/signals/services/agent-compose-provenance-lifecycle.service.ts|@okouai/db/schema/agent-compose|agentComposes:agentComposes",
    "turbo/apps/api/src/signals/services/agent-compose.service.ts|@okouai/db/schema/agent-compose|agentComposeVersions:agentComposeVersions,agentComposes:agentComposes",
    "turbo/apps/api/src/signals/services/agent-data.service.ts|@okouai/db/schema/agent-compose|agentComposes:agentComposes",
    "turbo/apps/api/src/signals/services/agent-data.service.ts|@okouai/db/schema/zero-agent|zeroAgents:zeroAgents",
    "turbo/apps/api/src/signals/services/agent-instructions.service.ts|@okouai/db/schema/agent-compose|agentComposeVersions:agentComposeVersions,agentComposes:agentComposes",
    "turbo/apps/api/src/signals/services/agent-instructions.service.ts|@okouai/db/schema/zero-agent|zeroAgents:zeroAgents",
    "turbo/apps/api/src/signals/services/agent-run-create.service.ts|@okouai/db/schema/agent-compose|agentComposeVersions:agentComposeVersions,agentComposes:agentComposes",
    "turbo/apps/api/src/signals/services/agent-runs.service.ts|@okouai/db/schema/agent-compose|agentComposes:agentComposes",
    "turbo/apps/api/src/signals/services/agent-runs.service.ts|@okouai/db/schema/zero-agent|zeroAgents:zeroAgents",
    "turbo/apps/api/src/signals/services/agentphone-shared.service.ts|@okouai/db/schema/agent-compose|agentComposes:agentComposes",
    "turbo/apps/api/src/signals/services/agentphone-shared.service.ts|@okouai/db/schema/zero-agent|zeroAgents:zeroAgents",
    "turbo/apps/api/src/signals/services/agentphone.service.ts|@okouai/db/schema/agent-compose|agentComposes:agentComposes",
    "turbo/apps/api/src/signals/services/agentphone.service.ts|@okouai/db/schema/zero-agent|zeroAgents:zeroAgents",
    "turbo/apps/api/src/signals/services/browser.service.ts|@okouai/db/schema/agent-compose|agentComposes:agentComposes",
    "turbo/apps/api/src/signals/services/chat-events.command.ts|@okouai/db/schema/zero-agent|zeroAgents:zeroAgents",
    "turbo/apps/api/src/signals/services/chat-goal-queue.service.ts|@okouai/db/schema/zero-agent|zeroAgents:zeroAgents",
    "turbo/apps/api/src/signals/services/chat-search.service.ts|@okouai/db/schema/agent-compose|agentComposes:agentComposes",
    "turbo/apps/api/src/signals/services/chat-thread-connector-selection.service.ts|@okouai/db/schema/agent-compose|agentComposes:agentComposes",
    "turbo/apps/api/src/signals/services/chat-thread-event.service.ts|@okouai/db/schema/agent-compose|agentComposes:agentComposes",
    "turbo/apps/api/src/signals/services/chat-thread.service.ts|@okouai/db/schema/zero-agent|zeroAgents:zeroAgents",
    "turbo/apps/api/src/signals/services/compose-data.service.ts|@okouai/db/schema/agent-compose|agentComposeVersions:agentComposeVersions,agentComposes:agentComposes",
    "turbo/apps/api/src/signals/services/connected-connector-authorization.service.ts|@okouai/db/schema/agent-compose|agentComposes:agentComposes",
    "turbo/apps/api/src/signals/services/connected-connector-authorization.service.ts|@okouai/db/schema/zero-agent|zeroAgents:zeroAgents",
    "turbo/apps/api/src/signals/services/cron-cleanup-sandboxes.service.ts|@okouai/db/schema/agent-compose|agentComposes:agentComposes",
    "turbo/apps/api/src/signals/services/cron-compact-chat-thread-snapshots.service.ts|@okouai/db/schema/agent-compose|agentComposes:agentComposes",
    "turbo/apps/api/src/signals/services/cron-project-chat-event-search.service.ts|@okouai/db/schema/agent-compose|agentComposes:agentComposes",
    "turbo/apps/api/src/signals/services/feishu-connect.service.ts|@okouai/db/schema/zero-agent|zeroAgents:zeroAgents",
    "turbo/apps/api/src/signals/services/feishu-dispatch.service.ts|@okouai/db/schema/zero-agent|zeroAgents:zeroAgents",
    "turbo/apps/api/src/signals/services/feishu-welcome.service.ts|@okouai/db/schema/zero-agent|zeroAgents:zeroAgents",
    "turbo/apps/api/src/signals/services/github-agent-reply-footer.service.ts|@okouai/db/schema/agent-compose|agentComposes:agentComposes",
    "turbo/apps/api/src/signals/services/github-agent-reply-footer.service.ts|@okouai/db/schema/zero-agent|zeroAgents:zeroAgents",
    "turbo/apps/api/src/signals/services/github-oauth.service.ts|@okouai/db/schema/agent-compose|agentComposes:agentComposes",
    "turbo/apps/api/src/signals/services/integration-agent-response-presentation.service.ts|@okouai/db/schema/zero-agent|zeroAgents:zeroAgents",
    "turbo/apps/api/src/signals/services/internal-chat-run-callback.service.ts|@okouai/db/schema/zero-agent|zeroAgents:zeroAgents",
    "turbo/apps/api/src/signals/services/internal-slack-chat-run-callback.service.ts|@okouai/db/schema/zero-agent|zeroAgents:zeroAgents",
    "turbo/apps/api/src/signals/services/internal-teams-chat-run-callback.service.ts|@okouai/db/schema/zero-agent|zeroAgents:zeroAgents",
    "turbo/apps/api/src/signals/services/logs.service.ts|@okouai/db/schema/agent-compose|agentComposeVersions:agentComposeVersions,agentComposes:agentComposes",
    "turbo/apps/api/src/signals/services/logs.service.ts|@okouai/db/schema/zero-agent|zeroAgents:zeroAgents",
    "turbo/apps/api/src/signals/services/mail-draft.service.ts|@okouai/db/schema/agent-compose|agentComposes:agentComposes",
    "turbo/apps/api/src/signals/services/morning-brief-collect.service.ts|@okouai/db/schema/agent-compose|agentComposes:agentComposes",
    "turbo/apps/api/src/signals/services/onboarding.service.ts|@okouai/db/schema/agent-compose|agentComposes:agentComposes",
    "turbo/apps/api/src/signals/services/onboarding.service.ts|@okouai/db/schema/zero-agent|zeroAgents:zeroAgents",
    "turbo/apps/api/src/signals/services/org-limited-free-bootstrap.service.ts|@okouai/db/schema/agent-compose|agentComposes:agentComposes",
    "turbo/apps/api/src/signals/services/org-limited-free-bootstrap.service.ts|@okouai/db/schema/zero-agent|zeroAgents:zeroAgents",
    "turbo/apps/api/src/signals/services/shared-thread.service.ts|@okouai/db/schema/agent-compose|agentComposes:agentComposes",
    "turbo/apps/api/src/signals/services/slack-connect.service.ts|@okouai/db/schema/agent-compose|agentComposes:agentComposes",
    "turbo/apps/api/src/signals/services/slack-connect.service.ts|@okouai/db/schema/zero-agent|zeroAgents:zeroAgents",
    "turbo/apps/api/src/signals/services/slack-data.service.ts|@okouai/db/schema/zero-agent|zeroAgents:zeroAgents",
    "turbo/apps/api/src/signals/services/slack-message-context.service.ts|@okouai/db/schema/zero-agent|zeroAgents:zeroAgents",
    "turbo/apps/api/src/signals/services/slack-webhooks.service.ts|@okouai/db/schema/zero-agent|zeroAgents:zeroAgents",
    "turbo/apps/api/src/signals/services/teams-connect.service.ts|@okouai/db/schema/agent-compose|agentComposeVersions:agentComposeVersions,agentComposes:agentComposes",
    "turbo/apps/api/src/signals/services/teams-connect.service.ts|@okouai/db/schema/zero-agent|zeroAgents:zeroAgents",
    "turbo/apps/api/src/signals/services/teams-dispatch.service.ts|@okouai/db/schema/zero-agent|zeroAgents:zeroAgents",
    "turbo/apps/api/src/signals/services/telegram-data.service.ts|@okouai/db/schema/agent-compose|agentComposeVersions:agentComposeVersions,agentComposes:agentComposes",
    "turbo/apps/api/src/signals/services/telegram-footer.service.ts|@okouai/db/schema/agent-compose|agentComposes:agentComposes",
    "turbo/apps/api/src/signals/services/telegram-footer.service.ts|@okouai/db/schema/zero-agent|zeroAgents:zeroAgents",
    "turbo/apps/api/src/signals/services/telegram-post.service.ts|@okouai/db/schema/agent-compose|agentComposes:agentComposes",
    "turbo/apps/api/src/signals/services/telegram-post.service.ts|@okouai/db/schema/zero-agent|zeroAgents:zeroAgents",
    "turbo/apps/api/src/signals/services/user-connectors.service.ts|@okouai/db/schema/agent-compose|agentComposes:agentComposes",
    "turbo/apps/api/src/signals/services/user-connectors.service.ts|@okouai/db/schema/zero-agent|zeroAgents:zeroAgents",
    "turbo/apps/api/src/signals/services/user-export.service.ts|@okouai/db/schema/agent-compose|agentComposes:agentComposes",
    "turbo/apps/api/src/signals/services/user-permission-grants.service.ts|@okouai/db/schema/zero-agent|zeroAgents:zeroAgents",
    "turbo/apps/api/src/signals/services/webhooks-clerk-cleanup.service.ts|@okouai/db/schema/agent-compose|agentComposeVersions:agentComposeVersions",
    "turbo/apps/api/src/signals/services/webhooks-clerk-cleanup.service.ts|@okouai/db/schema/zero-agent|zeroAgents:zeroAgents",
    "turbo/apps/api/src/signals/services/workflow-automation.service.ts|@okouai/db/schema/zero-agent|zeroAgents:zeroAgents",
    "turbo/apps/api/src/signals/services/workflow-data.service.ts|@okouai/db/schema/zero-agent|zeroAgents:zeroAgents",
    "turbo/apps/api/src/signals/services/zero-runs-create.service.ts|@okouai/db/schema/agent-compose|agentComposeVersions:agentComposeVersions,agentComposes:agentComposes",
    "turbo/apps/api/src/signals/services/zero-runs-create.service.ts|@okouai/db/schema/zero-agent|zeroAgents:zeroAgents",
    "turbo/packages/db/src/schema/agent-draft.ts|./zero-agent|zeroAgents:zeroAgents",
    "turbo/packages/db/src/schema/agent-run-session-conversation.ts|./agent-compose|agentComposeVersions:agentComposeVersions,agentComposes:agentComposes",
    "turbo/packages/db/src/schema/agentphone-user-agent-preference.ts|./agent-compose|agentComposes:agentComposes",
    "turbo/packages/db/src/schema/banking.ts|./zero-agent|zeroAgents:zeroAgents",
    "turbo/packages/db/src/schema/chat-thread.ts|./agent-compose|agentComposes:agentComposes",
    "turbo/packages/db/src/schema/feishu-org-installation.ts|./agent-compose|agentComposes:agentComposes",
    "turbo/packages/db/src/schema/feishu-user-agent-preference.ts|./agent-compose|agentComposes:agentComposes",
    "turbo/packages/db/src/schema/github-installation.ts|./agent-compose|agentComposes:agentComposes",
    "turbo/packages/db/src/schema/org-metadata.ts|./agent-compose|agentComposes:agentComposes",
    "turbo/packages/db/src/schema/slack-user-agent-preference.ts|./agent-compose|agentComposes:agentComposes",
    "turbo/packages/db/src/schema/teams-user-agent-preference.ts|./agent-compose|agentComposes:agentComposes",
    "turbo/packages/db/src/schema/telegram-installation.ts|./agent-compose|agentComposes:agentComposes",
    "turbo/packages/db/src/schema/telegram-user-agent-preference.ts|./agent-compose|agentComposes:agentComposes",
    "turbo/packages/db/src/schema/thread-goal.ts|./zero-agent|zeroAgents:zeroAgents",
    "turbo/packages/db/src/schema/user-connector.ts|./zero-agent|zeroAgents:zeroAgents",
    "turbo/packages/db/src/schema/user-custom-connector.ts|./zero-agent|zeroAgents:zeroAgents",
    "turbo/packages/db/src/schema/user-permission-grant.ts|./zero-agent|zeroAgents:zeroAgents",
    "turbo/packages/db/src/schema/workflow.ts|./zero-agent|zeroAgents:zeroAgents",
    "turbo/packages/db/src/schema/zero-agent.ts|./agent-compose|agentComposes:agentComposes",
  ],
  legacyIdentifiers: [
    "turbo/apps/api/src/signals/routes/agent-instructions.ts|agentComposeId,agentComposes,zeroAgents",
    "turbo/apps/api/src/signals/routes/agents.ts|agentComposeId,agentComposes,headVersionId,zeroAgents",
    "turbo/apps/api/src/signals/routes/chat-threads-computer-use-host.ts|agentComposeId",
    "turbo/apps/api/src/signals/routes/chat-threads-create.ts|agentComposeId",
    "turbo/apps/api/src/signals/routes/chat-threads-get.ts|agentComposeId",
    "turbo/apps/api/src/signals/routes/chat-threads-image-model.ts|agentComposeId",
    "turbo/apps/api/src/signals/routes/chat-threads-mark-agent-read.ts|agentComposeId,zeroAgents",
    "turbo/apps/api/src/signals/routes/chat-threads-mark-read.ts|agentComposeId",
    "turbo/apps/api/src/signals/routes/chat-threads-mark-unread.ts|agentComposeId",
    "turbo/apps/api/src/signals/routes/chat-threads-model-selection.ts|agentComposeId",
    "turbo/apps/api/src/signals/routes/chat-threads-pin.ts|agentComposeId",
    "turbo/apps/api/src/signals/routes/chat-threads-rename.ts|agentComposeId",
    "turbo/apps/api/src/signals/routes/chat-threads-unpin.ts|agentComposeId",
    "turbo/apps/api/src/signals/routes/chat-threads-video-model.ts|agentComposeId",
    "turbo/apps/api/src/signals/routes/chat-threads.ts|agentComposeId",
    "turbo/apps/api/src/signals/routes/cli-auth-test.ts|agentComposes,zeroAgents",
    "turbo/apps/api/src/signals/routes/integrations-slack.ts|agentComposeVersions,agentComposes,headVersionId",
    "turbo/apps/api/src/signals/routes/integrations-telegram-bot-id.ts|agentComposes",
    "turbo/apps/api/src/signals/routes/integrations-telegram-link.ts|agentComposes",
    "turbo/apps/api/src/signals/routes/runners.ts|agentComposeId,agentComposeVersionId",
    "turbo/apps/api/src/signals/routes/workflows.ts|agentComposeId,zeroAgents",
    "turbo/apps/api/src/signals/services/agent-compose-provenance-lifecycle.service.ts|agentComposes",
    "turbo/apps/api/src/signals/services/agent-compose.service.ts|agentComposeId,agentComposeVersions,agentComposes,headVersionId",
    "turbo/apps/api/src/signals/services/agent-data.service.ts|agentComposes,headVersionId,zeroAgents",
    "turbo/apps/api/src/signals/services/agent-execution-authority.ts|headVersionId",
    "turbo/apps/api/src/signals/services/agent-instructions.service.ts|agentComposeVersions,agentComposes,headVersionId,zeroAgents",
    "turbo/apps/api/src/signals/services/agent-run-create.service.ts|agentComposeId,agentComposeVersionId,agentComposeVersions,agentComposes,headVersionId",
    "turbo/apps/api/src/signals/services/agent-run-storage.service.ts|headVersionId",
    "turbo/apps/api/src/signals/services/agent-runs.service.ts|agentComposeId,agentComposeVersionId,agentComposes,zeroAgents",
    "turbo/apps/api/src/signals/services/agentphone-chat-ingress.service.ts|agentComposeId",
    "turbo/apps/api/src/signals/services/agentphone-queued-launch-context.service.ts|agentComposeId",
    "turbo/apps/api/src/signals/services/agentphone-shared.service.ts|agentComposes,zeroAgents",
    "turbo/apps/api/src/signals/services/agentphone.service.ts|agentComposeId,agentComposes,zeroAgents",
    "turbo/apps/api/src/signals/services/banking.service.ts|agentComposeId",
    "turbo/apps/api/src/signals/services/browser-authorization.service.ts|agentComposeId",
    "turbo/apps/api/src/signals/services/browser.service.ts|agentComposeId,agentComposes",
    "turbo/apps/api/src/signals/services/canonical-feishu-ingress-processor.service.ts|agentComposeId",
    "turbo/apps/api/src/signals/services/chat-event-shared.service.ts|agentComposeId",
    "turbo/apps/api/src/signals/services/chat-events.command.ts|agentComposeId,zeroAgents",
    "turbo/apps/api/src/signals/services/chat-goal-queue.service.ts|agentComposeId,zeroAgents",
    "turbo/apps/api/src/signals/services/chat-search.service.ts|agentComposeId,agentComposes",
    "turbo/apps/api/src/signals/services/chat-session-continuity.service.ts|agentComposeId",
    "turbo/apps/api/src/signals/services/chat-thread-connector-selection.service.ts|agentComposeId,agentComposes",
    "turbo/apps/api/src/signals/services/chat-thread-event.service.ts|agentComposeId,agentComposes",
    "turbo/apps/api/src/signals/services/chat-thread-model.service.ts|agentComposeId",
    "turbo/apps/api/src/signals/services/chat-thread.service.ts|agentComposeId,zeroAgents",
    "turbo/apps/api/src/signals/services/chat-title.service.ts|agentComposeId",
    "turbo/apps/api/src/signals/services/compose-data.service.ts|agentComposeId,agentComposeVersions,agentComposes",
    "turbo/apps/api/src/signals/services/computer-use-authorization.service.ts|agentComposeId",
    "turbo/apps/api/src/signals/services/computer-use.service.ts|agentComposeId",
    "turbo/apps/api/src/signals/services/connected-connector-authorization.service.ts|agentComposeId,agentComposes,headVersionId,zeroAgents",
    "turbo/apps/api/src/signals/services/connector-catalog-skill-registration.service.ts|headVersionId,head_version_id",
    "turbo/apps/api/src/signals/services/connector-runtime-wakeup.service.ts|agentComposeId",
    "turbo/apps/api/src/signals/services/cron-cleanup-sandboxes.service.ts|agentComposeId,agentComposes",
    "turbo/apps/api/src/signals/services/cron-compact-chat-thread-snapshots.service.ts|agentComposeId,agentComposes,agent_compose_id",
    "turbo/apps/api/src/signals/services/cron-project-chat-event-search.service.ts|agentComposeId,agentComposes",
    "turbo/apps/api/src/signals/services/cron-steer-run-time-budget.service.ts|agentComposeId",
    "turbo/apps/api/src/signals/services/cron-sync-skills.service.ts|headVersionId",
    "turbo/apps/api/src/signals/services/feishu-chat-ingress.service.ts|agentComposeId",
    "turbo/apps/api/src/signals/services/feishu-connect.service.ts|zeroAgents",
    "turbo/apps/api/src/signals/services/feishu-dispatch.service.ts|zeroAgents",
    "turbo/apps/api/src/signals/services/feishu-welcome.service.ts|zeroAgents",
    "turbo/apps/api/src/signals/services/github-agent-reply-footer.service.ts|agentComposes,zeroAgents",
    "turbo/apps/api/src/signals/services/github-oauth.service.ts|agentComposes",
    "turbo/apps/api/src/signals/services/github-queued-launch-context.service.ts|agentComposeId",
    "turbo/apps/api/src/signals/services/goal.service.ts|agentComposeId",
    "turbo/apps/api/src/signals/services/google-drive-artifact-sync.service.ts|agentComposeId",
    "turbo/apps/api/src/signals/services/historical-product-builder.ts|headVersionId",
    "turbo/apps/api/src/signals/services/integration-agent-response-presentation.service.ts|zeroAgents",
    "turbo/apps/api/src/signals/services/internal-agentphone-chat-run-callback.service.ts|agentComposeId",
    "turbo/apps/api/src/signals/services/internal-chat-run-callback.service.ts|agentComposeId,zeroAgents",
    "turbo/apps/api/src/signals/services/internal-feishu-chat-run-callback.service.ts|agentComposeId",
    "turbo/apps/api/src/signals/services/internal-feishu-org-run-callback.service.ts|agentComposeId",
    "turbo/apps/api/src/signals/services/internal-github-chat-run-callback.service.ts|agentComposeId",
    "turbo/apps/api/src/signals/services/internal-slack-chat-run-callback.service.ts|agentComposeId,zeroAgents",
    "turbo/apps/api/src/signals/services/internal-teams-chat-run-callback.service.ts|agentComposeId,zeroAgents",
    "turbo/apps/api/src/signals/services/internal-telegram-chat-run-callback.service.ts|agentComposeId",
    "turbo/apps/api/src/signals/services/logs.service.ts|agentComposeId,agentComposeVersionId,agentComposeVersions,agentComposes,zeroAgents",
    "turbo/apps/api/src/signals/services/mail-draft.service.ts|agentComposeId,agentComposes",
    "turbo/apps/api/src/signals/services/morning-brief-collect.service.ts|agentComposeId,agentComposes",
    "turbo/apps/api/src/signals/services/onboarding.service.ts|agentComposes,zeroAgents",
    "turbo/apps/api/src/signals/services/org-limited-free-bootstrap.service.ts|agentComposeId,agentComposes,zeroAgents",
    "turbo/apps/api/src/signals/services/run-mcp-connectors.service.ts|agentComposeId",
    "turbo/apps/api/src/signals/services/shared-thread.service.ts|agentComposeId,agentComposes",
    "turbo/apps/api/src/signals/services/slack-chat-ingress.service.ts|agentComposeId",
    "turbo/apps/api/src/signals/services/slack-connect.service.ts|agentComposes,zeroAgents",
    "turbo/apps/api/src/signals/services/slack-data.service.ts|zeroAgents",
    "turbo/apps/api/src/signals/services/slack-message-context.service.ts|agentComposeId,zeroAgents",
    "turbo/apps/api/src/signals/services/slack-webhooks.service.ts|agentComposeId,zeroAgents",
    "turbo/apps/api/src/signals/services/storage-volume-publication.service.ts|headVersionId",
    "turbo/apps/api/src/signals/services/storage-write.service.ts|headVersionId",
    "turbo/apps/api/src/signals/services/teams-chat-ingress.service.ts|agentComposeId",
    "turbo/apps/api/src/signals/services/teams-connect.service.ts|agentComposeVersions,agentComposes,headVersionId,zeroAgents",
    "turbo/apps/api/src/signals/services/teams-dispatch.service.ts|agentComposeId,zeroAgents",
    "turbo/apps/api/src/signals/services/telegram-chat-ingress.service.ts|agentComposeId",
    "turbo/apps/api/src/signals/services/telegram-data.service.ts|agentComposeVersions,agentComposes,headVersionId",
    "turbo/apps/api/src/signals/services/telegram-footer.service.ts|agentComposeId,agentComposes,zeroAgents",
    "turbo/apps/api/src/signals/services/telegram-post.service.ts|agentComposeId,agentComposes,zeroAgents",
    "turbo/apps/api/src/signals/services/telegram-queued-launch-context.service.ts|agentComposeId",
    "turbo/apps/api/src/signals/services/user-connectors.service.ts|agentComposes,zeroAgents",
    "turbo/apps/api/src/signals/services/user-export.service.ts|agentComposes,headVersionId",
    "turbo/apps/api/src/signals/services/user-permission-grants.service.ts|zeroAgents",
    "turbo/apps/api/src/signals/services/webhooks-clerk-cleanup.service.ts|agentComposeVersions,zeroAgents",
    "turbo/apps/api/src/signals/services/workflow-automation.service.ts|zeroAgents",
    "turbo/apps/api/src/signals/services/workflow-data.service.ts|zeroAgents",
    "turbo/apps/api/src/signals/services/workflow-user-automation-thread.service.ts|agentComposeId",
    "turbo/apps/api/src/signals/services/workflow-volume.service.ts|headVersionId",
    "turbo/apps/api/src/signals/services/zero-runs-create.service.ts|agentComposeId,agentComposeVersions,agentComposes,headVersionId,zeroAgents",
    "turbo/apps/platform/src/views/zero-page/zero-telegram-settings-page.tsx|headVersionId",
    "turbo/packages/api-contracts/src/contracts/composes.ts|headVersionId",
    "turbo/packages/api-contracts/src/contracts/runners.ts|agentComposeVersionId",
    "turbo/packages/api-contracts/src/contracts/runs.ts|agentComposeVersionId",
    "turbo/packages/api-contracts/src/contracts/team.ts|headVersionId",
    "turbo/packages/db/src/schema/agent-compose.ts|agentComposeVersions,agentComposes,headVersionId,head_version_id",
    "turbo/packages/db/src/schema/agent-draft.ts|zeroAgents",
    "turbo/packages/db/src/schema/agent-run-session-conversation.ts|agentComposeId,agentComposeVersionId,agentComposeVersions,agentComposes,agent_compose_id,agent_compose_version_id",
    "turbo/packages/db/src/schema/agentphone-user-agent-preference.ts|agentComposes",
    "turbo/packages/db/src/schema/banking.ts|zeroAgents",
    "turbo/packages/db/src/schema/chat-event-search.ts|agentComposeId,agent_compose_id",
    "turbo/packages/db/src/schema/chat-thread-event.ts|agentComposeId,agent_compose_id",
    "turbo/packages/db/src/schema/chat-thread.ts|agentComposeId,agentComposes,agent_compose_id",
    "turbo/packages/db/src/schema/checkpoint.ts|agentComposeSnapshot,agent_compose_snapshot",
    "turbo/packages/db/src/schema/feishu-org-installation.ts|agentComposes",
    "turbo/packages/db/src/schema/feishu-user-agent-preference.ts|agentComposes",
    "turbo/packages/db/src/schema/github-installation.ts|agentComposes",
    "turbo/packages/db/src/schema/org-metadata.ts|agentComposes",
    "turbo/packages/db/src/schema/slack-user-agent-preference.ts|agentComposes",
    "turbo/packages/db/src/schema/storage.ts|headVersionId,head_version_id",
    "turbo/packages/db/src/schema/teams-user-agent-preference.ts|agentComposes",
    "turbo/packages/db/src/schema/telegram-installation.ts|agentComposes",
    "turbo/packages/db/src/schema/telegram-user-agent-preference.ts|agentComposes",
    "turbo/packages/db/src/schema/thread-goal.ts|zeroAgents",
    "turbo/packages/db/src/schema/user-connector.ts|zeroAgents",
    "turbo/packages/db/src/schema/user-custom-connector.ts|zeroAgents",
    "turbo/packages/db/src/schema/user-permission-grant.ts|zeroAgents",
    "turbo/packages/db/src/schema/workflow.ts|zeroAgents",
    "turbo/packages/db/src/schema/zero-agent.ts|agentComposes,zeroAgents",
  ],
  rawTableLiterals: [
    "turbo/apps/api/src/signals/services/agent-compose-provenance-lifecycle.service.ts|agent_compose_versions,agent_composes",
    "turbo/packages/db/src/schema/agent-compose.ts|agent_compose_versions,agent_composes",
    "turbo/packages/db/src/schema/zero-agent.ts|zero_agents",
  ],
  nonTypeScriptConsumers: [
    "crates/api-contracts/src/generated/decode_paths.rs|agentComposeVersionId",
  ],
  transitionValidators: [
    "#27613+#27656+#27671+#27792|agent-compose-consolidation-preflight|removal-owner:#26938-stage-8",
    "#27896|agent-execution-authority-classifier-and-helpers|removal-owner:#26938-stage-8",
    "#27896|application-compose-projection-adapter|removal-owner:#26938-stage-8",
    "#27896|legacy-exception-runtime-path|removal-owner:#26938-stage-8",
    "#27896|run-context-authority-telemetry|removal-owner:#26938-stage-8",
    "#27997|framework-fallback-authority-classification-and-telemetry|removal-owner:#26938-stage-8",
    "#27997|framework-fallback-preflight-partition|removal-owner:#26938-stage-8",
    "#28056|historical-product-builder-classifier-and-variants|removal-owner:#26938-stage-8",
    "#28056|historical-product-builder-preflight-partition|removal-owner:#26938-stage-8",
    "#28070|historical-product-builder-environment-authority-and-telemetry|removal-owner:#26938-stage-8",
    "#28070|historical-product-builder-v6-authority-lineage-partition|removal-owner:#26938-stage-8",
    "#28080|checkpoint-configuration-independence-runtime-manifest|removal-owner:#26938-stage-8",
    "#28080|checkpoint-v7-protected-partition|removal-owner:#26938-stage-8",
    "#28304|usage-pack-pending-snapshot-dirty-upgrade|removal-owner:#28372",
    "#28453|built-in-model-key-relation-compatibility|removal-owner:#28368-relation-contract",
  ],
} as const satisfies RepositoryDependencyManifest;

/**
 * Catalog discovery is structural: constraints, foreign-key
 * keys/actions/validation, reviewed non-target-FK fields, defaults, relevant
 * indexes, rewrite-backed views/materialized views/rules, trigger definitions,
 * and trigger-function bodies all contribute to the manifest. A generic
 * pg_depend inventory catches every other non-internal dependent object.
 * Internal dependencies and owned row types/storage cannot independently
 * survive or block contraction, while their owners are inventoried here.
 */
export const CATALOG_DEPENDENCY_QUERY = `
WITH RECURSIVE target_relations AS (
  SELECT unnest(ARRAY[
    'public.agent_composes'::regclass,
    'public.zero_agents'::regclass,
    'public.agent_compose_versions'::regclass
  ]) AS oid
),
relation_dependency_closure AS (
  SELECT "oid" FROM target_relations
  UNION
  SELECT "rewrite"."ev_class"
  FROM relation_dependency_closure AS "referenced"
  INNER JOIN "pg_depend" AS "dependency"
    ON "dependency"."refclassid" = 'pg_class'::regclass
    AND "dependency"."refobjid" = "referenced"."oid"
    AND "dependency"."classid" = 'pg_rewrite'::regclass
    AND "dependency"."deptype" = 'n'
  INNER JOIN "pg_rewrite" AS "rewrite"
    ON "rewrite"."oid" = "dependency"."objid"
),
relation_dependency_types AS (
  SELECT "relation"."reltype" AS "oid"
  FROM "pg_class" AS "relation"
  WHERE "relation"."oid" IN (
    SELECT "oid" FROM relation_dependency_closure
  )
),
target_fk_columns AS (
  SELECT "conrelid", unnest("conkey") AS "attnum"
  FROM "pg_constraint"
  WHERE "contype" = 'f'
    AND "confrelid" IN (SELECT "oid" FROM target_relations)
),
foreign_keys AS (
  SELECT
    "namespace"."nspname" || '.' || "relation"."relname" || '|' ||
    "constraint"."conname" || '|' ||
    pg_get_constraintdef("constraint"."oid", false) ||
    '|validated=' || "constraint"."convalidated"::text ||
    '|deferrable=' || "constraint"."condeferrable"::text ||
    '|initially_deferred=' || "constraint"."condeferred"::text AS "entry"
  FROM "pg_constraint" AS "constraint"
  INNER JOIN "pg_class" AS "relation"
    ON "relation"."oid" = "constraint"."conrelid"
  INNER JOIN "pg_namespace" AS "namespace"
    ON "namespace"."oid" = "relation"."relnamespace"
  WHERE "constraint"."contype" = 'f'
    AND "constraint"."confrelid" IN (SELECT "oid" FROM target_relations)
),
reviewed_non_fk AS (
  SELECT
    "namespace"."nspname" || '.' || "relation"."relname" || '|' ||
    "attribute"."attname" || '|' ||
    format_type("attribute"."atttypid", "attribute"."atttypmod") ||
    '|nullable=' || (NOT "attribute"."attnotnull")::text AS "entry",
    "attribute"."attrelid" AS "relid",
    "attribute"."attnum" AS "attnum"
  FROM "pg_attribute" AS "attribute"
  INNER JOIN "pg_class" AS "relation"
    ON "relation"."oid" = "attribute"."attrelid"
  INNER JOIN "pg_namespace" AS "namespace"
    ON "namespace"."oid" = "relation"."relnamespace"
  LEFT JOIN target_fk_columns AS "target_fk"
    ON "target_fk"."conrelid" = "attribute"."attrelid"
    AND "target_fk"."attnum" = "attribute"."attnum"
  WHERE "namespace"."nspname" = 'public'
    AND "relation"."relkind" IN ('r', 'p')
    AND "attribute"."attnum" > 0
    AND NOT "attribute"."attisdropped"
    AND "target_fk"."attnum" IS NULL
    AND (
      "attribute"."attname" IN ('agent_compose_snapshot', 'head_version_id')
      OR "attribute"."attname" ~ '(^|_)agent(_compose(_version)?)?_id$'
      OR "attribute"."attname" ~ '(^|_)compose(_version)?_id$'
      OR "attribute"."attname" ~ '(^|_)agentphone_agent_id$'
    )
),
defaults AS (
  SELECT
    "namespace"."nspname" || '.' || "relation"."relname" || '|' ||
    "attribute"."attname" || '|' ||
    pg_get_expr("default"."adbin", "default"."adrelid", false) AS "entry"
  FROM "pg_attrdef" AS "default"
  INNER JOIN "pg_attribute" AS "attribute"
    ON "attribute"."attrelid" = "default"."adrelid"
    AND "attribute"."attnum" = "default"."adnum"
  INNER JOIN "pg_class" AS "relation"
    ON "relation"."oid" = "default"."adrelid"
  INNER JOIN "pg_namespace" AS "namespace"
    ON "namespace"."oid" = "relation"."relnamespace"
  WHERE "default"."adrelid" IN (SELECT "oid" FROM target_relations)
),
dependency_columns AS (
  SELECT "conrelid" AS "relid", unnest("conkey") AS "attnum"
  FROM "pg_constraint"
  WHERE "contype" = 'f'
    AND "confrelid" IN (SELECT "oid" FROM target_relations)
  UNION
  SELECT "relid", "attnum" FROM reviewed_non_fk
),
constraints AS (
  SELECT DISTINCT
    "namespace"."nspname" || '.' || "relation"."relname" || '|' ||
    "constraint"."conname" ||
    '|type=' || "constraint"."contype"::text || '|' ||
    pg_get_constraintdef("constraint"."oid", false) ||
    '|validated=' || "constraint"."convalidated"::text ||
    '|deferrable=' || "constraint"."condeferrable"::text ||
    '|initially_deferred=' || "constraint"."condeferred"::text AS "entry"
  FROM "pg_constraint" AS "constraint"
  INNER JOIN "pg_class" AS "relation"
    ON "relation"."oid" = "constraint"."conrelid"
  INNER JOIN "pg_namespace" AS "namespace"
    ON "namespace"."oid" = "relation"."relnamespace"
  WHERE "constraint"."contype" <> 'n'
    AND (
      "constraint"."conrelid" IN (SELECT "oid" FROM target_relations)
      OR (
        "constraint"."contype" <> 'f'
        AND EXISTS (
          SELECT 1
          FROM dependency_columns AS "column"
          WHERE "column"."relid" = "constraint"."conrelid"
            AND "column"."attnum" = ANY("constraint"."conkey")
        )
      )
    )
  UNION
  SELECT
    "namespace"."nspname" || '.' || "relation"."relname" || '|' ||
    "attribute"."attname" || '|type=n|NOT NULL' AS "entry"
  FROM "pg_attribute" AS "attribute"
  INNER JOIN "pg_class" AS "relation"
    ON "relation"."oid" = "attribute"."attrelid"
  INNER JOIN "pg_namespace" AS "namespace"
    ON "namespace"."oid" = "relation"."relnamespace"
  WHERE "attribute"."attrelid" IN (SELECT "oid" FROM target_relations)
    AND "attribute"."attnum" > 0
    AND NOT "attribute"."attisdropped"
    AND "attribute"."attnotnull"
),
indexes AS (
  SELECT DISTINCT
    "namespace"."nspname" || '.' || "table"."relname" || '|' ||
    "index_class"."relname" || '|' ||
    pg_get_indexdef("index"."indexrelid", 0, false) ||
    '|valid=' || "index"."indisvalid"::text ||
    '|ready=' || "index"."indisready"::text AS "entry"
  FROM "pg_index" AS "index"
  INNER JOIN "pg_class" AS "index_class"
    ON "index_class"."oid" = "index"."indexrelid"
  INNER JOIN "pg_class" AS "table"
    ON "table"."oid" = "index"."indrelid"
  INNER JOIN "pg_namespace" AS "namespace"
    ON "namespace"."oid" = "table"."relnamespace"
  WHERE "index"."indrelid" IN (SELECT "oid" FROM target_relations)
    OR EXISTS (
      SELECT 1
      FROM dependency_columns AS "column"
      WHERE "column"."relid" = "index"."indrelid"
        AND "column"."attnum" = ANY("index"."indkey")
    )
),
triggers AS (
  SELECT
    "namespace"."nspname" || '.' || "relation"."relname" || '|' ||
    "trigger"."tgname" || '|' ||
    pg_get_triggerdef("trigger"."oid", false) ||
    '|enabled=' || "trigger"."tgenabled"::text AS "entry",
    "trigger"."tgfoid" AS "function_oid"
  FROM "pg_trigger" AS "trigger"
  INNER JOIN "pg_class" AS "relation"
    ON "relation"."oid" = "trigger"."tgrelid"
  INNER JOIN "pg_namespace" AS "namespace"
    ON "namespace"."oid" = "relation"."relnamespace"
  INNER JOIN "pg_proc" AS "function"
    ON "function"."oid" = "trigger"."tgfoid"
  WHERE NOT "trigger"."tgisinternal"
    AND (
      "trigger"."tgrelid" IN (SELECT "oid" FROM target_relations)
      OR "trigger"."tgname" IN (
        'users_clerk_cleanup_transition_guard',
        'agent_composes_delete_lock_timeout_transition',
        'agent_compose_versions_delete_veto',
        'agent_compose_versions_write_provenance',
        'bridge_zero_agent_default_avatar_0927'
      )
      OR lower("function"."prosrc") ~
        '(agent_composes|agent_compose_versions|zero_agents)'
    )
),
functions AS (
  SELECT DISTINCT
    "namespace"."nspname" || '.' || "function"."proname" || '(' ||
    pg_get_function_identity_arguments("function"."oid") || ')|' ||
    'kind=' || "function"."prokind"::text ||
    '|result=' || pg_get_function_result("function"."oid") ||
    '|language=' || "language"."lanname" ||
    '|volatility=' || "function"."provolatile"::text ||
    '|security_definer=' || "function"."prosecdef"::text ||
    '|body_md5=' || md5("function"."prosrc") AS "entry"
  FROM "pg_proc" AS "function"
  INNER JOIN "pg_namespace" AS "namespace"
    ON "namespace"."oid" = "function"."pronamespace"
  INNER JOIN "pg_language" AS "language"
    ON "language"."oid" = "function"."prolang"
  WHERE "function"."oid" IN (SELECT "function_oid" FROM triggers)
    OR (
      "namespace"."nspname" = 'public'
      AND lower("function"."prosrc") ~
        '(agent_composes|agent_compose_versions|zero_agents)'
    )
),
rewrite_dependents AS (
  SELECT DISTINCT
    "namespace"."nspname" || '.' || "relation"."relname" ||
    '|relation_kind=' ||
    CASE "relation"."relkind"
      WHEN 'v' THEN 'view'
      WHEN 'm' THEN 'materialized_view'
      ELSE 'relation'
    END ||
    '|rule=' || "rewrite"."rulename" ||
    '|event=' || "rewrite"."ev_type"::text ||
    '|instead=' || "rewrite"."is_instead"::text ||
    '|definition_md5=' || md5(pg_get_ruledef("rewrite"."oid", false)) AS "entry"
  FROM "pg_rewrite" AS "rewrite"
  INNER JOIN "pg_class" AS "relation"
    ON "relation"."oid" = "rewrite"."ev_class"
  INNER JOIN "pg_namespace" AS "namespace"
    ON "namespace"."oid" = "relation"."relnamespace"
  WHERE "rewrite"."ev_class" IN (SELECT "oid" FROM target_relations)
    OR EXISTS (
      SELECT 1
      FROM "pg_depend" AS "dependency"
      INNER JOIN relation_dependency_closure AS "referenced"
        ON "referenced"."oid" = "dependency"."refobjid"
      WHERE "dependency"."classid" = 'pg_rewrite'::regclass
        AND "dependency"."objid" = "rewrite"."oid"
        AND "dependency"."refclassid" = 'pg_class'::regclass
        AND "dependency"."deptype" = 'n'
    )
),
other_dependents AS (
  SELECT DISTINCT
    "dependency"."classid"::regclass::text ||
    '|dependency_type=' || "dependency"."deptype"::text ||
    '|object=' || pg_describe_object(
      "dependency"."classid",
      "dependency"."objid",
      "dependency"."objsubid"
    ) ||
    '|referenced=' || pg_describe_object(
      "dependency"."refclassid",
      "dependency"."refobjid",
      "dependency"."refobjsubid"
    ) AS "entry"
  FROM "pg_depend" AS "dependency"
  LEFT JOIN "pg_class" AS "dependent_relation"
    ON "dependency"."classid" = 'pg_class'::regclass
    AND "dependent_relation"."oid" = "dependency"."objid"
  WHERE (
      (
        "dependency"."refclassid" = 'pg_class'::regclass
        AND "dependency"."refobjid" IN (
          SELECT "oid" FROM relation_dependency_closure
        )
      )
      OR (
        "dependency"."refclassid" = 'pg_type'::regclass
        AND "dependency"."refobjid" IN (
          SELECT "oid" FROM relation_dependency_types
        )
      )
    )
    AND "dependency"."deptype" <> 'i'
    AND "dependency"."classid" NOT IN (
      'pg_attrdef'::regclass,
      'pg_constraint'::regclass,
      'pg_rewrite'::regclass,
      'pg_trigger'::regclass
    )
    AND NOT (
      "dependency"."classid" = 'pg_class'::regclass
      AND "dependent_relation"."relkind" IN ('i', 'I')
    )
)
SELECT 'constraints' AS "kind", "entry" FROM constraints
UNION ALL SELECT 'defaults', "entry" FROM defaults
UNION ALL SELECT 'foreignKeys', "entry" FROM foreign_keys
UNION ALL SELECT 'functions', "entry" FROM functions
UNION ALL SELECT 'indexes', "entry" FROM indexes
UNION ALL SELECT 'otherDependents', "entry" FROM other_dependents
UNION ALL SELECT 'reviewedNonFk', "entry" FROM reviewed_non_fk
UNION ALL SELECT 'rewriteDependents', "entry" FROM rewrite_dependents
UNION ALL SELECT 'triggers', "entry" FROM triggers
ORDER BY "kind", "entry"
`;

const schemaModules = new Set([
  "@okouai/db/schema/agent-compose",
  "@okouai/db/schema/zero-agent",
]);

const legacyIdentifierTokens = new Set([
  "agentComposeId",
  "agentComposeSnapshot",
  "agentComposeVersionId",
  "agentComposeVersions",
  "agentComposes",
  "headVersionId",
  "zeroAgents",
]);

const legacyLiteralTokens = new Set([
  "agent_compose_id",
  "agent_compose_snapshot",
  "agent_compose_version_id",
  "head_version_id",
]);

const rawTableTokens = [
  "agent_composes",
  "agent_compose_versions",
  "zero_agents",
] as const;

const nonTypeScriptExtensions = new Set([
  ".bash",
  ".cjs",
  ".cfg",
  ".env",
  ".js",
  ".json",
  ".mjs",
  ".py",
  ".rs",
  ".sh",
  ".sql",
  ".toml",
  ".tpl",
  ".yaml",
  ".yml",
]);
const nonTypeScriptFileNames = new Set(["Dockerfile", "Makefile"]);

function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function isExcluded(relativePath: string): boolean {
  return (
    relativePath.includes("/node_modules/") ||
    relativePath.includes("/dist/") ||
    relativePath.includes("/.typecheck/") ||
    relativePath.includes("/__tests__/") ||
    relativePath.includes("/__benches__/") ||
    relativePath.includes("/tests/") ||
    relativePath.includes("/test-fixtures/") ||
    relativePath.includes("/mocks/") ||
    relativePath.includes("/packages/db/scripts/") ||
    relativePath.includes("/packages/db/src/migrations/") ||
    relativePath.includes("/apps/api/src/scripts/dev-") ||
    /\.(?:bench|spec|suite|test)\.[cm]?[jt]sx?$/u.test(relativePath) ||
    /\/test-[^/]+\.[cm]?[jt]sx?$/u.test(relativePath)
  );
}

async function listFiles(directory: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries.sort((a, b) => {
    return a.name.localeCompare(b.name);
  })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

function importBindingNames(importClause: ts.ImportClause | undefined): string {
  if (!importClause) return "side-effect";
  const names: string[] = [];
  if (importClause.name) names.push(`default:${importClause.name.text}`);
  const bindings = importClause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) {
    names.push(`namespace:${bindings.name.text}`);
  }
  if (bindings && ts.isNamedImports(bindings)) {
    for (const element of bindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      const local = element.name.text;
      const typePrefix = element.isTypeOnly ? "type:" : "";
      names.push(`${typePrefix}${imported}:${local}`);
    }
  }
  return names.sort().join(",");
}

function isSchemaImport(relativePath: string, moduleName: string): boolean {
  if (schemaModules.has(moduleName)) return true;
  return (
    relativePath.startsWith("turbo/packages/db/src/schema/") &&
    (moduleName === "./agent-compose" || moduleName === "./zero-agent")
  );
}

function collectTypeScriptEntries(args: {
  readonly relativePath: string;
  readonly sourceText: string;
  readonly schemaImports: Set<string>;
  readonly legacyIdentifiers: Set<string>;
  readonly rawTableLiterals: Set<string>;
}): void {
  const source = ts.createSourceFile(
    args.relativePath,
    args.sourceText,
    ts.ScriptTarget.Latest,
    true,
    args.relativePath.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const fileLegacyTokens = new Set<string>();
  const fileRawTables = new Set<string>();

  const inspectLiteral = (text: string): void => {
    for (const token of legacyLiteralTokens) {
      if (text.includes(token)) fileLegacyTokens.add(token);
    }
    for (const table of rawTableTokens) {
      if (new RegExp(`\\b${table}\\b`, "u").test(text)) {
        fileRawTables.add(table);
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const moduleName = node.moduleSpecifier.text;
      if (isSchemaImport(args.relativePath, moduleName)) {
        args.schemaImports.add(
          `${args.relativePath}|${moduleName}|${importBindingNames(node.importClause)}`,
        );
      }
    }
    if (ts.isIdentifier(node) && legacyIdentifierTokens.has(node.text)) {
      fileLegacyTokens.add(node.text);
    }
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      inspectLiteral(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  if (fileLegacyTokens.size > 0) {
    args.legacyIdentifiers.add(
      `${args.relativePath}|${[...fileLegacyTokens].sort().join(",")}`,
    );
  }
  if (fileRawTables.size > 0) {
    args.rawTableLiterals.add(
      `${args.relativePath}|${[...fileRawTables].sort().join(",")}`,
    );
  }
}

export async function collectRepositoryDependencyManifest(
  repositoryRoot: string,
): Promise<RepositoryDependencyManifest> {
  const schemaImports = new Set<string>();
  const legacyIdentifiers = new Set<string>();
  const rawTableLiterals = new Set<string>();
  const nonTypeScriptConsumers = new Set<string>();
  const transitionValidators = new Set<string>();
  const scanRoots = [
    ".github",
    "ansible",
    "bin",
    "crates",
    "docker",
    "scripts",
    "turbo/apps",
    "turbo/packages",
    "turbo/scripts",
  ];

  for (const scanRoot of scanRoots) {
    const files = await listFiles(path.join(repositoryRoot, scanRoot));
    for (const filePath of files) {
      const relativePath = normalizePath(
        path.relative(repositoryRoot, filePath),
      );
      if (isExcluded(`/${relativePath}`)) continue;
      const extension = path.extname(relativePath);
      if (!relativePath.endsWith(".ts") && !relativePath.endsWith(".tsx")) {
        if (
          !nonTypeScriptExtensions.has(extension) &&
          !nonTypeScriptFileNames.has(path.basename(relativePath)) &&
          !relativePath.startsWith("bin/")
        ) {
          continue;
        }
        const sourceText = await fs.readFile(filePath, "utf8");
        const tokens = [
          ...legacyIdentifierTokens,
          ...legacyLiteralTokens,
          ...rawTableTokens,
        ].filter((token) => {
          return sourceText.includes(token);
        });
        if (tokens.length > 0) {
          nonTypeScriptConsumers.add(
            `${relativePath}|${[...new Set(tokens)].sort().join(",")}`,
          );
        }
        continue;
      }
      collectTypeScriptEntries({
        relativePath,
        sourceText: await fs.readFile(filePath, "utf8"),
        schemaImports,
        legacyIdentifiers,
        rawTableLiterals,
      });
    }
  }

  const migrationsDocumentation = await fs.readFile(
    path.join(repositoryRoot, "turbo/packages/db/MIGRATIONS.md"),
    "utf8",
  );
  for (const match of migrationsDocumentation.matchAll(
    /<!-- vm0-transition-validator:([^\n]+) -->/gu,
  )) {
    transitionValidators.add(match[1]!.trim());
  }

  return {
    schemaImports: [...schemaImports].sort(),
    legacyIdentifiers: [...legacyIdentifiers].sort(),
    rawTableLiterals: [...rawTableLiterals].sort(),
    nonTypeScriptConsumers: [...nonTypeScriptConsumers].sort(),
    transitionValidators: [...transitionValidators].sort(),
  };
}

export function manifestsEqual(
  expected: RepositoryDependencyManifest,
  observed: RepositoryDependencyManifest,
): boolean {
  return (
    JSON.stringify(expected.schemaImports) ===
      JSON.stringify(observed.schemaImports) &&
    JSON.stringify(expected.legacyIdentifiers) ===
      JSON.stringify(observed.legacyIdentifiers) &&
    JSON.stringify(expected.rawTableLiterals) ===
      JSON.stringify(observed.rawTableLiterals) &&
    JSON.stringify(expected.nonTypeScriptConsumers) ===
      JSON.stringify(observed.nonTypeScriptConsumers) &&
    JSON.stringify(expected.transitionValidators) ===
      JSON.stringify(observed.transitionValidators)
  );
}
