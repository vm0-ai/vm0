--
-- PostgreSQL database dump
--


-- Dumped from database version 17.10 (Debian 17.10-1.pgdg12+1)
-- Dumped by pg_dump version 17.10 (Debian 17.10-1.pgdg12+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';


--
-- Name: chat_thread_event_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.chat_thread_event_kind AS ENUM (
    'created',
    'renamed',
    'deleted',
    'pinned',
    'unpinned',
    'model_selection_updated',
    'service_tier_updated',
    'computer_use_host_updated',
    'sort_touched'
);


--
-- Name: connector_external_code_session_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.connector_external_code_session_status AS ENUM (
    'pending',
    'completing',
    'complete',
    'expired',
    'error'
);


--
-- Name: connector_oauth_device_authorization_session_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.connector_oauth_device_authorization_session_status AS ENUM (
    'awaiting_user_authorization',
    'polling',
    'complete',
    'denied',
    'expired',
    'error'
);


--
-- Name: device_code_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.device_code_status AS ENUM (
    'pending',
    'authenticated',
    'approved',
    'consumed',
    'expired',
    'denied'
);


--
-- Name: model_provider_auth_session_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.model_provider_auth_session_status AS ENUM (
    'initializing',
    'awaiting_user_approval',
    'completing',
    'imported',
    'expired',
    'cancelled',
    'error'
);


--
-- Name: allocate_legacy_chat_thread_event_seq_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.allocate_legacy_chat_thread_event_seq_id() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.seq_id IS NULL THEN
    INSERT INTO chat_thread_event_sequences (user_id, org_id, last_seq_id)
    VALUES (NEW.user_id, NEW.org_id, 1)
    ON CONFLICT (user_id, org_id)
    DO UPDATE SET
      last_seq_id = chat_thread_event_sequences.last_seq_id + 1
    RETURNING last_seq_id INTO NEW.seq_id;
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: assert_org_custom_connector_oauth_mode(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_org_custom_connector_oauth_mode(target_connector_id uuid, target_org_id text) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
	"target_auth_mode" varchar(16);
	"oauth_config_count" integer;
BEGIN
	SELECT connector."auth_mode"
	INTO "target_auth_mode"
	FROM "org_custom_connectors" AS connector
	WHERE connector."id" = "target_connector_id"
		AND connector."org_id" = "target_org_id";

	IF NOT FOUND THEN
		RETURN;
	END IF;

	SELECT count(*)::integer
	INTO "oauth_config_count"
	FROM "org_custom_connector_oauth_configs" AS config
	WHERE config."connector_id" = "target_connector_id"
		AND config."org_id" = "target_org_id";

	IF (
		"target_auth_mode" = 'oauth'
		AND "oauth_config_count" <> 1
	) OR (
		"target_auth_mode" = 'manual'
		AND "oauth_config_count" <> 0
	) THEN
		RAISE EXCEPTION
			'custom connector auth mode and OAuth config do not match'
			USING ERRCODE = '23514';
	END IF;
END;
$$;


--
-- Name: bridge_chat_event_run_event_sequence_number_0807(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bridge_chat_event_run_event_sequence_number_0807() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW."run_event_sequence_number" IS NULL THEN
    NEW."run_event_sequence_number" := NEW."sequence_number";
  ELSIF NEW."sequence_number" IS NULL THEN
    NEW."sequence_number" := NEW."run_event_sequence_number";
  ELSIF NEW."run_event_sequence_number"
    IS DISTINCT FROM NEW."sequence_number"
  THEN
    RAISE EXCEPTION 'chat event run event sequence columns must match';
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: canonicalize_hosted_site_scope_0753(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.canonicalize_hosted_site_scope_0753() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD."chat_thread_id" IS NOT NULL
      AND NEW."chat_thread_id" IS DISTINCT FROM OLD."chat_thread_id"
    THEN
      RAISE EXCEPTION 'Hosted site chat ownership is immutable'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."requested_slug" IS NULL THEN
    NEW."requested_slug" := NEW."slug";
  END IF;

  IF NEW."chat_thread_id" IS NULL AND NEW."created_from_run_id" IS NOT NULL THEN
    SELECT "run"."chat_thread_id"
    INTO NEW."chat_thread_id"
    FROM "zero_runs" AS "run"
    WHERE "run"."id"::text = NEW."created_from_run_id";
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: chat_threads_normalize_computer_access(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.chat_threads_normalize_computer_access() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
	-- API versions that predate cloud_browser_enabled update only the host ID.
	-- Preserve host-wins behavior until those versions have fully drained.
	IF NEW."computer_use_host_id" IS NOT NULL THEN
		NEW."cloud_browser_enabled" := false;
	END IF;
	RETURN NEW;
END;
$$;


--
-- Name: delete_artifact_registry_entity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_artifact_registry_entity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  DELETE FROM "artifacts"
  WHERE "kind" = TG_ARGV[0]
    AND "entity_id" = OLD."id";
  RETURN OLD;
END;
$$;


--
-- Name: enforce_hosted_deployment_scope_0753(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_hosted_deployment_scope_0753() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  "site_chat_thread_id" uuid;
  "run_chat_thread_id" uuid;
BEGIN
  SELECT "site"."chat_thread_id"
  INTO "site_chat_thread_id"
  FROM "hosted_sites" AS "site"
  WHERE "site"."id" = NEW."site_id";

  IF NEW."run_id" IS NOT NULL THEN
    SELECT "run"."chat_thread_id"
    INTO "run_chat_thread_id"
    FROM "zero_runs" AS "run"
    WHERE "run"."id"::text = NEW."run_id";
  END IF;

  IF "site_chat_thread_id" IS DISTINCT FROM "run_chat_thread_id" THEN
    RAISE EXCEPTION
      'Hosted site belongs to a different chat; choose another site slug'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: enforce_org_custom_connector_oauth_mode(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_org_custom_connector_oauth_mode() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
	IF TG_TABLE_NAME = 'org_custom_connectors' THEN
		PERFORM "assert_org_custom_connector_oauth_mode"(NEW."id", NEW."org_id");
		RETURN NULL;
	END IF;

	IF TG_OP = 'UPDATE' AND (
		OLD."connector_id" IS DISTINCT FROM NEW."connector_id"
		OR OLD."org_id" IS DISTINCT FROM NEW."org_id"
	) THEN
		PERFORM "assert_org_custom_connector_oauth_mode"(
			OLD."connector_id",
			OLD."org_id"
		);
	END IF;

	IF TG_OP = 'DELETE' THEN
		PERFORM "assert_org_custom_connector_oauth_mode"(
			OLD."connector_id",
			OLD."org_id"
		);
	ELSE
		PERFORM "assert_org_custom_connector_oauth_mode"(
			NEW."connector_id",
			NEW."org_id"
		);
	END IF;

	RETURN NULL;
END;
$$;


--
-- Name: ensure_legacy_org_metadata_plan_entitlement(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ensure_legacy_org_metadata_plan_entitlement() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
	INSERT INTO "org_plan_entitlements" (
		"org_id",
		"plan_key",
		"plan_rank",
		"source",
		"status",
		"base_concurrency_limit",
		"can_buy_concurrency",
		"can_buy_credits",
		"auto_recharge_allowed",
		"support_byok",
		"restricted_vm0_models",
		"video_generation_allowed",
		"workflow_webhook_trigger_allowed",
		"audio_lifetime_limit",
		"audio_daily_rate_limit",
		"audio_daily_duration_seconds"
	)
	SELECT
		NEW."org_id",
		plans."plan_key",
		plans."plan_rank",
		'org_metadata_migration',
		plans."status",
		plans."base_concurrency_limit",
		plans."can_buy_concurrency",
		plans."can_buy_credits",
		plans."auto_recharge_allowed",
		plans."support_byok",
		plans."restricted_vm0_models",
		plans."video_generation_allowed",
		plans."workflow_webhook_trigger_allowed",
		plans."audio_lifetime_limit",
		plans."audio_daily_rate_limit",
		plans."audio_daily_duration_seconds"
	FROM (
		VALUES
			('free', 0, 'active', 1, false, true, false, true, false, true, false, 10, 10, 600),
			('limited-free-1', 0, 'active', 1, false, false, false, false, true, false, false, 10, 10, 600),
			('pro-suspend', 0, 'suspended', 0, false, false, false, false, true, false, false, 0, 0, 0),
			('pro', 1, 'active', 2, false, true, true, true, false, true, false, NULL, 300, 12000),
			('team', 2, 'active', 10, true, true, true, true, false, true, true, NULL, 500, 30000),
			('custom', 3, 'active', 10, true, true, true, true, false, true, true, NULL, 500, 30000)
	) AS plans(
		"plan_key",
		"plan_rank",
		"status",
		"base_concurrency_limit",
		"can_buy_concurrency",
		"can_buy_credits",
		"auto_recharge_allowed",
		"support_byok",
		"restricted_vm0_models",
		"video_generation_allowed",
		"workflow_webhook_trigger_allowed",
		"audio_lifetime_limit",
		"audio_daily_rate_limit",
		"audio_daily_duration_seconds"
	)
	WHERE plans."plan_key" = NEW."tier"
	ON CONFLICT ("org_id") DO NOTHING;
	RETURN NEW;
END;
$$;


--
-- Name: fill_legacy_chat_thread_snapshot_event_seq_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fill_legacy_chat_thread_snapshot_event_seq_id() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.latest_event_id IS NULL THEN
    NEW.latest_event_seq_id := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.latest_event_seq_id IS NULL THEN
      SELECT event.seq_id
      INTO NEW.latest_event_seq_id
      FROM chat_thread_events event
      WHERE event.id = NEW.latest_event_id
        AND event.user_id = NEW.user_id
        AND event.org_id = NEW.org_id;
    END IF;
  ELSIF NEW.latest_event_id IS DISTINCT FROM OLD.latest_event_id
    AND NEW.latest_event_seq_id IS NOT DISTINCT FROM OLD.latest_event_seq_id
  THEN
    SELECT event.seq_id
    INTO NEW.latest_event_seq_id
    FROM chat_thread_events event
    WHERE event.id = NEW.latest_event_id
      AND event.user_id = NEW.user_id
      AND event.org_id = NEW.org_id;
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: queue_artifact_catalog_file(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.queue_artifact_catalog_file() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  catalog_author_user_id text;
BEGIN
  IF NEW."url" IS NULL OR NEW."org_id" IS NULL THEN
    DELETE FROM "artifact_catalog_pending_files"
    WHERE "file_id" = NEW."id";
    RETURN NEW;
  END IF;

  catalog_author_user_id := COALESCE(
    (
      SELECT thread."user_id"
      FROM "chat_threads" AS thread
      WHERE thread."id" = COALESCE(
        NEW."chat_thread_id",
        (
          SELECT run."chat_thread_id"
          FROM "zero_runs" AS run
          WHERE run."id" = NEW."run_id"
        ),
        (
          SELECT message."chat_thread_id"
          FROM "chat_events" AS message
          WHERE message."run_id" = NEW."run_id"
          ORDER BY message."seq_id" ASC
          LIMIT 1
        )
      )
    ),
    NEW."user_id"
  );

  INSERT INTO "artifact_catalog_pending_files" (
    "file_id",
    "org_id",
    "author_user_id",
    "queued_at"
  )
  VALUES (
    NEW."id",
    NEW."org_id",
    catalog_author_user_id,
    clock_timestamp()
  )
  ON CONFLICT ("file_id") DO UPDATE SET
    "org_id" = EXCLUDED."org_id",
    "author_user_id" = EXCLUDED."author_user_id",
    "queued_at" = EXCLUDED."queued_at";

  RETURN NEW;
END;
$$;


--
-- Name: reject_chat_event_source_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reject_chat_event_source_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$;


--
-- Name: sync_legacy_org_plan_entitlement_can_buy_credits(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_legacy_org_plan_entitlement_can_buy_credits() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
	IF NEW."source" IN (
		'stripe_subscription',
		'stripe_atom_grant',
		'org_metadata_bootstrap',
		'org_metadata_migration'
	) THEN
		NEW."can_buy_credits" := NEW."plan_key" IN ('free', 'pro', 'team', 'custom');
	END IF;
	RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: agent_compose_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_compose_versions (
    id character varying(64) NOT NULL,
    compose_id uuid NOT NULL,
    content jsonb NOT NULL,
    created_by text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_composes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_composes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    user_id text NOT NULL,
    name character varying(64) DEFAULT ''::character varying NOT NULL,
    head_version_id character varying(64),
    org_id text NOT NULL
);


--
-- Name: agent_run_callbacks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_run_callbacks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    url text,
    encrypted_secret text,
    payload jsonb,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_attempt_at timestamp without time zone,
    last_error text,
    delivered_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    internal_kind character varying(64)
);


--
-- Name: agent_run_custom_connector_auth_refs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_run_custom_connector_auth_refs (
    run_id uuid NOT NULL,
    secret_name character varying(255) NOT NULL,
    connector_id uuid NOT NULL,
    kind character varying(16) NOT NULL,
    key character varying(64) NOT NULL,
    encrypted_value text,
    expires_at timestamp without time zone NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    connector_revision integer DEFAULT 1 NOT NULL
);


--
-- Name: agent_run_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_run_queue (
    run_id uuid NOT NULL,
    user_id text NOT NULL,
    encrypted_params text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    org_id text NOT NULL
);


--
-- Name: agent_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    status character varying(20) NOT NULL,
    prompt text NOT NULL,
    vars jsonb,
    sandbox_id character varying(255),
    result jsonb,
    error text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    started_at timestamp without time zone,
    completed_at timestamp without time zone,
    user_id text NOT NULL,
    agent_compose_version_id character varying(64),
    last_heartbeat_at timestamp without time zone,
    secret_names jsonb,
    continued_from_session_id uuid,
    org_id text NOT NULL,
    append_system_prompt text,
    runner_group character varying(255),
    session_id uuid NOT NULL,
    sandbox_reuse_result character varying(50),
    last_event_sequence integer,
    storage_mounts jsonb,
    cancellation_recovery_completed boolean,
    runner_id uuid,
    runner_heartbeat_generation bigint
);


--
-- Name: agent_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id text NOT NULL,
    agent_compose_id uuid NOT NULL,
    conversation_id uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    org_id text NOT NULL,
    storage_mounts jsonb
);


--
-- Name: agentphone_chat_thread_routes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agentphone_chat_thread_routes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    agentphone_user_link_id uuid NOT NULL,
    root_message_id character varying(255) NOT NULL,
    conversation_id character varying(255),
    chat_thread_id uuid NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: agentphone_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agentphone_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    webhook_id character varying(255),
    agentphone_message_id character varying(255) NOT NULL,
    conversation_id character varying(255),
    agentphone_agent_id character varying(255) NOT NULL,
    agentphone_user_link_id uuid,
    phone_handle character varying(254) NOT NULL,
    from_number character varying(254) NOT NULL,
    to_number character varying(254) NOT NULL,
    direction character varying(16) NOT NULL,
    channel character varying(16) NOT NULL,
    body text,
    media_url text,
    is_bot boolean DEFAULT false NOT NULL,
    received_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: agentphone_user_agent_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agentphone_user_agent_preferences (
    vm0_user_id text NOT NULL,
    org_id text NOT NULL,
    selected_compose_id uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: agentphone_user_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agentphone_user_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    phone_handle character varying(254) NOT NULL,
    vm0_user_id text NOT NULL,
    org_id text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: agentphone_verification_send_cooldowns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agentphone_verification_send_cooldowns (
    scope character varying(32) NOT NULL,
    scope_key text NOT NULL,
    last_sent_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: archived_task_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.archived_task_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id text NOT NULL,
    org_id text NOT NULL,
    task_id text NOT NULL,
    task_type text NOT NULL,
    archived_run_id text,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: artifact_catalog_pending_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.artifact_catalog_pending_files (
    file_id uuid NOT NULL,
    org_id text NOT NULL,
    author_user_id text NOT NULL,
    queued_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: artifacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.artifacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id text NOT NULL,
    author_user_id text NOT NULL,
    kind character varying(32) NOT NULL,
    entity_id uuid NOT NULL,
    logical_key text NOT NULL,
    projection_file_id uuid NOT NULL,
    projection_created_at timestamp without time zone NOT NULL,
    title text NOT NULL,
    thumbnail jsonb,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: banking_access_audit_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.banking_access_audit_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id text NOT NULL,
    user_id text NOT NULL,
    run_id uuid,
    agent_id uuid,
    connection_id uuid,
    provider character varying(32) DEFAULT 'finicity'::character varying NOT NULL,
    provider_account_id character varying(128),
    action character varying(64) NOT NULL,
    status character varying(16) NOT NULL,
    failure_code character varying(64),
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: banking_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.banking_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    connection_id uuid NOT NULL,
    org_id text NOT NULL,
    user_id text NOT NULL,
    provider_account_id character varying(128) NOT NULL,
    display_name character varying(256),
    institution_name character varying(256),
    account_type character varying(64),
    account_number_last4 character varying(8),
    enabled boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: banking_agent_enablements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.banking_agent_enablements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id text NOT NULL,
    user_id text NOT NULL,
    agent_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    account_provider_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    operation_scopes jsonb DEFAULT '["accounts.read", "balances.read", "transactions.read"]'::jsonb NOT NULL,
    revoked_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    allow_automation_runs boolean DEFAULT false NOT NULL
);


--
-- Name: banking_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.banking_connections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id text NOT NULL,
    user_id text NOT NULL,
    provider character varying(32) DEFAULT 'finicity'::character varying NOT NULL,
    provider_customer_id character varying(128) NOT NULL,
    status character varying(32) DEFAULT 'active'::character varying NOT NULL,
    consent_expires_at timestamp without time zone,
    repair_required_at timestamp without time zone,
    revoked_at timestamp without time zone,
    deleted_at timestamp without time zone,
    audit_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: blobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.blobs (
    hash character varying(64) NOT NULL,
    raw_size bigint NOT NULL,
    ref_count integer DEFAULT 1 NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    encoding character varying(16) NOT NULL,
    encoded_size bigint NOT NULL
);


--
-- Name: browser_authorization_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.browser_authorization_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    request_token_hash text NOT NULL,
    org_id text NOT NULL,
    user_id text NOT NULL,
    run_id uuid NOT NULL,
    chat_thread_id uuid NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    completed_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: browser_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.browser_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id text NOT NULL,
    user_id text NOT NULL,
    provider_profile_id uuid NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: browser_session_instances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.browser_session_instances (
    provider_session_id uuid NOT NULL,
    browser_session_id uuid,
    chat_thread_id uuid NOT NULL,
    run_id uuid NOT NULL,
    status character varying(20) NOT NULL,
    timeout_at timestamp without time zone NOT NULL,
    started_at timestamp without time zone NOT NULL,
    stop_requested_at timestamp without time zone,
    finished_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    last_touched_at timestamp without time zone DEFAULT now() NOT NULL,
    idle_expires_at timestamp without time zone DEFAULT (now() + '00:10:00'::interval) NOT NULL
);


--
-- Name: browser_session_resize_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.browser_session_resize_states (
    provider_session_id uuid NOT NULL,
    screen_width integer NOT NULL,
    screen_height integer NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: browser_session_tab_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.browser_session_tab_snapshots (
    chat_thread_id uuid NOT NULL,
    encrypted_tab_urls text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: browser_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.browser_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    chat_thread_id uuid NOT NULL,
    run_id uuid,
    org_id text NOT NULL,
    user_id text NOT NULL,
    name character varying(64) NOT NULL,
    browser_profile_id uuid,
    status character varying(20) NOT NULL,
    proxy_country_code character varying(2),
    timeout_minutes integer NOT NULL,
    suspended_at timestamp without time zone,
    suspension_reason character varying(20),
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    browser_thread_profile_id uuid
);


--
-- Name: browser_thread_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.browser_thread_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    chat_thread_id uuid NOT NULL,
    org_id text NOT NULL,
    user_id text NOT NULL,
    provider_profile_id uuid NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: built_in_generation_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.built_in_generation_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    type character varying(32) NOT NULL,
    status character varying(20) DEFAULT 'queued'::character varying NOT NULL,
    org_id text NOT NULL,
    user_id text NOT NULL,
    run_id uuid,
    request jsonb NOT NULL,
    result jsonb,
    error jsonb,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    started_at timestamp without time zone,
    completed_at timestamp without time zone
);


--
-- Name: canonical_asset_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.canonical_asset_deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    asset_id uuid NOT NULL,
    provider character varying(32) NOT NULL,
    operation_id uuid NOT NULL,
    status character varying(16) NOT NULL,
    destination jsonb NOT NULL,
    external_id text,
    url text,
    last_error jsonb,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: chat_agentphone_context; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_agentphone_context (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    chat_thread_id uuid NOT NULL,
    message_text text,
    thread_context text,
    message_id text,
    root_message_id text,
    conversation_id text,
    channel text,
    is_group boolean,
    phone_handle text,
    from_number text,
    to_number text,
    user_link_id uuid,
    agentphone_agent_id text,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: chat_automation_context; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_automation_context (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    chat_thread_id uuid NOT NULL,
    automation_id uuid NOT NULL,
    trigger_brief text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    workflow_name text,
    event_type text,
    event_payload jsonb
);


--
-- Name: chat_event_asset_refs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_event_asset_refs (
    chat_event_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    "position" integer NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: chat_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    chat_thread_id uuid NOT NULL,
    run_id uuid,
    content text,
    error text,
    sequence_number integer,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    run_event_id text,
    attach_files jsonb,
    interrupts_run_id uuid,
    recommended_followups jsonb,
    generation_template jsonb,
    usage_payload jsonb,
    run_group_id uuid,
    goal_event jsonb,
    thinking text,
    seq_id bigint NOT NULL,
    event_type text NOT NULL,
    trigger_source text,
    user_message jsonb,
    context_type text,
    context_id uuid,
    revokes_event_id uuid,
    run_event_sequence_number integer,
    CONSTRAINT chat_events_context_pair_check CHECK (((context_type IS NULL) = (context_id IS NULL))),
    CONSTRAINT chat_events_context_type_check CHECK ((context_type = ANY (ARRAY['slack'::text, 'feishu'::text, 'teams'::text, 'telegram'::text, 'github'::text, 'agentphone'::text, 'automation'::text, 'goal'::text, 'morning_brief'::text]))),
    CONSTRAINT chat_events_event_type_check CHECK ((event_type = ANY (ARRAY['input.prompt'::text, 'input.automation'::text, 'input.goal'::text, 'input.rejected'::text, 'output.message'::text, 'output.error'::text, 'output.thinking'::text, 'output.followups'::text, 'run.queued'::text, 'run.dequeued'::text, 'run.completed'::text, 'run.failed'::text, 'run.cancelled'::text, 'control.interrupt'::text, 'control.revoke'::text, 'browser.started'::text, 'browser.stopped'::text, 'goal.changed'::text, 'usage.recorded'::text]))),
    CONSTRAINT chat_events_input_content_check CHECK (((event_type <> ALL (ARRAY['input.prompt'::text, 'input.rejected'::text])) OR (content IS NULL))),
    CONSTRAINT chat_events_input_user_message_check CHECK (((event_type <> ALL (ARRAY['input.prompt'::text, 'input.rejected'::text])) OR (user_message IS NOT NULL)))
);


--
-- Name: chat_feishu_context; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_feishu_context (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    chat_thread_id uuid NOT NULL,
    chat_open_url text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    conversation_history text,
    message_text text,
    message_files jsonb,
    chat_type text,
    chat_id text,
    message_id text,
    thread_id text,
    reply_in_thread boolean,
    reaction_id text,
    sender_open_id text,
    connection_id uuid,
    installation_id uuid
);


--
-- Name: chat_github_context; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_github_context (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    chat_thread_id uuid NOT NULL,
    repo text NOT NULL,
    subject_number integer NOT NULL,
    subject_kind text NOT NULL,
    trigger_comment_id text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    issue_context text,
    message_text text,
    trigger_reaction_id text,
    trigger_comment_body text,
    CONSTRAINT chat_github_context_subject_kind_check CHECK ((subject_kind = ANY (ARRAY['issue'::text, 'pull_request'::text])))
);


--
-- Name: chat_goal_context; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_goal_context (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    chat_thread_id uuid NOT NULL,
    objective_brief text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: chat_morning_brief_context; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_morning_brief_context (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    chat_thread_id uuid NOT NULL,
    delivery_id uuid NOT NULL,
    timezone text,
    triggered_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: chat_output_materializations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_output_materializations (
    run_id uuid NOT NULL,
    processed_through_sequence integer DEFAULT '-1'::integer NOT NULL,
    latest_result_sequence integer,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    pending_sequence_numbers integer[] DEFAULT '{}'::integer[] NOT NULL,
    latest_result_text text,
    latest_output_sequence integer,
    latest_output_text text
);


--
-- Name: chat_slack_context; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_slack_context (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    chat_thread_id uuid NOT NULL,
    message_permalink text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    channel_id text,
    message_ts text,
    conversation_context text,
    message_text text,
    message_files jsonb,
    mention_display_names jsonb,
    sender_display_name text,
    sender_user_id text,
    channel_type text,
    thread_ts text,
    route_thread_ts text
);


--
-- Name: chat_teams_context; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_teams_context (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    chat_thread_id uuid NOT NULL,
    tenant_id text NOT NULL,
    team_id text,
    channel_id text,
    conversation_id text NOT NULL,
    conversation_type text,
    activity_id text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    thread_context text,
    message_text text,
    message_files jsonb,
    tenant_name text,
    team_name text,
    thread_id text,
    service_url text,
    teams_app_id text,
    bot_id text,
    bot_name text,
    sender_user_id text,
    sender_display_name text,
    sender_principal_name text,
    connection_id uuid
);


--
-- Name: chat_telegram_context; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_telegram_context (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    chat_thread_id uuid NOT NULL,
    chat_id text NOT NULL,
    message_id text NOT NULL,
    is_dm boolean NOT NULL,
    message_thread_id integer,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    message_text text,
    thread_context text,
    root_message_id text,
    thinking_message_id text,
    user_link_id uuid,
    user_link_kind text,
    chat_type text,
    sender_user_id text,
    sender_display_name text,
    sender_username text,
    sender_language text
);


--
-- Name: chat_thread_event_sequences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_thread_event_sequences (
    user_id text NOT NULL,
    org_id text NOT NULL,
    last_seq_id bigint DEFAULT 0 NOT NULL
);


--
-- Name: chat_thread_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_thread_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id text NOT NULL,
    org_id text NOT NULL,
    chat_thread_id uuid NOT NULL,
    kind public.chat_thread_event_kind NOT NULL,
    agent_compose_id uuid NOT NULL,
    title text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    selected_model character varying(255),
    service_tier character varying(20),
    computer_use_host_id uuid,
    cloud_browser_enabled boolean DEFAULT false NOT NULL,
    seq_id bigint NOT NULL,
    CONSTRAINT chat_thread_events_computer_access_check CHECK ((NOT (cloud_browser_enabled AND (computer_use_host_id IS NOT NULL))))
);


--
-- Name: chat_thread_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_thread_snapshots (
    user_id text NOT NULL,
    org_id text NOT NULL,
    latest_event_id uuid,
    chat_threads jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    latest_event_seq_id bigint
);


--
-- Name: chat_threads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_threads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id text NOT NULL,
    agent_compose_id uuid NOT NULL,
    title text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    source_schedule_run_id uuid,
    draft_attachments jsonb,
    last_read_at timestamp without time zone,
    model_provider_id uuid,
    selected_model character varying(255),
    pinned_at timestamp without time zone,
    renamed_at timestamp without time zone,
    model_provider_type character varying(50),
    model_provider_credential_scope character varying(20),
    last_message_at timestamp without time zone DEFAULT now() NOT NULL,
    computer_use_host_id uuid,
    generation_template jsonb,
    codex_service_tier character varying(20),
    agent_session_id uuid,
    agent_session_run_id uuid,
    cloud_browser_enabled boolean DEFAULT false NOT NULL,
    draft_user_message jsonb,
    last_chat_event_seq_id bigint DEFAULT 0 NOT NULL,
    CONSTRAINT chat_threads_computer_access_check CHECK ((NOT (cloud_browser_enabled AND (computer_use_host_id IS NOT NULL)))),
    CONSTRAINT chat_threads_draft_user_message_check CHECK (((draft_user_message IS NOT NULL) OR (COALESCE(draft_attachments, '[]'::jsonb) = '[]'::jsonb)))
);


--
-- Name: checkpoints; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.checkpoints (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    agent_compose_snapshot jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    storage_mounts jsonb
);


--
-- Name: cli_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cli_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    token text NOT NULL,
    user_id text NOT NULL,
    name text NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    last_used_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: compose_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.compose_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id text NOT NULL,
    github_url text,
    overwrite boolean DEFAULT false NOT NULL,
    status character varying(20) NOT NULL,
    sandbox_id character varying(255),
    result jsonb,
    error text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    started_at timestamp without time zone,
    completed_at timestamp without time zone,
    content jsonb,
    instructions text,
    source character varying(20) DEFAULT 'github'::character varying NOT NULL
);


--
-- Name: computer_use_authorization_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.computer_use_authorization_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    request_token_hash text NOT NULL,
    org_id text NOT NULL,
    user_id text NOT NULL,
    run_id uuid NOT NULL,
    source text NOT NULL,
    chat_thread_id uuid,
    slack_connection_id uuid,
    slack_channel_id text,
    slack_thread_ts text,
    expires_at timestamp without time zone NOT NULL,
    completed_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    teams_connection_id uuid,
    teams_conversation_id text,
    teams_thread_id text,
    CONSTRAINT computer_use_auth_requests_scope_check CHECK ((((source = 'chat'::text) AND (chat_thread_id IS NOT NULL) AND (slack_connection_id IS NULL) AND (slack_channel_id IS NULL) AND (slack_thread_ts IS NULL) AND (teams_connection_id IS NULL) AND (teams_conversation_id IS NULL) AND (teams_thread_id IS NULL)) OR ((source = 'slack'::text) AND (chat_thread_id IS NULL) AND (slack_connection_id IS NOT NULL) AND (slack_channel_id IS NOT NULL) AND (slack_thread_ts IS NOT NULL) AND (teams_connection_id IS NULL) AND (teams_conversation_id IS NULL) AND (teams_thread_id IS NULL)) OR ((source = 'teams'::text) AND (chat_thread_id IS NULL) AND (slack_connection_id IS NULL) AND (slack_channel_id IS NULL) AND (slack_thread_ts IS NULL) AND (teams_connection_id IS NOT NULL) AND (teams_conversation_id IS NOT NULL) AND (teams_thread_id IS NOT NULL)))),
    CONSTRAINT computer_use_auth_requests_source_check CHECK ((source = ANY (ARRAY['chat'::text, 'slack'::text, 'teams'::text])))
);


--
-- Name: computer_use_command_audit_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.computer_use_command_audit_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    command_id uuid NOT NULL,
    org_id text NOT NULL,
    user_id text NOT NULL,
    run_id text,
    host_id uuid,
    kind text NOT NULL,
    app text,
    event text NOT NULL,
    approval_outcome text,
    redacted_result jsonb,
    error jsonb,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: computer_use_commands; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.computer_use_commands (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id text NOT NULL,
    user_id text NOT NULL,
    run_id text,
    host_id uuid,
    kind text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    result jsonb,
    error text,
    timeout_ms integer,
    claimed_at timestamp without time zone,
    completed_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: computer_use_hosts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.computer_use_hosts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id text NOT NULL,
    user_id text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    display_name text NOT NULL,
    token_hash text NOT NULL,
    app_version text NOT NULL,
    os_version text NOT NULL,
    supported_capabilities jsonb DEFAULT '[]'::jsonb NOT NULL,
    permissions jsonb DEFAULT '{"accessibility": false, "screenRecording": false}'::jsonb NOT NULL,
    status text DEFAULT 'online'::text NOT NULL,
    last_seen_at timestamp without time zone DEFAULT now() NOT NULL,
    revoked_at timestamp without time zone,
    installation_id uuid
);


--
-- Name: connector_catalog_active_snapshot; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.connector_catalog_active_snapshot (
    source_id character varying(64) NOT NULL,
    schema_version integer NOT NULL,
    catalog_version character varying(255) NOT NULL,
    activated_at timestamp without time zone NOT NULL,
    catalog_key text NOT NULL,
    catalog_digest character varying(71) NOT NULL,
    catalog_raw_size integer NOT NULL,
    catalog_gzip bytea NOT NULL,
    CONSTRAINT connector_catalog_active_snapshot_catalog_digest_valid CHECK (((catalog_digest)::text ~ '^sha256:[a-f0-9]{64}$'::text)),
    CONSTRAINT connector_catalog_active_snapshot_catalog_raw_size_positive CHECK ((catalog_raw_size > 0)),
    CONSTRAINT connector_catalog_active_snapshot_schema_version_positive CHECK ((schema_version > 0))
);


--
-- Name: connector_catalog_compatibility_evaluation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.connector_catalog_compatibility_evaluation (
    source_id character varying(64) NOT NULL,
    schema_version integer NOT NULL,
    catalog_version character varying(255) NOT NULL,
    executable_capability_digest character varying(71) NOT NULL,
    evaluated_at timestamp without time zone NOT NULL,
    filtered_auth_methods jsonb NOT NULL,
    catalog_digest character varying(71) NOT NULL,
    catalog_validation_backend_version character varying(64),
    catalog_validation_build_commit_sha character varying(40),
    CONSTRAINT connector_catalog_compat_eval_schema_version_positive CHECK ((schema_version > 0)),
    CONSTRAINT connector_catalog_compat_validation_authority_complete CHECK ((((catalog_validation_backend_version IS NULL) AND (catalog_validation_build_commit_sha IS NULL)) OR ((catalog_validation_backend_version IS NOT NULL) AND ((catalog_validation_backend_version)::text ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'::text) AND ((catalog_validation_build_commit_sha IS NULL) OR ((catalog_validation_build_commit_sha)::text ~ '^[a-f0-9]{40}$'::text))))),
    CONSTRAINT connector_catalog_compatibility_catalog_digest_valid CHECK (((catalog_digest)::text ~ '^sha256:[a-f0-9]{64}$'::text)),
    CONSTRAINT connector_catalog_compatibility_evaluation_digest_valid CHECK (((executable_capability_digest)::text ~ '^sha256:[a-f0-9]{64}$'::text))
);


--
-- Name: connector_catalog_sync_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.connector_catalog_sync_state (
    source_id character varying(64) NOT NULL,
    schema_version integer NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    last_observed_catalog_version character varying(255),
    last_observed_pointer_etag text,
    last_attempt_at timestamp without time zone,
    last_attempt_outcome character varying(32),
    last_success_at timestamp without time zone,
    last_failure_code character varying(64),
    last_rejected_catalog_version character varying(255),
    last_rejected_pointer_etag text,
    last_rejected_failure_code character varying(64),
    last_observed_catalog_key text,
    last_observed_catalog_digest character varying(71),
    last_rejected_catalog_key text,
    last_rejected_catalog_digest character varying(71),
    last_attempt_reused_cached_rejection boolean,
    last_rejected_backend_version character varying(64),
    last_rejected_build_commit_sha character varying(40),
    CONSTRAINT connector_catalog_sync_state_attempt_cache_reuse_complete CHECK ((((last_attempt_outcome IS NULL) AND (last_attempt_reused_cached_rejection IS NULL)) OR ((last_attempt_outcome IS NOT NULL) AND (last_attempt_reused_cached_rejection IS NOT NULL) AND ((last_attempt_reused_cached_rejection = false) OR ((last_attempt_outcome)::text = 'rejected'::text))))),
    CONSTRAINT connector_catalog_sync_state_attempt_complete CHECK ((((last_attempt_outcome IS NULL) AND (last_attempt_at IS NULL) AND (last_failure_code IS NULL)) OR (((last_attempt_outcome)::text = 'rejected'::text) AND (last_attempt_at IS NOT NULL) AND (last_failure_code IS NOT NULL)) OR (((last_attempt_outcome)::text = ANY ((ARRAY['accepted'::character varying, 'unchanged'::character varying])::text[])) AND (last_attempt_at IS NOT NULL) AND (last_failure_code IS NULL)))),
    CONSTRAINT connector_catalog_sync_state_observed_identity_complete CHECK ((((last_observed_catalog_version IS NULL) AND (last_observed_catalog_key IS NULL) AND (last_observed_catalog_digest IS NULL)) OR ((last_observed_catalog_version IS NOT NULL) AND (last_observed_catalog_key IS NOT NULL) AND (last_observed_catalog_digest IS NOT NULL)))),
    CONSTRAINT connector_catalog_sync_state_rejected_candidate_complete CHECK ((((last_rejected_catalog_version IS NULL) AND (last_rejected_catalog_key IS NULL) AND (last_rejected_catalog_digest IS NULL) AND (last_rejected_pointer_etag IS NULL) AND (last_rejected_failure_code IS NULL)) OR ((last_rejected_failure_code IS NOT NULL) AND ((last_rejected_failure_code)::text <> 'source-unavailable'::text) AND (((last_rejected_catalog_version IS NOT NULL) AND (last_rejected_catalog_key IS NOT NULL) AND (last_rejected_catalog_digest IS NOT NULL)) OR (last_rejected_pointer_etag IS NOT NULL)) AND (((last_rejected_catalog_version IS NULL) AND (last_rejected_catalog_key IS NULL) AND (last_rejected_catalog_digest IS NULL)) OR ((last_rejected_catalog_version IS NOT NULL) AND (last_rejected_catalog_key IS NOT NULL) AND (last_rejected_catalog_digest IS NOT NULL)))))),
    CONSTRAINT connector_catalog_sync_state_rejection_authority_complete CHECK ((((last_rejected_failure_code IS NULL) AND (last_rejected_backend_version IS NULL) AND (last_rejected_build_commit_sha IS NULL)) OR ((last_rejected_failure_code IS NOT NULL) AND (last_rejected_backend_version IS NOT NULL) AND ((last_rejected_backend_version)::text ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'::text) AND ((last_rejected_build_commit_sha IS NULL) OR ((last_rejected_build_commit_sha)::text ~ '^[a-f0-9]{40}$'::text))))),
    CONSTRAINT connector_catalog_sync_state_revision_nonnegative CHECK ((revision >= 0)),
    CONSTRAINT connector_catalog_sync_state_schema_version_positive CHECK ((schema_version > 0))
);


--
-- Name: connector_external_code_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.connector_external_code_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id text NOT NULL,
    user_id text NOT NULL,
    auth_method character varying(50) NOT NULL,
    status public.connector_external_code_session_status DEFAULT 'pending'::public.connector_external_code_session_status NOT NULL,
    session_token_hash character varying(128) NOT NULL,
    encrypted_provider_state text NOT NULL,
    authorization_url text NOT NULL,
    error_code character varying(255),
    error_message text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    completed_at timestamp without time zone,
    agent_id uuid,
    authorize_agent boolean DEFAULT false NOT NULL,
    connector_slug character varying(64) NOT NULL
);


--
-- Name: connector_oauth_device_authorization_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.connector_oauth_device_authorization_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id text NOT NULL,
    user_id text NOT NULL,
    status public.connector_oauth_device_authorization_session_status DEFAULT 'awaiting_user_authorization'::public.connector_oauth_device_authorization_session_status NOT NULL,
    session_token_hash character varying(128) NOT NULL,
    encrypted_provider_state text NOT NULL,
    user_code character varying(255) NOT NULL,
    verification_uri text NOT NULL,
    verification_uri_complete text,
    interval_seconds integer NOT NULL,
    error_code character varying(255),
    error_message text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    completed_at timestamp without time zone,
    auth_method character varying(50) NOT NULL,
    agent_id uuid,
    authorize_agent boolean DEFAULT false NOT NULL,
    connector_slug character varying(64) NOT NULL
);


--
-- Name: connector_oauth_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.connector_oauth_states (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    state text NOT NULL,
    user_id text NOT NULL,
    org_id text NOT NULL,
    redirect_uri text NOT NULL,
    code_verifier text,
    oauth_context text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    consumed_at timestamp without time zone,
    auth_method character varying(50) NOT NULL,
    agent_id uuid,
    authorize_agent boolean DEFAULT false NOT NULL,
    authorization_url text,
    custom_connector_id uuid,
    connector_revision integer,
    connector_slug character varying(64),
    CONSTRAINT chk_connector_oauth_states_custom_revision CHECK ((((custom_connector_id IS NULL) AND (connector_revision IS NULL)) OR ((custom_connector_id IS NOT NULL) AND (connector_revision IS NOT NULL)))),
    CONSTRAINT chk_connector_oauth_states_identity CHECK ((num_nonnulls(connector_slug, custom_connector_id) = 1))
);


--
-- Name: connectors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.connectors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    auth_method character varying(50) NOT NULL,
    external_id character varying(255),
    external_username character varying(255),
    external_email character varying(255),
    oauth_scopes text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    token_expires_at timestamp without time zone,
    user_id text NOT NULL,
    org_id text NOT NULL,
    needs_reconnect boolean DEFAULT false NOT NULL,
    reconnect_reason character varying(64),
    storage_version bigint NOT NULL,
    custom_connector_id uuid,
    connector_slug character varying(64),
    CONSTRAINT chk_connectors_identity CHECK ((num_nonnulls(connector_slug, custom_connector_id) = 1)),
    CONSTRAINT chk_connectors_storage_version_positive CHECK ((storage_version > 0))
);


--
-- Name: conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    cli_agent_type character varying(64) NOT NULL,
    cli_agent_session_id character varying(255) NOT NULL,
    cli_agent_session_history text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    cli_agent_session_history_hash character varying(64)
);


--
-- Name: credit_expires_record; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.credit_expires_record (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id text NOT NULL,
    source character varying(50) NOT NULL,
    stripe_invoice_id text,
    amount bigint NOT NULL,
    remaining bigint NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: desktop_auth_handoff_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.desktop_auth_handoff_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code_hash text NOT NULL,
    user_id text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    consumed_at timestamp without time zone,
    completed_at timestamp without time zone
);


--
-- Name: device_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_codes (
    code character varying(9) NOT NULL,
    status public.device_code_status DEFAULT 'pending'::public.device_code_status NOT NULL,
    user_id text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    org_id text,
    purpose character varying(32) DEFAULT 'cli'::character varying NOT NULL,
    ble_session_nonce text,
    poll_token_hash text,
    poll_interval_seconds integer,
    cli_token_id uuid,
    chat_thread_id uuid,
    approved_at timestamp without time zone,
    consumed_at timestamp without time zone
);


--
-- Name: e2e_slack_mock_call_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.e2e_slack_mock_call_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    method character varying(64) NOT NULL,
    team_id character varying(255),
    channel_id character varying(255),
    body text NOT NULL,
    body_json jsonb,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: e2e_teams_mock_call_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.e2e_teams_mock_call_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    method character varying(64) NOT NULL,
    tenant_id character varying(255),
    conversation_id character varying(255),
    activity_id character varying(255),
    body text NOT NULL,
    body_json jsonb,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: e2e_telegram_mock_call_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.e2e_telegram_mock_call_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    method character varying(64) NOT NULL,
    bot_token character varying(255),
    chat_id character varying(255),
    body text NOT NULL,
    body_json jsonb,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: email_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_outbox (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    from_address text NOT NULL,
    to_addresses jsonb NOT NULL,
    cc_addresses jsonb,
    subject text NOT NULL,
    reply_to text,
    headers jsonb,
    template jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    next_retry_at timestamp without time zone,
    resend_id text,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: email_suppressions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_suppressions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email_address text NOT NULL,
    reason text NOT NULL,
    resend_email_id text,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: export_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.export_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id text NOT NULL,
    org_id text NOT NULL,
    status character varying(20) NOT NULL,
    s3_key text,
    artifact_urls jsonb,
    error text,
    expires_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    completed_at timestamp without time zone
);


--
-- Name: feishu_chat_ingress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feishu_chat_ingress (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    installation_id uuid NOT NULL,
    event_id character varying(255) NOT NULL,
    payload text NOT NULL,
    status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    retry_count integer DEFAULT 0 NOT NULL,
    reaction_id character varying(255),
    last_error text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_feishu_chat_ingress_retry_count CHECK ((retry_count >= 0)),
    CONSTRAINT chk_feishu_chat_ingress_status CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'processing'::character varying, 'processed'::character varying, 'failed'::character varying])::text[])))
);


--
-- Name: feishu_chat_thread_routes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feishu_chat_thread_routes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    connection_id uuid NOT NULL,
    chat_id character varying(255) NOT NULL,
    thread_id character varying(255) NOT NULL,
    user_id text NOT NULL,
    chat_thread_id uuid NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: feishu_org_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feishu_org_connections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    installation_id uuid NOT NULL,
    feishu_open_id character varying(255) NOT NULL,
    vm0_user_id text NOT NULL,
    feishu_user_name character varying(255),
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    dm_welcome_sent boolean DEFAULT false NOT NULL
);


--
-- Name: feishu_org_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feishu_org_events (
    installation_id uuid NOT NULL,
    event_id character varying(255) NOT NULL,
    received_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: feishu_org_installations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feishu_org_installations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id text NOT NULL,
    app_id character varying(255) NOT NULL,
    encrypted_app_secret text NOT NULL,
    encrypted_verification_token text NOT NULL,
    encrypted_encrypt_key text NOT NULL,
    default_compose_id uuid NOT NULL,
    feishu_tenant_key character varying(255),
    feishu_tenant_name character varying(255),
    encrypted_tenant_access_token text,
    tenant_access_token_expires_at timestamp without time zone,
    callback_verified_at timestamp without time zone,
    message_received_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    owner_user_id text,
    bot_name character varying(255),
    bot_avatar_url text,
    setup_completed_at timestamp without time zone,
    bot_open_id character varying(255)
);


--
-- Name: feishu_user_agent_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feishu_user_agent_preferences (
    vm0_user_id text NOT NULL,
    org_id text NOT NULL,
    selected_compose_id uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: github_chat_thread_routes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.github_chat_thread_routes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    installation_id uuid NOT NULL,
    repo character varying(255) NOT NULL,
    subject_number integer NOT NULL,
    user_id text NOT NULL,
    chat_thread_id uuid NOT NULL,
    last_comment_id character varying(255),
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: github_installations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.github_installations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    installation_id character varying(255),
    encrypted_access_token text,
    default_compose_id uuid NOT NULL,
    repo_configs jsonb,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    target_type character varying(20),
    target_id character varying(255),
    target_name character varying(255),
    admin_github_user_id character varying(255),
    org_id text NOT NULL
);


--
-- Name: github_user_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.github_user_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    github_user_id character varying(255) NOT NULL,
    installation_id uuid NOT NULL,
    vm0_user_id text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: gmail_processed_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gmail_processed_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    watch_state_id uuid NOT NULL,
    pubsub_message_id character varying(255),
    history_id character varying(64) NOT NULL,
    message_id character varying(128) NOT NULL,
    thread_id character varying(128),
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    automation_id uuid NOT NULL
);


--
-- Name: gmail_watch_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gmail_watch_states (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id text NOT NULL,
    user_id text NOT NULL,
    connector_id uuid NOT NULL,
    email_address character varying(320) NOT NULL,
    topic_name text NOT NULL,
    last_history_id character varying(64) NOT NULL,
    watch_expiration_at timestamp without time zone NOT NULL,
    last_watch_renewed_at timestamp without time zone NOT NULL,
    needs_rewatch boolean DEFAULT false NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: google_calendar_event_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.google_calendar_event_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    watch_state_id uuid NOT NULL,
    calendar_event_id character varying(1024) NOT NULL,
    etag character varying(255),
    status character varying(64),
    event_type character varying(64),
    summary text,
    start_at timestamp without time zone,
    end_at timestamp without time zone,
    event_created_at timestamp without time zone,
    event_updated_at timestamp without time zone,
    snapshot jsonb,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: google_calendar_processed_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.google_calendar_processed_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    watch_state_id uuid NOT NULL,
    channel_id uuid NOT NULL,
    resource_state character varying(64) NOT NULL,
    calendar_event_id character varying(1024) NOT NULL,
    event_created_at timestamp without time zone,
    event_updated_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    event_change_key text DEFAULT 'created'::text NOT NULL,
    automation_id uuid NOT NULL
);


--
-- Name: google_calendar_watch_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.google_calendar_watch_states (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id text NOT NULL,
    user_id text NOT NULL,
    connector_id uuid NOT NULL,
    calendar_id text NOT NULL,
    channel_id uuid NOT NULL,
    channel_token character varying(255) NOT NULL,
    resource_id character varying(255) NOT NULL,
    resource_uri text NOT NULL,
    sync_token text,
    watch_expiration_at timestamp without time zone NOT NULL,
    last_watch_renewed_at timestamp without time zone NOT NULL,
    needs_rewatch boolean DEFAULT false NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: google_workspace_event_subscription_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.google_workspace_event_subscription_states (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id text NOT NULL,
    user_id text NOT NULL,
    connector_id uuid NOT NULL,
    provider character varying(64) NOT NULL,
    target_resource text NOT NULL,
    event_types jsonb NOT NULL,
    event_types_key text NOT NULL,
    subscription_name character varying(255) NOT NULL,
    pubsub_topic text NOT NULL,
    state character varying(64),
    expire_time timestamp without time zone NOT NULL,
    last_renewed_at timestamp without time zone NOT NULL,
    needs_repair boolean DEFAULT false NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: google_workspace_processed_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.google_workspace_processed_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    subscription_state_id uuid NOT NULL,
    pubsub_message_id character varying(255),
    cloud_event_id character varying(255) NOT NULL,
    cloud_event_type character varying(255) NOT NULL,
    conference_record_name text,
    transcript_name text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    automation_id uuid NOT NULL
);


--
-- Name: hosted_deployments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hosted_deployments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    site_id uuid NOT NULL,
    org_id text NOT NULL,
    user_id text NOT NULL,
    run_id text,
    status character varying(32) DEFAULT 'uploading'::character varying NOT NULL,
    r2_prefix text NOT NULL,
    manifest jsonb NOT NULL,
    manifest_hash character varying(64) NOT NULL,
    content_hash character varying(64) NOT NULL,
    entrypoint text DEFAULT '/index.html'::text NOT NULL,
    spa_fallback boolean DEFAULT false NOT NULL,
    file_count integer NOT NULL,
    size_bytes bigint NOT NULL,
    url text NOT NULL,
    error text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    ready_at timestamp without time zone,
    deployment_version integer,
    artifact_url text
);


--
-- Name: hosted_sites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hosted_sites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id text NOT NULL,
    user_id text NOT NULL,
    slug character varying(64) NOT NULL,
    public_slug character varying(96) NOT NULL,
    active_deployment_id uuid,
    created_from_run_id text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    deleted_at timestamp without time zone,
    active_deployment_version integer,
    next_deployment_version integer DEFAULT 1 NOT NULL,
    requested_slug character varying(64),
    chat_thread_id uuid
);


--
-- Name: image_artifact_edit_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.image_artifact_edit_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id text NOT NULL,
    user_id text NOT NULL,
    artifact_url text NOT NULL,
    snapshot jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: image_artifacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.image_artifacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    file_id uuid NOT NULL,
    generation_job_id uuid,
    model text,
    provider text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: insights_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.insights_daily (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id text NOT NULL,
    user_id text,
    date date NOT NULL,
    data jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: mail_drafts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mail_drafts (
    id uuid NOT NULL,
    draft jsonb,
    chat_thread_id uuid,
    connector_id uuid,
    gmail_draft_id text,
    gmail_thread_id text,
    gmail_message_id text,
    sent_gmail_message_id text,
    status text,
    sender_name text,
    sender_address text,
    subject text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    sent_at timestamp without time zone,
    follow_up_automation_id uuid
);


--
-- Name: model_provider_auth_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.model_provider_auth_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id text NOT NULL,
    user_id text NOT NULL,
    connector_type character varying(50) NOT NULL,
    source character varying(50) NOT NULL,
    status public.model_provider_auth_session_status DEFAULT 'initializing'::public.model_provider_auth_session_status NOT NULL,
    sandbox_id character varying(255),
    approval_url text,
    verification_code character varying(128),
    encrypted_provider_state text,
    error_message text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    completed_at timestamp without time zone,
    cancelled_at timestamp without time zone
);


--
-- Name: model_provider_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.model_provider_connections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id text NOT NULL,
    display_name character varying(128) NOT NULL,
    secret_id uuid NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: model_provider_surfaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.model_provider_surfaces (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    connection_id uuid NOT NULL,
    protocol character varying(32) NOT NULL,
    api_base_url text NOT NULL,
    auth_header_name character varying(128) NOT NULL,
    auth_header_template text NOT NULL,
    model_mappings jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_model_provider_surfaces_protocol CHECK (((protocol)::text = ANY ((ARRAY['anthropic-messages'::character varying, 'openai-responses'::character varying])::text[])))
);


--
-- Name: model_providers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.model_providers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    type character varying(50) NOT NULL,
    secret_id uuid,
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    selected_model character varying(255),
    auth_method character varying(50),
    user_id text NOT NULL,
    org_id text NOT NULL,
    token_expires_at timestamp without time zone,
    needs_reconnect boolean DEFAULT false NOT NULL,
    last_refresh_error_code character varying(64),
    workspace_name character varying(255),
    plan_type character varying(32),
    subscription_reset_period character varying(64),
    subscription_next_reset_at timestamp without time zone
);


--
-- Name: model_stat; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.model_stat (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    hour_start timestamp without time zone NOT NULL,
    model character varying(255) NOT NULL,
    input_tokens bigint DEFAULT 0 NOT NULL,
    output_tokens bigint DEFAULT 0 NOT NULL,
    cache_read_input_tokens bigint DEFAULT 0 NOT NULL,
    cache_creation_input_tokens bigint DEFAULT 0 NOT NULL,
    total_tokens bigint DEFAULT 0 NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: model_usage_observation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.model_usage_observation (
    idempotency_key uuid NOT NULL,
    model character varying(255) NOT NULL,
    input_tokens bigint NOT NULL,
    output_tokens bigint NOT NULL,
    cache_read_input_tokens bigint NOT NULL,
    cache_creation_input_tokens bigint NOT NULL,
    observed_at timestamp without time zone DEFAULT now() NOT NULL,
    aggregated_at timestamp without time zone
);


--
-- Name: morning_brief_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.morning_brief_deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id text NOT NULL,
    user_id text NOT NULL,
    brief_date character varying(10) NOT NULL,
    status character varying(20) DEFAULT 'collecting'::character varying NOT NULL,
    run_id uuid,
    input_key text,
    output_key text,
    error text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: morning_brief_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.morning_brief_schedules (
    org_id text NOT NULL,
    user_id text NOT NULL,
    chat_thread_id uuid,
    next_run_at timestamp without time zone,
    last_success_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: notion_webhook_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notion_webhook_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    notion_event_id uuid NOT NULL,
    event_type character varying(64) NOT NULL,
    page_id uuid,
    received_at timestamp without time zone DEFAULT now() NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: notion_webhook_secrets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notion_webhook_secrets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    subscription_id uuid,
    encrypted_verification_token text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: notion_workflow_pending_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notion_workflow_pending_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    page_id uuid NOT NULL,
    event_family character varying(64) DEFAULT 'new_child_page'::character varying NOT NULL,
    status character varying(32) DEFAULT 'pending'::character varying NOT NULL,
    first_notion_event_id uuid NOT NULL,
    latest_notion_event_id uuid NOT NULL,
    first_event_at timestamp without time zone NOT NULL,
    latest_event_at timestamp without time zone NOT NULL,
    run_after timestamp without time zone NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    page_title text,
    page_url text,
    parent_title text,
    parent_url text,
    skip_reason text,
    last_error text,
    processed_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    scope_type character varying(32) NOT NULL,
    scope_id uuid NOT NULL,
    latest_event_context jsonb,
    automation_id uuid NOT NULL
);


--
-- Name: org_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_cache (
    org_id text NOT NULL,
    slug text NOT NULL,
    cached_at timestamp without time zone DEFAULT now() NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    created_by text
);


--
-- Name: org_concurrency_entitlements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_concurrency_entitlements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id text NOT NULL,
    stripe_subscription_id text NOT NULL,
    stripe_invoice_id text NOT NULL,
    stripe_invoice_line_id text NOT NULL,
    stripe_price_id text NOT NULL,
    slots integer NOT NULL,
    starts_at timestamp without time zone NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_org_concurrency_entitlements_slots CHECK ((slots > 0)),
    CONSTRAINT chk_org_concurrency_entitlements_window CHECK ((expires_at > starts_at))
);


--
-- Name: org_concurrency_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_concurrency_subscriptions (
    stripe_subscription_id text NOT NULL,
    org_id text NOT NULL,
    stripe_price_id text NOT NULL,
    slots integer NOT NULL,
    subscription_status character varying(20),
    current_period_end timestamp without time zone,
    cancel_at_period_end boolean DEFAULT false NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_org_concurrency_subscriptions_slots CHECK ((slots > 0))
);


--
-- Name: org_custom_connector_oauth_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_custom_connector_oauth_configs (
    connector_id uuid NOT NULL,
    org_id text NOT NULL,
    provider_adapter character varying(32) NOT NULL,
    client_id character varying(255) NOT NULL,
    encrypted_client_secret text NOT NULL,
    authorization_url text NOT NULL,
    token_url text NOT NULL,
    token_endpoint_auth_method character varying(32) NOT NULL,
    pkce_method character varying(8) NOT NULL,
    scopes text[] DEFAULT '{}'::text[] NOT NULL,
    authorization_params jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_org_custom_connector_oauth_configs_pkce_method CHECK (((pkce_method)::text = ANY ((ARRAY['none'::character varying, 'S256'::character varying])::text[]))),
    CONSTRAINT chk_org_custom_connector_oauth_configs_provider_adapter CHECK (((provider_adapter)::text = ANY ((ARRAY['standard'::character varying, 'feishu'::character varying])::text[]))),
    CONSTRAINT chk_org_custom_connector_oauth_configs_token_auth_method CHECK (((token_endpoint_auth_method)::text = ANY ((ARRAY['client_secret_basic'::character varying, 'client_secret_post'::character varying])::text[])))
);


--
-- Name: org_custom_connector_secrets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_custom_connector_secrets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    connector_id uuid NOT NULL,
    user_id text NOT NULL,
    org_id text NOT NULL,
    encrypted_value text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: org_custom_connector_values; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_custom_connector_values (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    connector_id uuid NOT NULL,
    user_id text NOT NULL,
    org_id text NOT NULL,
    kind character varying(16) NOT NULL,
    key character varying(64) NOT NULL,
    encrypted_value text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: org_custom_connectors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_custom_connectors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id text NOT NULL,
    slug character varying(64) NOT NULL,
    display_name character varying(128) NOT NULL,
    prefixes jsonb NOT NULL,
    header_name character varying(128) NOT NULL,
    header_template text NOT NULL,
    created_by text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    prefix_templates jsonb DEFAULT '[]'::jsonb NOT NULL,
    fields jsonb DEFAULT '[]'::jsonb NOT NULL,
    header_injections jsonb DEFAULT '[]'::jsonb NOT NULL,
    query_injections jsonb DEFAULT '[]'::jsonb NOT NULL,
    auth_mode character varying(16) DEFAULT 'manual'::character varying NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    permission_bundle_ref character varying(128),
    mcp_endpoint text,
    mcp_transport character varying(32),
    mcp_resource text,
    skill_markdown text,
    revision integer DEFAULT 1 NOT NULL,
    CONSTRAINT chk_org_custom_connectors_auth_mode CHECK (((auth_mode)::text = ANY ((ARRAY['manual'::character varying, 'oauth'::character varying])::text[]))),
    CONSTRAINT chk_org_custom_connectors_mcp CHECK ((((mcp_endpoint IS NULL) AND (mcp_transport IS NULL)) OR ((mcp_endpoint IS NOT NULL) AND ((mcp_transport)::text = 'streamable-http'::text)))),
    CONSTRAINT chk_org_custom_connectors_revision_positive CHECK ((revision > 0)),
    CONSTRAINT chk_org_custom_connectors_skill_size CHECK (((skill_markdown IS NULL) OR (octet_length(skill_markdown) <= 65536))),
    CONSTRAINT chk_org_custom_connectors_slug CHECK (("left"((slug)::text, 1) = '_'::text))
);


--
-- Name: org_members_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_members_cache (
    org_id text NOT NULL,
    user_id text NOT NULL,
    cached_at timestamp without time zone DEFAULT now() NOT NULL,
    role text DEFAULT 'member'::text NOT NULL
);


--
-- Name: org_members_metadata; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_members_metadata (
    org_id text NOT NULL,
    user_id text NOT NULL,
    timezone text,
    pinned_agent_ids jsonb DEFAULT '[]'::jsonb,
    send_mode text DEFAULT 'enter'::text NOT NULL,
    onboarding_done boolean DEFAULT false NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    capture_network_bodies_remaining integer DEFAULT 0,
    selected_model character varying(255),
    onboarding_role text,
    morning_brief_enabled boolean DEFAULT false NOT NULL,
    locale text
);


--
-- Name: org_metadata; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_metadata (
    org_id text NOT NULL,
    credits bigint DEFAULT 0 NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    tier text DEFAULT 'limited-free-1'::text NOT NULL,
    stripe_customer_id text,
    stripe_subscription_id text,
    subscription_status character varying(20),
    current_period_end timestamp without time zone,
    last_processed_invoice_id text,
    auto_recharge_enabled boolean DEFAULT false NOT NULL,
    auto_recharge_threshold bigint,
    auto_recharge_amount bigint,
    auto_recharge_pending_at timestamp without time zone,
    default_agent_id uuid,
    cancel_at_period_end boolean DEFAULT false NOT NULL,
    onboarding_payment_pending boolean DEFAULT false NOT NULL,
    pending_subscription_schedule_id text,
    pending_subscription_target_tier text,
    pending_subscription_change_at timestamp without time zone,
    onboarding_complete boolean DEFAULT false NOT NULL
);


--
-- Name: org_model_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_model_policies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id text NOT NULL,
    model character varying(255) NOT NULL,
    default_provider_type character varying(50) DEFAULT 'vm0'::character varying NOT NULL,
    credential_scope character varying(20) DEFAULT 'org'::character varying NOT NULL,
    model_provider_id uuid,
    created_by_user_id text,
    updated_by_user_id text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    model_provider_surface_id uuid,
    CONSTRAINT chk_org_model_policies_builtin_route_no_provider_id CHECK ((((default_provider_type)::text <> 'vm0'::text) OR ((model_provider_id IS NULL) AND (model_provider_surface_id IS NULL)))),
    CONSTRAINT chk_org_model_policies_credential_scope CHECK (((credential_scope)::text = ANY ((ARRAY['org'::character varying, 'member'::character varying])::text[]))),
    CONSTRAINT chk_org_model_policies_member_scope_no_provider_id CHECK ((((credential_scope)::text <> 'member'::text) OR ((model_provider_id IS NULL) AND (model_provider_surface_id IS NULL)))),
    CONSTRAINT chk_org_model_policies_member_scope_oauth_provider CHECK ((((credential_scope)::text <> 'member'::text) OR ((default_provider_type)::text = ANY ((ARRAY['claude-code-oauth-token'::character varying, 'codex-oauth-token'::character varying])::text[])))),
    CONSTRAINT chk_org_model_policies_oauth_provider_member_scope CHECK ((((default_provider_type)::text <> ALL ((ARRAY['claude-code-oauth-token'::character varying, 'codex-oauth-token'::character varying])::text[])) OR ((credential_scope)::text = 'member'::text))),
    CONSTRAINT chk_org_model_policies_one_route_id CHECK (((model_provider_id IS NULL) OR (model_provider_surface_id IS NULL)))
);


--
-- Name: org_plan_entitlements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_plan_entitlements (
    org_id text NOT NULL,
    plan_key text NOT NULL,
    plan_rank integer NOT NULL,
    source character varying(50) NOT NULL,
    status character varying(30) DEFAULT 'active'::character varying NOT NULL,
    base_concurrency_limit integer DEFAULT 0 NOT NULL,
    can_buy_concurrency boolean DEFAULT false NOT NULL,
    auto_recharge_allowed boolean DEFAULT false NOT NULL,
    support_byok boolean DEFAULT false NOT NULL,
    restricted_vm0_models boolean DEFAULT true NOT NULL,
    video_generation_allowed boolean DEFAULT false NOT NULL,
    audio_lifetime_limit integer,
    audio_daily_rate_limit integer DEFAULT 0 NOT NULL,
    audio_daily_duration_seconds integer DEFAULT 0 NOT NULL,
    stripe_subscription_id text,
    stripe_product_id text,
    stripe_price_id text,
    current_period_start timestamp without time zone,
    current_period_end timestamp without time zone,
    cancel_at timestamp without time zone,
    expires_at timestamp without time zone,
    metadata_version text DEFAULT '1'::text NOT NULL,
    metadata_hash text,
    source_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    workflow_webhook_trigger_allowed boolean DEFAULT false NOT NULL,
    can_buy_credits boolean DEFAULT false NOT NULL,
    CONSTRAINT chk_org_plan_entitlements_audio_daily_duration CHECK ((audio_daily_duration_seconds >= 0)),
    CONSTRAINT chk_org_plan_entitlements_audio_daily_rate CHECK ((audio_daily_rate_limit >= 0)),
    CONSTRAINT chk_org_plan_entitlements_audio_lifetime CHECK (((audio_lifetime_limit IS NULL) OR (audio_lifetime_limit >= 0))),
    CONSTRAINT chk_org_plan_entitlements_base_concurrency CHECK ((base_concurrency_limit >= 0)),
    CONSTRAINT chk_org_plan_entitlements_period CHECK (((current_period_start IS NULL) OR (current_period_end IS NULL) OR (current_period_end > current_period_start))),
    CONSTRAINT chk_org_plan_entitlements_plan_rank CHECK ((plan_rank >= 0))
);


--
-- Name: org_promo_redemption; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_promo_redemption (
    org_id text NOT NULL,
    campaign_key text NOT NULL,
    stripe_session_id text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: org_usage_allowance_entitlements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_usage_allowance_entitlements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id text NOT NULL,
    source character varying(50) DEFAULT 'manual'::character varying NOT NULL,
    status character varying(30) DEFAULT 'active'::character varying NOT NULL,
    short_window_seconds integer NOT NULL,
    short_window_units bigint NOT NULL,
    weekly_window_seconds integer DEFAULT 604800 NOT NULL,
    weekly_window_units bigint NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    effective_at timestamp without time zone DEFAULT now() NOT NULL,
    expires_at timestamp without time zone,
    stripe_customer_id text,
    stripe_subscription_id text,
    stripe_invoice_id text,
    CONSTRAINT chk_org_usage_allowance_entitlement_time CHECK (((expires_at IS NULL) OR (expires_at > effective_at))),
    CONSTRAINT chk_org_usage_allowance_short_window_seconds CHECK ((short_window_seconds > 0)),
    CONSTRAINT chk_org_usage_allowance_short_window_units CHECK ((short_window_units > 0)),
    CONSTRAINT chk_org_usage_allowance_weekly_window_seconds CHECK ((weekly_window_seconds > 0)),
    CONSTRAINT chk_org_usage_allowance_weekly_window_units CHECK ((weekly_window_units > 0))
);


--
-- Name: org_usage_allowance_windows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_usage_allowance_windows (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id text NOT NULL,
    entitlement_id uuid NOT NULL,
    kind character varying(20) NOT NULL,
    starts_at timestamp without time zone NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    unit_limit bigint NOT NULL,
    consumed_units bigint DEFAULT 0 NOT NULL,
    created_by_run_id uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_org_usage_allowance_windows_consumed CHECK ((consumed_units >= 0)),
    CONSTRAINT chk_org_usage_allowance_windows_kind CHECK (((kind)::text = ANY ((ARRAY['short'::character varying, 'weekly'::character varying])::text[]))),
    CONSTRAINT chk_org_usage_allowance_windows_limit CHECK ((unit_limit > 0)),
    CONSTRAINT chk_org_usage_allowance_windows_time CHECK ((expires_at > starts_at))
);


--
-- Name: presentation_artifacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.presentation_artifacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    hosted_site_id uuid NOT NULL,
    generation_job_id uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: push_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.push_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id text NOT NULL,
    endpoint text NOT NULL,
    p256dh text NOT NULL,
    auth text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: run_built_in_admissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_built_in_admissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    kind character varying(30) NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    completed_at timestamp without time zone,
    expires_at timestamp without time zone NOT NULL
);


--
-- Name: run_uploaded_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_uploaded_files (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid,
    source character varying(32) NOT NULL,
    external_id text NOT NULL,
    user_id text NOT NULL,
    org_id text,
    filename text,
    content_type text,
    size_bytes bigint,
    url text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    preview_image_url text,
    chat_thread_id uuid,
    asset_version integer,
    classification character varying(32),
    access_level character varying(16),
    materialization_status character varying(16),
    checksum_sha256 character varying(64),
    storage_key text,
    provenance jsonb,
    materialization_error jsonb,
    idempotency_scope text,
    idempotency_key text
);


--
-- Name: runner_job_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.runner_job_queue (
    run_id uuid NOT NULL,
    runner_group character varying(255) NOT NULL,
    execution_context jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    profile character varying(255) DEFAULT 'vm0/default'::character varying NOT NULL,
    session_id character varying(255),
    reuse_key character varying(263)
);


--
-- Name: runner_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.runner_state (
    runner_id uuid NOT NULL,
    runner_name character varying(255) NOT NULL,
    runner_group character varying(255) NOT NULL,
    total_vcpu integer DEFAULT 0 NOT NULL,
    total_memory_mb integer DEFAULT 0 NOT NULL,
    max_concurrent integer DEFAULT 0 NOT NULL,
    allocated_vcpu integer DEFAULT 0 NOT NULL,
    allocated_memory_mb integer DEFAULT 0 NOT NULL,
    running_count integer DEFAULT 0 NOT NULL,
    mode character varying(20) DEFAULT 'running'::character varying NOT NULL,
    last_seen_at timestamp without time zone NOT NULL,
    admittable_profiles jsonb DEFAULT '[]'::jsonb NOT NULL,
    heartbeat_generation bigint DEFAULT 0 NOT NULL,
    heartbeat_sequence bigint DEFAULT 0 NOT NULL,
    held_workspace_states jsonb DEFAULT '[]'::jsonb NOT NULL,
    held_sandbox_states jsonb DEFAULT '[]'::jsonb NOT NULL
);


--
-- Name: sandbox_telemetry; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sandbox_telemetry (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    data jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: secrets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.secrets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    encrypted_value text NOT NULL,
    description text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    type character varying(50) DEFAULT 'user'::character varying NOT NULL,
    user_id text NOT NULL,
    org_id text NOT NULL,
    connector_id uuid,
    CONSTRAINT chk_secrets_connector_owner_type CHECK ((((type)::text = 'connector'::text) = (connector_id IS NOT NULL)))
);


--
-- Name: skills; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.skills (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    url text NOT NULL,
    name text NOT NULL,
    full_path text NOT NULL,
    storage_id uuid,
    version_hash character varying(64),
    commit_sha character varying(40),
    frontmatter jsonb,
    s3_key text,
    size bigint DEFAULT 0 NOT NULL,
    file_count integer DEFAULT 0 NOT NULL,
    synced_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: slack_chat_ingress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.slack_chat_ingress (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    route_id uuid NOT NULL,
    event_id character varying(255) NOT NULL,
    payload text NOT NULL,
    status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    retry_count integer DEFAULT 0 NOT NULL,
    last_error text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_slack_chat_ingress_retry_count CHECK ((retry_count >= 0)),
    CONSTRAINT chk_slack_chat_ingress_status CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'processing'::character varying, 'processed'::character varying, 'failed'::character varying])::text[])))
);


--
-- Name: slack_chat_thread_routes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.slack_chat_thread_routes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    connection_id uuid NOT NULL,
    channel_id character varying(255) NOT NULL,
    thread_ts character varying(255) NOT NULL,
    user_id text NOT NULL,
    chat_thread_id uuid NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: slack_org_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.slack_org_connections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slack_user_id character varying(255) NOT NULL,
    slack_workspace_id character varying(255) NOT NULL,
    vm0_user_id text NOT NULL,
    dm_welcome_sent boolean DEFAULT false NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: slack_org_installations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.slack_org_installations (
    slack_workspace_id character varying(255) NOT NULL,
    slack_workspace_name character varying(255),
    org_id text,
    encrypted_bot_token text NOT NULL,
    bot_user_id character varying(255) NOT NULL,
    installed_by_user_id text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    bot_scopes text
);


--
-- Name: slack_user_agent_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.slack_user_agent_preferences (
    vm0_user_id text NOT NULL,
    org_id text NOT NULL,
    selected_compose_id uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: storage_version_lineage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.storage_version_lineage (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    storage_id uuid NOT NULL,
    version_id character varying(64) NOT NULL,
    parent_version_id character varying(64) NOT NULL,
    run_id uuid NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: storage_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.storage_versions (
    id character varying(64) NOT NULL,
    storage_id uuid NOT NULL,
    s3_key text NOT NULL,
    size bigint DEFAULT 0 NOT NULL,
    file_count integer DEFAULT 0 NOT NULL,
    message text,
    created_by text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    archive_size bigint NOT NULL,
    CONSTRAINT chk_storage_versions_archive_size_nonnegative CHECK ((archive_size >= 0))
);


--
-- Name: storages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.storages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id text NOT NULL,
    name character varying(256) NOT NULL,
    s3_prefix text NOT NULL,
    size bigint DEFAULT 0 NOT NULL,
    file_count integer DEFAULT 0 NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    head_version_id character varying(64),
    org_id text NOT NULL
);


--
-- Name: strapi_integrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.strapi_integrations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id text NOT NULL,
    created_by_user_id text NOT NULL,
    name character varying(128) NOT NULL,
    base_url text NOT NULL,
    normalized_base_url text NOT NULL,
    token_hash text NOT NULL,
    encrypted_token text NOT NULL,
    secret_last_four character varying(4) NOT NULL,
    last_tested_at timestamp without time zone,
    last_received_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: strapi_webhook_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.strapi_webhook_deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    integration_id uuid NOT NULL,
    body_sha256 text NOT NULL,
    event character varying(64) NOT NULL,
    received_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: strapi_workflow_pending_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.strapi_workflow_pending_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    automation_id uuid NOT NULL,
    integration_id uuid NOT NULL,
    uid character varying(255) NOT NULL,
    model character varying(255) NOT NULL,
    document_id character varying(255) NOT NULL,
    locales text[] NOT NULL,
    status character varying(32) DEFAULT 'pending'::character varying NOT NULL,
    first_event_at timestamp without time zone NOT NULL,
    latest_event_at timestamp without time zone NOT NULL,
    run_after timestamp without time zone NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    last_error text,
    skip_reason text,
    processed_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: system_storage_presigned_url_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_storage_presigned_url_cache (
    cache_key character varying(64) NOT NULL,
    bucket text NOT NULL,
    object_key text NOT NULL,
    storage_version_id character varying(64) NOT NULL,
    public_endpoint boolean NOT NULL,
    ttl_seconds integer NOT NULL,
    presigned_url text NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    refresh_after timestamp without time zone NOT NULL,
    last_requested_at timestamp without time zone NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    scope character varying(64) DEFAULT 'system_storage'::character varying NOT NULL,
    resolved_org_id text
);


--
-- Name: teams_chat_thread_routes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.teams_chat_thread_routes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    connection_id uuid NOT NULL,
    conversation_id character varying(255) NOT NULL,
    thread_id character varying(255) NOT NULL,
    user_id text NOT NULL,
    chat_thread_id uuid NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: teams_org_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.teams_org_connections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    teams_user_id character varying(255),
    teams_tenant_id character varying(255) NOT NULL,
    vm0_user_id text NOT NULL,
    teams_user_display_name character varying(255),
    teams_user_principal_name character varying(255),
    dm_welcome_sent boolean DEFAULT false NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    teams_aad_object_id character varying(255)
);


--
-- Name: teams_org_installations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.teams_org_installations (
    teams_tenant_id character varying(255) NOT NULL,
    teams_tenant_name character varying(255),
    teams_team_id character varying(255),
    teams_team_name character varying(255),
    teams_app_id character varying(255),
    bot_id character varying(255),
    bot_name character varying(255),
    service_url text,
    org_id text,
    installed_by_user_id text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: teams_user_agent_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.teams_user_agent_preferences (
    vm0_user_id text NOT NULL,
    org_id text NOT NULL,
    selected_compose_id uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: telegram_chat_thread_routes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.telegram_chat_thread_routes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    telegram_user_link_id uuid,
    telegram_official_user_link_id uuid,
    chat_id character varying(255) NOT NULL,
    root_message_id character varying(255) NOT NULL,
    chat_thread_id uuid NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_telegram_chat_thread_routes_one_owner CHECK (((telegram_user_link_id IS NOT NULL) <> (telegram_official_user_link_id IS NOT NULL)))
);


--
-- Name: telegram_installations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.telegram_installations (
    telegram_bot_id character varying(255) NOT NULL,
    bot_username character varying(255),
    encrypted_bot_token text NOT NULL,
    webhook_secret character varying(255) NOT NULL,
    default_compose_id uuid NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    owner_user_id text NOT NULL,
    org_id text NOT NULL
);


--
-- Name: telegram_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.telegram_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    chat_id character varying(255) NOT NULL,
    message_id character varying(255) NOT NULL,
    from_user_id character varying(255) NOT NULL,
    from_username character varying(255),
    text text,
    is_bot boolean DEFAULT false NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    file_id character varying(255),
    installation_id character varying(255),
    file_type character varying(32),
    file_name text,
    file_mime_type character varying(255),
    file_size integer,
    file_width integer,
    file_height integer,
    file_duration integer,
    entities jsonb,
    from_display_name character varying(255),
    official_org_id text,
    official_user_link_id uuid,
    CONSTRAINT chk_telegram_messages_one_owner CHECK (((installation_id IS NOT NULL) <> (official_org_id IS NOT NULL)))
);


--
-- Name: telegram_official_user_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.telegram_official_user_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    telegram_user_id character varying(255) NOT NULL,
    telegram_username character varying(255),
    telegram_display_name character varying(255),
    vm0_user_id text NOT NULL,
    org_id text NOT NULL,
    dm_welcome_sent boolean DEFAULT false NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: telegram_user_agent_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.telegram_user_agent_preferences (
    vm0_user_id text NOT NULL,
    org_id text NOT NULL,
    selected_compose_id uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: telegram_user_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.telegram_user_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    telegram_user_id character varying(255) NOT NULL,
    vm0_user_id text NOT NULL,
    dm_welcome_sent boolean DEFAULT false NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    installation_id character varying(255) NOT NULL,
    telegram_username character varying(255),
    telegram_display_name character varying(255)
);


--
-- Name: thread_goals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.thread_goals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id text NOT NULL,
    owner_user_id text NOT NULL,
    agent_id uuid NOT NULL,
    chat_thread_id uuid NOT NULL,
    status character varying(16) NOT NULL,
    objective text NOT NULL,
    objective_brief text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT thread_goals_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'paused'::character varying, 'blocked'::character varying, 'complete'::character varying])::text[])))
);


--
-- Name: usage_allowance_allocations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.usage_allowance_allocations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    usage_event_id uuid NOT NULL,
    org_id text NOT NULL,
    run_id uuid,
    short_window_id uuid NOT NULL,
    weekly_window_id uuid NOT NULL,
    units_applied bigint NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_usage_allowance_allocations_units CHECK ((units_applied > 0))
);


--
-- Name: usage_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.usage_daily (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id text NOT NULL,
    date date NOT NULL,
    run_count integer DEFAULT 0 NOT NULL,
    run_time_ms bigint DEFAULT 0 NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    org_id text NOT NULL
);


--
-- Name: usage_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.usage_event (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid,
    idempotency_key uuid NOT NULL,
    org_id text NOT NULL,
    user_id text NOT NULL,
    kind character varying(30) NOT NULL,
    provider character varying(100) NOT NULL,
    category character varying(100) NOT NULL,
    quantity bigint NOT NULL,
    credits_charged bigint,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    processed_at timestamp without time zone,
    billing_error character varying(50),
    gross_credits bigint
);


--
-- Name: usage_event_hourly_rollup; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.usage_event_hourly_rollup (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    processed_hour timestamp without time zone NOT NULL,
    org_id text NOT NULL,
    user_id text NOT NULL,
    run_id uuid,
    kind character varying(30) NOT NULL,
    provider character varying(100) NOT NULL,
    category character varying(100) NOT NULL,
    short_window_id uuid,
    weekly_window_id uuid,
    quantity bigint NOT NULL,
    credits_charged bigint NOT NULL,
    allowance_units bigint NOT NULL,
    CONSTRAINT chk_usage_event_hourly_rollup_allowance_units CHECK ((allowance_units >= 0)),
    CONSTRAINT chk_usage_event_hourly_rollup_allowance_window_pair CHECK ((((allowance_units = 0) AND (short_window_id IS NULL) AND (weekly_window_id IS NULL)) OR ((allowance_units > 0) AND (short_window_id IS NOT NULL) AND (weekly_window_id IS NOT NULL)))),
    CONSTRAINT chk_usage_event_hourly_rollup_credits_charged CHECK ((credits_charged >= 0)),
    CONSTRAINT chk_usage_event_hourly_rollup_processed_hour CHECK ((processed_hour = date_trunc('hour'::text, processed_hour))),
    CONSTRAINT chk_usage_event_hourly_rollup_quantity CHECK ((quantity >= 0))
);


--
-- Name: usage_pricing; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.usage_pricing (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind character varying(30) NOT NULL,
    provider character varying(100) NOT NULL,
    category character varying(100) NOT NULL,
    unit_price bigint NOT NULL,
    unit_size bigint NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: user_artifact_favorites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_artifact_favorites (
    org_id text NOT NULL,
    user_id text NOT NULL,
    artifact_url text NOT NULL
);


--
-- Name: user_behavior_count; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_behavior_count (
    org_id text NOT NULL,
    user_id text NOT NULL,
    behavior_key text NOT NULL,
    count integer DEFAULT 0 NOT NULL,
    first_at timestamp without time zone DEFAULT now() NOT NULL,
    last_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: user_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_cache (
    user_id text NOT NULL,
    email text NOT NULL,
    org_list_cached_at timestamp without time zone,
    cached_at timestamp without time zone DEFAULT now() NOT NULL,
    name text,
    image_url text
);


--
-- Name: user_connectors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_connectors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id text NOT NULL,
    user_id text NOT NULL,
    agent_id uuid NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    connector_slug character varying(64) NOT NULL
);


--
-- Name: user_custom_connectors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_custom_connectors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id text NOT NULL,
    user_id text NOT NULL,
    agent_id uuid NOT NULL,
    custom_connector_id uuid NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    connector_revision integer DEFAULT 1 NOT NULL,
    permission_names text[] DEFAULT '{}'::text[] NOT NULL,
    allow_all_mcp_tools boolean DEFAULT false NOT NULL,
    mcp_tool_names text[] DEFAULT '{}'::text[] NOT NULL,
    CONSTRAINT chk_user_custom_connectors_mcp_grant CHECK (((NOT allow_all_mcp_tools) OR (cardinality(mcp_tool_names) = 0)))
);


--
-- Name: user_feature_switches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_feature_switches (
    org_id text NOT NULL,
    user_id text NOT NULL,
    switches jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: user_permission_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_permission_grants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id text NOT NULL,
    user_id text NOT NULL,
    agent_id uuid NOT NULL,
    permission character varying(128) NOT NULL,
    action character varying(8) NOT NULL,
    expires_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    connector_slug character varying(64) NOT NULL,
    CONSTRAINT chk_user_permission_grants_action CHECK (((action)::text = ANY ((ARRAY['allow'::character varying, 'deny'::character varying])::text[])))
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    email_unsubscribed boolean DEFAULT false NOT NULL
);


--
-- Name: variables; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.variables (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    value text NOT NULL,
    description text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    user_id text NOT NULL,
    org_id text NOT NULL,
    type character varying(50) DEFAULT 'user'::character varying NOT NULL,
    connector_id uuid,
    CONSTRAINT chk_variables_connector_owner_type CHECK ((((type)::text = 'connector'::text) = (connector_id IS NOT NULL)))
);


--
-- Name: video_artifacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.video_artifacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    file_id uuid NOT NULL,
    generation_job_id uuid,
    model text,
    duration_seconds integer,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: vm0_api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vm0_api_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vendor character varying(50) NOT NULL,
    model character varying(255) NOT NULL,
    api_key text NOT NULL,
    label text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: workflow_user_automation_threads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_user_automation_threads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id text NOT NULL,
    user_id text NOT NULL,
    workflow_id uuid NOT NULL,
    chat_thread_id uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: zero_agent_drafts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.zero_agent_drafts (
    user_id text NOT NULL,
    org_id text NOT NULL,
    agent_id uuid NOT NULL,
    draft_attachments jsonb,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    draft_user_message jsonb,
    CONSTRAINT zero_agent_drafts_draft_user_message_check CHECK (((draft_user_message IS NOT NULL) OR (COALESCE(draft_attachments, '[]'::jsonb) = '[]'::jsonb)))
);


--
-- Name: zero_agents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.zero_agents (
    org_id text NOT NULL,
    name character varying(64) NOT NULL,
    display_name character varying(256),
    description text,
    sound character varying(64),
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    id uuid NOT NULL,
    avatar_url character varying(1024),
    owner text NOT NULL,
    model_provider_id uuid,
    selected_model character varying(255),
    prefer_personal_provider boolean DEFAULT false NOT NULL,
    visibility character varying(16) DEFAULT 'public'::character varying NOT NULL
);


--
-- Name: zero_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.zero_runs (
    id uuid NOT NULL,
    trigger_source character varying(20) NOT NULL,
    trigger_agent_id uuid,
    model_provider character varying(100),
    selected_model character varying(255),
    summary text,
    chat_thread_id uuid,
    model_provider_id uuid,
    model_provider_credential_scope character varying(20),
    run_group_id uuid,
    goal_id uuid,
    trigger_brief text,
    workflow_automation_id uuid,
    api_started_at timestamp without time zone,
    first_assistant_event_acknowledged_at timestamp without time zone
);


--
-- Name: zero_workflow_automations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.zero_workflow_automations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id text NOT NULL,
    workflow_id uuid NOT NULL,
    owner_user_id text NOT NULL,
    schedule_type character varying(16),
    cron_expression character varying(100),
    interval_seconds integer,
    at_time timestamp without time zone,
    timezone character varying(50) DEFAULT 'UTC'::character varying NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    next_run_at timestamp without time zone,
    last_run_at timestamp without time zone,
    last_run_id uuid,
    consecutive_failures integer DEFAULT 0 NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    kind character varying(16) DEFAULT 'schedule'::character varying NOT NULL,
    event_type character varying(64),
    event_config jsonb,
    CONSTRAINT zero_workflow_automations_schedule_config_check CHECK (((((kind)::text = 'schedule'::text) AND (event_type IS NULL) AND (event_config IS NULL) AND ((((schedule_type)::text = 'cron'::text) AND (cron_expression IS NOT NULL) AND (interval_seconds IS NULL) AND (at_time IS NULL)) OR (((schedule_type)::text = 'loop'::text) AND (interval_seconds IS NOT NULL) AND (cron_expression IS NULL) AND (at_time IS NULL)) OR (((schedule_type)::text = 'once'::text) AND (at_time IS NOT NULL) AND (cron_expression IS NULL) AND (interval_seconds IS NULL)))) OR (((kind)::text = 'event'::text) AND ((event_type)::text = ANY ((ARRAY['chat-run-finished'::character varying, 'gmail-new-message'::character varying, 'gmail-label-applied'::character varying, 'github-label-applied'::character varying, 'github-deployment-status-created'::character varying, 'github-issue-comment-created'::character varying, 'github-pull-request-review-submitted'::character varying, 'github-workflow-job-completed'::character varying, 'github-workflow-run-completed'::character varying, 'google-calendar-event-created'::character varying, 'google-calendar-event-updated'::character varying, 'google-calendar-event-cancelled'::character varying, 'google-meet-transcript-generated'::character varying, 'notion-child-page-created'::character varying, 'notion-database-item-created'::character varying, 'notion-page-content-updated'::character varying, 'strapi-entry-published'::character varying, 'webhook-received'::character varying])::text[])) AND (event_config IS NOT NULL) AND (schedule_type IS NULL) AND (cron_expression IS NULL) AND (interval_seconds IS NULL) AND (at_time IS NULL))))
);


--
-- Name: zero_workflow_github_processed_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.zero_workflow_github_processed_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    github_delivery_id character varying(255) NOT NULL,
    repo character varying(255) NOT NULL,
    subject_type character varying(32),
    subject_number integer,
    action character varying(64) NOT NULL,
    label_name_normalized character varying(255),
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    automation_id uuid NOT NULL
);


--
-- Name: zero_workflow_strapi_automations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.zero_workflow_strapi_automations (
    automation_id uuid NOT NULL,
    integration_id uuid NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: zero_workflow_webhook_automations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.zero_workflow_webhook_automations (
    automation_id uuid NOT NULL,
    token_hash text NOT NULL,
    encrypted_token text NOT NULL,
    encrypted_secret text NOT NULL,
    secret_last_four character varying(4) NOT NULL,
    last_received_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    disabled_reason character varying(64)
);


--
-- Name: zero_workflow_webhook_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.zero_workflow_webhook_deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    delivery_key text NOT NULL,
    body_sha256 text NOT NULL,
    status character varying(32) NOT NULL,
    run_id uuid,
    error_message text,
    received_at timestamp without time zone DEFAULT now() NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    automation_id uuid NOT NULL
);


--
-- Name: zero_workflows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.zero_workflows (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id text NOT NULL,
    name character varying(64) NOT NULL,
    display_name character varying(256),
    description text,
    created_by text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    visibility character varying(16) DEFAULT 'private'::character varying NOT NULL,
    owner_user_id text NOT NULL,
    agent_id uuid NOT NULL,
    instruction text,
    updated_by text NOT NULL
);


--
-- Name: agent_compose_versions agent_compose_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_compose_versions
    ADD CONSTRAINT agent_compose_versions_pkey PRIMARY KEY (id);


--
-- Name: agent_composes agent_composes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_composes
    ADD CONSTRAINT agent_composes_pkey PRIMARY KEY (id);


--
-- Name: agent_run_callbacks agent_run_callbacks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_run_callbacks
    ADD CONSTRAINT agent_run_callbacks_pkey PRIMARY KEY (id);


--
-- Name: agent_run_custom_connector_auth_refs agent_run_custom_connector_auth_refs_run_id_secret_name_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_run_custom_connector_auth_refs
    ADD CONSTRAINT agent_run_custom_connector_auth_refs_run_id_secret_name_pk PRIMARY KEY (run_id, secret_name);


--
-- Name: agent_run_queue agent_run_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_run_queue
    ADD CONSTRAINT agent_run_queue_pkey PRIMARY KEY (run_id);


--
-- Name: agent_runs agent_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_runs
    ADD CONSTRAINT agent_runs_pkey PRIMARY KEY (id);


--
-- Name: agent_sessions agent_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_sessions
    ADD CONSTRAINT agent_sessions_pkey PRIMARY KEY (id);


--
-- Name: agentphone_chat_thread_routes agentphone_chat_thread_routes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agentphone_chat_thread_routes
    ADD CONSTRAINT agentphone_chat_thread_routes_pkey PRIMARY KEY (id);


--
-- Name: agentphone_messages agentphone_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agentphone_messages
    ADD CONSTRAINT agentphone_messages_pkey PRIMARY KEY (id);


--
-- Name: agentphone_user_agent_preferences agentphone_user_agent_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agentphone_user_agent_preferences
    ADD CONSTRAINT agentphone_user_agent_preferences_pkey PRIMARY KEY (vm0_user_id, org_id);


--
-- Name: agentphone_user_links agentphone_user_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agentphone_user_links
    ADD CONSTRAINT agentphone_user_links_pkey PRIMARY KEY (id);


--
-- Name: agentphone_verification_send_cooldowns agentphone_verification_send_cooldowns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agentphone_verification_send_cooldowns
    ADD CONSTRAINT agentphone_verification_send_cooldowns_pkey PRIMARY KEY (scope, scope_key);


--
-- Name: archived_task_runs archived_task_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.archived_task_runs
    ADD CONSTRAINT archived_task_runs_pkey PRIMARY KEY (id);


--
-- Name: artifact_catalog_pending_files artifact_catalog_pending_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_catalog_pending_files
    ADD CONSTRAINT artifact_catalog_pending_files_pkey PRIMARY KEY (file_id);


--
-- Name: artifacts artifacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifacts
    ADD CONSTRAINT artifacts_pkey PRIMARY KEY (id);


--
-- Name: banking_access_audit_events banking_access_audit_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.banking_access_audit_events
    ADD CONSTRAINT banking_access_audit_events_pkey PRIMARY KEY (id);


--
-- Name: banking_accounts banking_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.banking_accounts
    ADD CONSTRAINT banking_accounts_pkey PRIMARY KEY (id);


--
-- Name: banking_agent_enablements banking_agent_enablements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.banking_agent_enablements
    ADD CONSTRAINT banking_agent_enablements_pkey PRIMARY KEY (id);


--
-- Name: banking_connections banking_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.banking_connections
    ADD CONSTRAINT banking_connections_pkey PRIMARY KEY (id);


--
-- Name: blobs blobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blobs
    ADD CONSTRAINT blobs_pkey PRIMARY KEY (hash);


--
-- Name: browser_authorization_requests browser_authorization_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_authorization_requests
    ADD CONSTRAINT browser_authorization_requests_pkey PRIMARY KEY (id);


--
-- Name: browser_profiles browser_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_profiles
    ADD CONSTRAINT browser_profiles_pkey PRIMARY KEY (id);


--
-- Name: browser_session_instances browser_session_instances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_session_instances
    ADD CONSTRAINT browser_session_instances_pkey PRIMARY KEY (provider_session_id);


--
-- Name: browser_session_resize_states browser_session_resize_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_session_resize_states
    ADD CONSTRAINT browser_session_resize_states_pkey PRIMARY KEY (provider_session_id);


--
-- Name: browser_session_tab_snapshots browser_session_tab_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_session_tab_snapshots
    ADD CONSTRAINT browser_session_tab_snapshots_pkey PRIMARY KEY (chat_thread_id);


--
-- Name: browser_sessions browser_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_sessions
    ADD CONSTRAINT browser_sessions_pkey PRIMARY KEY (id);


--
-- Name: browser_thread_profiles browser_thread_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_thread_profiles
    ADD CONSTRAINT browser_thread_profiles_pkey PRIMARY KEY (id);


--
-- Name: built_in_generation_jobs built_in_generation_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.built_in_generation_jobs
    ADD CONSTRAINT built_in_generation_jobs_pkey PRIMARY KEY (id);


--
-- Name: canonical_asset_deliveries canonical_asset_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_asset_deliveries
    ADD CONSTRAINT canonical_asset_deliveries_pkey PRIMARY KEY (id);


--
-- Name: chat_agentphone_context chat_agentphone_context_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_agentphone_context
    ADD CONSTRAINT chat_agentphone_context_pkey PRIMARY KEY (id);


--
-- Name: chat_automation_context chat_automation_context_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_automation_context
    ADD CONSTRAINT chat_automation_context_pkey PRIMARY KEY (id);


--
-- Name: chat_event_asset_refs chat_event_asset_refs_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_event_asset_refs
    ADD CONSTRAINT chat_event_asset_refs_pk PRIMARY KEY (chat_event_id, asset_id);


--
-- Name: chat_events chat_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_events
    ADD CONSTRAINT chat_events_pkey PRIMARY KEY (id);


--
-- Name: chat_feishu_context chat_feishu_context_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_feishu_context
    ADD CONSTRAINT chat_feishu_context_pkey PRIMARY KEY (id);


--
-- Name: chat_github_context chat_github_context_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_github_context
    ADD CONSTRAINT chat_github_context_pkey PRIMARY KEY (id);


--
-- Name: chat_goal_context chat_goal_context_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_goal_context
    ADD CONSTRAINT chat_goal_context_pkey PRIMARY KEY (id);


--
-- Name: chat_morning_brief_context chat_morning_brief_context_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_morning_brief_context
    ADD CONSTRAINT chat_morning_brief_context_pkey PRIMARY KEY (id);


--
-- Name: chat_output_materializations chat_output_materializations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_output_materializations
    ADD CONSTRAINT chat_output_materializations_pkey PRIMARY KEY (run_id);


--
-- Name: chat_slack_context chat_slack_context_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_slack_context
    ADD CONSTRAINT chat_slack_context_pkey PRIMARY KEY (id);


--
-- Name: chat_teams_context chat_teams_context_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_teams_context
    ADD CONSTRAINT chat_teams_context_pkey PRIMARY KEY (id);


--
-- Name: chat_telegram_context chat_telegram_context_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_telegram_context
    ADD CONSTRAINT chat_telegram_context_pkey PRIMARY KEY (id);


--
-- Name: chat_thread_event_sequences chat_thread_event_sequences_user_id_org_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_thread_event_sequences
    ADD CONSTRAINT chat_thread_event_sequences_user_id_org_id_pk PRIMARY KEY (user_id, org_id);


--
-- Name: chat_thread_events chat_thread_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_thread_events
    ADD CONSTRAINT chat_thread_events_pkey PRIMARY KEY (id);


--
-- Name: chat_thread_snapshots chat_thread_snapshots_user_id_org_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_thread_snapshots
    ADD CONSTRAINT chat_thread_snapshots_user_id_org_id_pk PRIMARY KEY (user_id, org_id);


--
-- Name: chat_threads chat_threads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_threads
    ADD CONSTRAINT chat_threads_pkey PRIMARY KEY (id);


--
-- Name: checkpoints checkpoints_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.checkpoints
    ADD CONSTRAINT checkpoints_pkey PRIMARY KEY (id);


--
-- Name: checkpoints checkpoints_run_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.checkpoints
    ADD CONSTRAINT checkpoints_run_id_unique UNIQUE (run_id);


--
-- Name: cli_tokens cli_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cli_tokens
    ADD CONSTRAINT cli_tokens_pkey PRIMARY KEY (id);


--
-- Name: cli_tokens cli_tokens_token_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cli_tokens
    ADD CONSTRAINT cli_tokens_token_unique UNIQUE (token);


--
-- Name: compose_jobs compose_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.compose_jobs
    ADD CONSTRAINT compose_jobs_pkey PRIMARY KEY (id);


--
-- Name: computer_use_authorization_requests computer_use_authorization_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.computer_use_authorization_requests
    ADD CONSTRAINT computer_use_authorization_requests_pkey PRIMARY KEY (id);


--
-- Name: computer_use_command_audit_events computer_use_command_audit_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.computer_use_command_audit_events
    ADD CONSTRAINT computer_use_command_audit_events_pkey PRIMARY KEY (id);


--
-- Name: computer_use_commands computer_use_commands_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.computer_use_commands
    ADD CONSTRAINT computer_use_commands_pkey PRIMARY KEY (id);


--
-- Name: computer_use_hosts computer_use_hosts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.computer_use_hosts
    ADD CONSTRAINT computer_use_hosts_pkey PRIMARY KEY (id);


--
-- Name: connector_catalog_active_snapshot connector_catalog_active_snapshot_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connector_catalog_active_snapshot
    ADD CONSTRAINT connector_catalog_active_snapshot_pk PRIMARY KEY (source_id, schema_version);


--
-- Name: connector_catalog_compatibility_evaluation connector_catalog_compatibility_evaluation_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connector_catalog_compatibility_evaluation
    ADD CONSTRAINT connector_catalog_compatibility_evaluation_pk PRIMARY KEY (source_id, schema_version, catalog_version, catalog_digest, executable_capability_digest);


--
-- Name: connector_catalog_sync_state connector_catalog_sync_state_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connector_catalog_sync_state
    ADD CONSTRAINT connector_catalog_sync_state_pk PRIMARY KEY (source_id, schema_version);


--
-- Name: connector_external_code_sessions connector_external_code_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connector_external_code_sessions
    ADD CONSTRAINT connector_external_code_sessions_pkey PRIMARY KEY (id);


--
-- Name: connector_oauth_device_authorization_sessions connector_oauth_device_authorization_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connector_oauth_device_authorization_sessions
    ADD CONSTRAINT connector_oauth_device_authorization_sessions_pkey PRIMARY KEY (id);


--
-- Name: connector_oauth_states connector_oauth_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connector_oauth_states
    ADD CONSTRAINT connector_oauth_states_pkey PRIMARY KEY (id);


--
-- Name: connectors connectors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connectors
    ADD CONSTRAINT connectors_pkey PRIMARY KEY (id);


--
-- Name: conversations conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);


--
-- Name: conversations conversations_run_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_run_id_unique UNIQUE (run_id);


--
-- Name: credit_expires_record credit_expires_record_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_expires_record
    ADD CONSTRAINT credit_expires_record_pkey PRIMARY KEY (id);


--
-- Name: desktop_auth_handoff_codes desktop_auth_handoff_codes_code_hash_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.desktop_auth_handoff_codes
    ADD CONSTRAINT desktop_auth_handoff_codes_code_hash_unique UNIQUE (code_hash);


--
-- Name: desktop_auth_handoff_codes desktop_auth_handoff_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.desktop_auth_handoff_codes
    ADD CONSTRAINT desktop_auth_handoff_codes_pkey PRIMARY KEY (id);


--
-- Name: device_codes device_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_codes
    ADD CONSTRAINT device_codes_pkey PRIMARY KEY (code);


--
-- Name: e2e_slack_mock_call_log e2e_slack_mock_call_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.e2e_slack_mock_call_log
    ADD CONSTRAINT e2e_slack_mock_call_log_pkey PRIMARY KEY (id);


--
-- Name: e2e_teams_mock_call_log e2e_teams_mock_call_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.e2e_teams_mock_call_log
    ADD CONSTRAINT e2e_teams_mock_call_log_pkey PRIMARY KEY (id);


--
-- Name: e2e_telegram_mock_call_log e2e_telegram_mock_call_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.e2e_telegram_mock_call_log
    ADD CONSTRAINT e2e_telegram_mock_call_log_pkey PRIMARY KEY (id);


--
-- Name: email_outbox email_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_outbox
    ADD CONSTRAINT email_outbox_pkey PRIMARY KEY (id);


--
-- Name: email_suppressions email_suppressions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_suppressions
    ADD CONSTRAINT email_suppressions_pkey PRIMARY KEY (id);


--
-- Name: export_jobs export_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.export_jobs
    ADD CONSTRAINT export_jobs_pkey PRIMARY KEY (id);


--
-- Name: feishu_chat_ingress feishu_chat_ingress_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feishu_chat_ingress
    ADD CONSTRAINT feishu_chat_ingress_pkey PRIMARY KEY (id);


--
-- Name: feishu_chat_thread_routes feishu_chat_thread_routes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feishu_chat_thread_routes
    ADD CONSTRAINT feishu_chat_thread_routes_pkey PRIMARY KEY (id);


--
-- Name: feishu_org_connections feishu_org_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feishu_org_connections
    ADD CONSTRAINT feishu_org_connections_pkey PRIMARY KEY (id);


--
-- Name: feishu_org_events feishu_org_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feishu_org_events
    ADD CONSTRAINT feishu_org_events_pkey PRIMARY KEY (installation_id, event_id);


--
-- Name: feishu_org_installations feishu_org_installations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feishu_org_installations
    ADD CONSTRAINT feishu_org_installations_pkey PRIMARY KEY (id);


--
-- Name: feishu_user_agent_preferences feishu_user_agent_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feishu_user_agent_preferences
    ADD CONSTRAINT feishu_user_agent_preferences_pkey PRIMARY KEY (vm0_user_id, org_id);


--
-- Name: github_chat_thread_routes github_chat_thread_routes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.github_chat_thread_routes
    ADD CONSTRAINT github_chat_thread_routes_pkey PRIMARY KEY (id);


--
-- Name: github_installations github_installations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.github_installations
    ADD CONSTRAINT github_installations_pkey PRIMARY KEY (id);


--
-- Name: github_user_links github_user_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.github_user_links
    ADD CONSTRAINT github_user_links_pkey PRIMARY KEY (id);


--
-- Name: gmail_processed_events gmail_processed_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gmail_processed_events
    ADD CONSTRAINT gmail_processed_events_pkey PRIMARY KEY (id);


--
-- Name: gmail_watch_states gmail_watch_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gmail_watch_states
    ADD CONSTRAINT gmail_watch_states_pkey PRIMARY KEY (id);


--
-- Name: google_calendar_event_snapshots google_calendar_event_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_calendar_event_snapshots
    ADD CONSTRAINT google_calendar_event_snapshots_pkey PRIMARY KEY (id);


--
-- Name: google_calendar_processed_events google_calendar_processed_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_calendar_processed_events
    ADD CONSTRAINT google_calendar_processed_events_pkey PRIMARY KEY (id);


--
-- Name: google_calendar_watch_states google_calendar_watch_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_calendar_watch_states
    ADD CONSTRAINT google_calendar_watch_states_pkey PRIMARY KEY (id);


--
-- Name: google_workspace_event_subscription_states google_workspace_event_subscription_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_workspace_event_subscription_states
    ADD CONSTRAINT google_workspace_event_subscription_states_pkey PRIMARY KEY (id);


--
-- Name: google_workspace_processed_events google_workspace_processed_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_workspace_processed_events
    ADD CONSTRAINT google_workspace_processed_events_pkey PRIMARY KEY (id);


--
-- Name: hosted_deployments hosted_deployments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hosted_deployments
    ADD CONSTRAINT hosted_deployments_pkey PRIMARY KEY (id);


--
-- Name: hosted_sites hosted_sites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hosted_sites
    ADD CONSTRAINT hosted_sites_pkey PRIMARY KEY (id);


--
-- Name: connectors idx_connectors_id_org_user; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connectors
    ADD CONSTRAINT idx_connectors_id_org_user UNIQUE (id, org_id, user_id);


--
-- Name: org_custom_connectors idx_org_custom_connectors_id_org; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_custom_connectors
    ADD CONSTRAINT idx_org_custom_connectors_id_org UNIQUE (id, org_id);


--
-- Name: image_artifact_edit_snapshots image_artifact_edit_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_artifact_edit_snapshots
    ADD CONSTRAINT image_artifact_edit_snapshots_pkey PRIMARY KEY (id);


--
-- Name: image_artifacts image_artifacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_artifacts
    ADD CONSTRAINT image_artifacts_pkey PRIMARY KEY (id);


--
-- Name: insights_daily insights_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insights_daily
    ADD CONSTRAINT insights_daily_pkey PRIMARY KEY (id);


--
-- Name: mail_drafts mail_drafts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mail_drafts
    ADD CONSTRAINT mail_drafts_pkey PRIMARY KEY (id);


--
-- Name: model_provider_auth_sessions model_provider_auth_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_provider_auth_sessions
    ADD CONSTRAINT model_provider_auth_sessions_pkey PRIMARY KEY (id);


--
-- Name: model_provider_connections model_provider_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_provider_connections
    ADD CONSTRAINT model_provider_connections_pkey PRIMARY KEY (id);


--
-- Name: model_provider_surfaces model_provider_surfaces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_provider_surfaces
    ADD CONSTRAINT model_provider_surfaces_pkey PRIMARY KEY (id);


--
-- Name: model_providers model_providers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_providers
    ADD CONSTRAINT model_providers_pkey PRIMARY KEY (id);


--
-- Name: model_stat model_stat_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_stat
    ADD CONSTRAINT model_stat_pkey PRIMARY KEY (id);


--
-- Name: model_usage_observation model_usage_observation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_usage_observation
    ADD CONSTRAINT model_usage_observation_pkey PRIMARY KEY (idempotency_key);


--
-- Name: morning_brief_deliveries morning_brief_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.morning_brief_deliveries
    ADD CONSTRAINT morning_brief_deliveries_pkey PRIMARY KEY (id);


--
-- Name: morning_brief_schedules morning_brief_schedules_org_id_user_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.morning_brief_schedules
    ADD CONSTRAINT morning_brief_schedules_org_id_user_id_pk PRIMARY KEY (org_id, user_id);


--
-- Name: notion_webhook_events notion_webhook_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notion_webhook_events
    ADD CONSTRAINT notion_webhook_events_pkey PRIMARY KEY (id);


--
-- Name: notion_webhook_secrets notion_webhook_secrets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notion_webhook_secrets
    ADD CONSTRAINT notion_webhook_secrets_pkey PRIMARY KEY (id);


--
-- Name: notion_workflow_pending_events notion_workflow_pending_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notion_workflow_pending_events
    ADD CONSTRAINT notion_workflow_pending_events_pkey PRIMARY KEY (id);


--
-- Name: org_cache org_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_cache
    ADD CONSTRAINT org_cache_pkey PRIMARY KEY (org_id);


--
-- Name: org_concurrency_entitlements org_concurrency_entitlements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_concurrency_entitlements
    ADD CONSTRAINT org_concurrency_entitlements_pkey PRIMARY KEY (id);


--
-- Name: org_concurrency_subscriptions org_concurrency_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_concurrency_subscriptions
    ADD CONSTRAINT org_concurrency_subscriptions_pkey PRIMARY KEY (stripe_subscription_id);


--
-- Name: org_custom_connector_oauth_configs org_custom_connector_oauth_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_custom_connector_oauth_configs
    ADD CONSTRAINT org_custom_connector_oauth_configs_pkey PRIMARY KEY (connector_id);


--
-- Name: org_custom_connector_secrets org_custom_connector_secrets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_custom_connector_secrets
    ADD CONSTRAINT org_custom_connector_secrets_pkey PRIMARY KEY (id);


--
-- Name: org_custom_connector_values org_custom_connector_values_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_custom_connector_values
    ADD CONSTRAINT org_custom_connector_values_pkey PRIMARY KEY (id);


--
-- Name: org_custom_connectors org_custom_connectors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_custom_connectors
    ADD CONSTRAINT org_custom_connectors_pkey PRIMARY KEY (id);


--
-- Name: org_members_cache org_members_cache_org_id_user_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_members_cache
    ADD CONSTRAINT org_members_cache_org_id_user_id_pk PRIMARY KEY (org_id, user_id);


--
-- Name: org_members_metadata org_members_metadata_org_id_user_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_members_metadata
    ADD CONSTRAINT org_members_metadata_org_id_user_id_pk PRIMARY KEY (org_id, user_id);


--
-- Name: org_metadata org_metadata_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_metadata
    ADD CONSTRAINT org_metadata_pkey PRIMARY KEY (org_id);


--
-- Name: org_model_policies org_model_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_model_policies
    ADD CONSTRAINT org_model_policies_pkey PRIMARY KEY (id);


--
-- Name: org_plan_entitlements org_plan_entitlements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_plan_entitlements
    ADD CONSTRAINT org_plan_entitlements_pkey PRIMARY KEY (org_id);


--
-- Name: org_usage_allowance_entitlements org_usage_allowance_entitlements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_usage_allowance_entitlements
    ADD CONSTRAINT org_usage_allowance_entitlements_pkey PRIMARY KEY (id);


--
-- Name: org_usage_allowance_windows org_usage_allowance_windows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_usage_allowance_windows
    ADD CONSTRAINT org_usage_allowance_windows_pkey PRIMARY KEY (id);


--
-- Name: presentation_artifacts presentation_artifacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.presentation_artifacts
    ADD CONSTRAINT presentation_artifacts_pkey PRIMARY KEY (id);


--
-- Name: push_subscriptions push_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: run_built_in_admissions run_built_in_admissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_built_in_admissions
    ADD CONSTRAINT run_built_in_admissions_pkey PRIMARY KEY (id);


--
-- Name: run_uploaded_files run_uploaded_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_uploaded_files
    ADD CONSTRAINT run_uploaded_files_pkey PRIMARY KEY (id);


--
-- Name: runner_job_queue runner_job_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runner_job_queue
    ADD CONSTRAINT runner_job_queue_pkey PRIMARY KEY (run_id);


--
-- Name: runner_state runner_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runner_state
    ADD CONSTRAINT runner_state_pkey PRIMARY KEY (runner_id);


--
-- Name: sandbox_telemetry sandbox_telemetry_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_telemetry
    ADD CONSTRAINT sandbox_telemetry_pkey PRIMARY KEY (id);


--
-- Name: secrets secrets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.secrets
    ADD CONSTRAINT secrets_pkey PRIMARY KEY (id);


--
-- Name: skills skills_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skills
    ADD CONSTRAINT skills_pkey PRIMARY KEY (id);


--
-- Name: skills skills_url_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skills
    ADD CONSTRAINT skills_url_unique UNIQUE (url);


--
-- Name: slack_chat_ingress slack_chat_ingress_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_chat_ingress
    ADD CONSTRAINT slack_chat_ingress_pkey PRIMARY KEY (id);


--
-- Name: slack_chat_thread_routes slack_chat_thread_routes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_chat_thread_routes
    ADD CONSTRAINT slack_chat_thread_routes_pkey PRIMARY KEY (id);


--
-- Name: slack_org_connections slack_org_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_org_connections
    ADD CONSTRAINT slack_org_connections_pkey PRIMARY KEY (id);


--
-- Name: slack_org_installations slack_org_installations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_org_installations
    ADD CONSTRAINT slack_org_installations_pkey PRIMARY KEY (slack_workspace_id);


--
-- Name: slack_user_agent_preferences slack_user_agent_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_user_agent_preferences
    ADD CONSTRAINT slack_user_agent_preferences_pkey PRIMARY KEY (vm0_user_id, org_id);


--
-- Name: storage_version_lineage storage_version_lineage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_version_lineage
    ADD CONSTRAINT storage_version_lineage_pkey PRIMARY KEY (id);


--
-- Name: storage_versions storage_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_versions
    ADD CONSTRAINT storage_versions_pkey PRIMARY KEY (id);


--
-- Name: storages storages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storages
    ADD CONSTRAINT storages_pkey PRIMARY KEY (id);


--
-- Name: strapi_integrations strapi_integrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strapi_integrations
    ADD CONSTRAINT strapi_integrations_pkey PRIMARY KEY (id);


--
-- Name: strapi_webhook_deliveries strapi_webhook_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strapi_webhook_deliveries
    ADD CONSTRAINT strapi_webhook_deliveries_pkey PRIMARY KEY (id);


--
-- Name: strapi_workflow_pending_events strapi_workflow_pending_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strapi_workflow_pending_events
    ADD CONSTRAINT strapi_workflow_pending_events_pkey PRIMARY KEY (id);


--
-- Name: system_storage_presigned_url_cache system_storage_presigned_url_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_storage_presigned_url_cache
    ADD CONSTRAINT system_storage_presigned_url_cache_pkey PRIMARY KEY (cache_key);


--
-- Name: teams_chat_thread_routes teams_chat_thread_routes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams_chat_thread_routes
    ADD CONSTRAINT teams_chat_thread_routes_pkey PRIMARY KEY (id);


--
-- Name: teams_org_connections teams_org_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams_org_connections
    ADD CONSTRAINT teams_org_connections_pkey PRIMARY KEY (id);


--
-- Name: teams_org_installations teams_org_installations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams_org_installations
    ADD CONSTRAINT teams_org_installations_pkey PRIMARY KEY (teams_tenant_id);


--
-- Name: teams_user_agent_preferences teams_user_agent_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams_user_agent_preferences
    ADD CONSTRAINT teams_user_agent_preferences_pkey PRIMARY KEY (vm0_user_id, org_id);


--
-- Name: telegram_chat_thread_routes telegram_chat_thread_routes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_chat_thread_routes
    ADD CONSTRAINT telegram_chat_thread_routes_pkey PRIMARY KEY (id);


--
-- Name: telegram_installations telegram_installations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_installations
    ADD CONSTRAINT telegram_installations_pkey PRIMARY KEY (telegram_bot_id);


--
-- Name: telegram_messages telegram_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_messages
    ADD CONSTRAINT telegram_messages_pkey PRIMARY KEY (id);


--
-- Name: telegram_official_user_links telegram_official_user_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_official_user_links
    ADD CONSTRAINT telegram_official_user_links_pkey PRIMARY KEY (id);


--
-- Name: telegram_user_agent_preferences telegram_user_agent_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_user_agent_preferences
    ADD CONSTRAINT telegram_user_agent_preferences_pkey PRIMARY KEY (vm0_user_id, org_id);


--
-- Name: telegram_user_links telegram_user_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_user_links
    ADD CONSTRAINT telegram_user_links_pkey PRIMARY KEY (id);


--
-- Name: thread_goals thread_goals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.thread_goals
    ADD CONSTRAINT thread_goals_pkey PRIMARY KEY (id);


--
-- Name: usage_allowance_allocations usage_allowance_allocations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_allowance_allocations
    ADD CONSTRAINT usage_allowance_allocations_pkey PRIMARY KEY (id);


--
-- Name: usage_daily usage_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_daily
    ADD CONSTRAINT usage_daily_pkey PRIMARY KEY (id);


--
-- Name: usage_event_hourly_rollup usage_event_hourly_rollup_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_event_hourly_rollup
    ADD CONSTRAINT usage_event_hourly_rollup_pkey PRIMARY KEY (id);


--
-- Name: usage_event usage_event_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_event
    ADD CONSTRAINT usage_event_pkey PRIMARY KEY (id);


--
-- Name: usage_pricing usage_pricing_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_pricing
    ADD CONSTRAINT usage_pricing_pkey PRIMARY KEY (id);


--
-- Name: user_artifact_favorites user_artifact_favorites_org_id_user_id_artifact_url_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_artifact_favorites
    ADD CONSTRAINT user_artifact_favorites_org_id_user_id_artifact_url_pk PRIMARY KEY (org_id, user_id, artifact_url);


--
-- Name: user_behavior_count user_behavior_count_org_id_user_id_behavior_key_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_behavior_count
    ADD CONSTRAINT user_behavior_count_org_id_user_id_behavior_key_pk PRIMARY KEY (org_id, user_id, behavior_key);


--
-- Name: user_cache user_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_cache
    ADD CONSTRAINT user_cache_pkey PRIMARY KEY (user_id);


--
-- Name: user_connectors user_connectors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_connectors
    ADD CONSTRAINT user_connectors_pkey PRIMARY KEY (id);


--
-- Name: user_custom_connectors user_custom_connectors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_custom_connectors
    ADD CONSTRAINT user_custom_connectors_pkey PRIMARY KEY (id);


--
-- Name: user_feature_switches user_feature_switches_org_id_user_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_feature_switches
    ADD CONSTRAINT user_feature_switches_org_id_user_id_pk PRIMARY KEY (org_id, user_id);


--
-- Name: user_permission_grants user_permission_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_permission_grants
    ADD CONSTRAINT user_permission_grants_pkey PRIMARY KEY (id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: variables variables_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.variables
    ADD CONSTRAINT variables_pkey PRIMARY KEY (id);


--
-- Name: video_artifacts video_artifacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.video_artifacts
    ADD CONSTRAINT video_artifacts_pkey PRIMARY KEY (id);


--
-- Name: vm0_api_keys vm0_api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vm0_api_keys
    ADD CONSTRAINT vm0_api_keys_pkey PRIMARY KEY (id);


--
-- Name: workflow_user_automation_threads workflow_user_automation_threads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_user_automation_threads
    ADD CONSTRAINT workflow_user_automation_threads_pkey PRIMARY KEY (id);


--
-- Name: zero_agents zero_agents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zero_agents
    ADD CONSTRAINT zero_agents_pkey PRIMARY KEY (id);


--
-- Name: zero_runs zero_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zero_runs
    ADD CONSTRAINT zero_runs_pkey PRIMARY KEY (id);


--
-- Name: zero_workflow_automations zero_workflow_automations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zero_workflow_automations
    ADD CONSTRAINT zero_workflow_automations_pkey PRIMARY KEY (id);


--
-- Name: zero_workflow_github_processed_events zero_workflow_github_processed_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zero_workflow_github_processed_events
    ADD CONSTRAINT zero_workflow_github_processed_events_pkey PRIMARY KEY (id);


--
-- Name: zero_workflow_strapi_automations zero_workflow_strapi_automations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zero_workflow_strapi_automations
    ADD CONSTRAINT zero_workflow_strapi_automations_pkey PRIMARY KEY (automation_id);


--
-- Name: zero_workflow_webhook_automations zero_workflow_webhook_automations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zero_workflow_webhook_automations
    ADD CONSTRAINT zero_workflow_webhook_automations_pkey PRIMARY KEY (automation_id);


--
-- Name: zero_workflow_webhook_deliveries zero_workflow_webhook_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zero_workflow_webhook_deliveries
    ADD CONSTRAINT zero_workflow_webhook_deliveries_pkey PRIMARY KEY (id);


--
-- Name: zero_workflows zero_workflows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zero_workflows
    ADD CONSTRAINT zero_workflows_pkey PRIMARY KEY (id);


--
-- Name: agent_run_queue_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_run_queue_expires_at_idx ON public.agent_run_queue USING btree (expires_at);


--
-- Name: agent_run_queue_org_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_run_queue_org_created_idx ON public.agent_run_queue USING btree (org_id, created_at);


--
-- Name: agent_run_queue_user_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_run_queue_user_created_idx ON public.agent_run_queue USING btree (user_id, created_at);


--
-- Name: artifact_catalog_pending_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX artifact_catalog_pending_owner_idx ON public.artifact_catalog_pending_files USING btree (org_id, author_user_id, queued_at, file_id);


--
-- Name: artifacts_author_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX artifacts_author_created_idx ON public.artifacts USING btree (org_id, author_user_id, created_at DESC NULLS LAST, id DESC NULLS LAST);


--
-- Name: artifacts_author_kind_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX artifacts_author_kind_created_idx ON public.artifacts USING btree (org_id, author_user_id, kind, created_at DESC NULLS LAST, id DESC NULLS LAST);


--
-- Name: artifacts_author_logical_key_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX artifacts_author_logical_key_unique ON public.artifacts USING btree (org_id, author_user_id, logical_key);


--
-- Name: artifacts_kind_entity_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX artifacts_kind_entity_unique ON public.artifacts USING btree (kind, entity_id);


--
-- Name: canonical_asset_deliveries_asset_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX canonical_asset_deliveries_asset_idx ON public.canonical_asset_deliveries USING btree (asset_id);


--
-- Name: canonical_asset_deliveries_asset_provider_operation_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX canonical_asset_deliveries_asset_provider_operation_unique ON public.canonical_asset_deliveries USING btree (asset_id, provider, operation_id);


--
-- Name: chat_automation_context_automation_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_automation_context_automation_id_idx ON public.chat_automation_context USING btree (automation_id);


--
-- Name: chat_event_asset_refs_asset_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_event_asset_refs_asset_idx ON public.chat_event_asset_refs USING btree (asset_id);


--
-- Name: chat_event_asset_refs_event_position_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX chat_event_asset_refs_event_position_unique ON public.chat_event_asset_refs USING btree (chat_event_id, "position");


--
-- Name: chat_events_input_automation_context_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_events_input_automation_context_idx ON public.chat_events USING btree (context_id) WHERE (event_type = 'input.automation'::text);


--
-- Name: chat_events_interrupts_run_id_not_null_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX chat_events_interrupts_run_id_not_null_unique ON public.chat_events USING btree (interrupts_run_id) WHERE (interrupts_run_id IS NOT NULL);


--
-- Name: chat_events_pending_queue_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_events_pending_queue_idx ON public.chat_events USING btree (chat_thread_id, created_at, id) WHERE ((run_id IS NULL) AND (event_type = ANY (ARRAY['input.prompt'::text, 'input.automation'::text, 'input.goal'::text])));


--
-- Name: chat_events_revokes_event_id_not_null_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX chat_events_revokes_event_id_not_null_unique ON public.chat_events USING btree (revokes_event_id) WHERE (revokes_event_id IS NOT NULL);


--
-- Name: chat_events_run_event_seq_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX chat_events_run_event_seq_unique ON public.chat_events USING btree (run_id, run_event_sequence_number);


--
-- Name: chat_events_run_seq_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX chat_events_run_seq_unique ON public.chat_events USING btree (run_id, sequence_number);


--
-- Name: chat_events_run_terminal_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX chat_events_run_terminal_unique ON public.chat_events USING btree (run_id) WHERE (event_type = ANY (ARRAY['run.completed'::text, 'run.failed'::text, 'run.cancelled'::text]));


--
-- Name: chat_events_run_thinking_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX chat_events_run_thinking_unique ON public.chat_events USING btree (run_id) WHERE (thinking IS NOT NULL);


--
-- Name: chat_events_thread_seq_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX chat_events_thread_seq_unique ON public.chat_events USING btree (chat_thread_id, seq_id);


--
-- Name: chat_events_usage_run_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_events_usage_run_id_idx ON public.chat_events USING btree (run_id) WHERE (usage_payload IS NOT NULL);


--
-- Name: chat_thread_events_user_org_seq_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX chat_thread_events_user_org_seq_unique ON public.chat_thread_events USING btree (user_id, org_id, seq_id);


--
-- Name: email_outbox_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_outbox_created_at_idx ON public.email_outbox USING btree (created_at);


--
-- Name: email_outbox_drain_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_outbox_drain_idx ON public.email_outbox USING btree (status, next_retry_at, created_at);


--
-- Name: email_suppressions_email_lower_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX email_suppressions_email_lower_idx ON public.email_suppressions USING btree (lower(email_address));


--
-- Name: github_installations_installation_id_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX github_installations_installation_id_unique ON public.github_installations USING btree (installation_id) WHERE (installation_id IS NOT NULL);


--
-- Name: idx_agent_compose_versions_compose_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_compose_versions_compose_id ON public.agent_compose_versions USING btree (compose_id);


--
-- Name: idx_agent_composes_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_composes_org ON public.agent_composes USING btree (org_id);


--
-- Name: idx_agent_composes_org_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_agent_composes_org_name ON public.agent_composes USING btree (org_id, name);


--
-- Name: idx_agent_run_callbacks_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_run_callbacks_pending ON public.agent_run_callbacks USING btree (status) WHERE ((status)::text = 'pending'::text);


--
-- Name: idx_agent_run_callbacks_run_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_run_callbacks_run_id ON public.agent_run_callbacks USING btree (run_id);


--
-- Name: idx_agent_run_custom_connector_auth_refs_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_run_custom_connector_auth_refs_expires ON public.agent_run_custom_connector_auth_refs USING btree (expires_at);


--
-- Name: idx_agent_runs_completed_org_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_runs_completed_org_user ON public.agent_runs USING btree (completed_at DESC NULLS LAST, org_id, user_id) WHERE (completed_at IS NOT NULL);


--
-- Name: idx_agent_runs_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_runs_org ON public.agent_runs USING btree (org_id);


--
-- Name: idx_agent_runs_org_status_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_runs_org_status_created ON public.agent_runs USING btree (org_id, status, created_at DESC NULLS LAST);


--
-- Name: idx_agent_runs_running_heartbeat; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_runs_running_heartbeat ON public.agent_runs USING btree (last_heartbeat_at) WHERE ((status)::text = 'running'::text);


--
-- Name: idx_agent_runs_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_runs_session ON public.agent_runs USING btree (session_id);


--
-- Name: idx_agent_runs_status_heartbeat; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_runs_status_heartbeat ON public.agent_runs USING btree (status, last_heartbeat_at);


--
-- Name: idx_agent_runs_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_runs_user_created ON public.agent_runs USING btree (user_id, created_at DESC NULLS LAST);


--
-- Name: idx_agent_sessions_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_sessions_org ON public.agent_sessions USING btree (org_id);


--
-- Name: idx_agent_sessions_user_compose; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_sessions_user_compose ON public.agent_sessions USING btree (user_id, agent_compose_id);


--
-- Name: idx_agentphone_chat_thread_routes_conversation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agentphone_chat_thread_routes_conversation ON public.agentphone_chat_thread_routes USING btree (conversation_id);


--
-- Name: idx_agentphone_chat_thread_routes_link_root; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_agentphone_chat_thread_routes_link_root ON public.agentphone_chat_thread_routes USING btree (agentphone_user_link_id, root_message_id);


--
-- Name: idx_agentphone_chat_thread_routes_user_link; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agentphone_chat_thread_routes_user_link ON public.agentphone_chat_thread_routes USING btree (agentphone_user_link_id);


--
-- Name: idx_agentphone_messages_agentphone_message; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_agentphone_messages_agentphone_message ON public.agentphone_messages USING btree (agentphone_message_id);


--
-- Name: idx_agentphone_messages_handle_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agentphone_messages_handle_created ON public.agentphone_messages USING btree (phone_handle, created_at);


--
-- Name: idx_agentphone_messages_user_link; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agentphone_messages_user_link ON public.agentphone_messages USING btree (agentphone_user_link_id);


--
-- Name: idx_agentphone_messages_webhook_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_agentphone_messages_webhook_id ON public.agentphone_messages USING btree (webhook_id) WHERE (webhook_id IS NOT NULL);


--
-- Name: idx_agentphone_user_links_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agentphone_user_links_org ON public.agentphone_user_links USING btree (org_id);


--
-- Name: idx_agentphone_user_links_phone_handle; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_agentphone_user_links_phone_handle ON public.agentphone_user_links USING btree (phone_handle);


--
-- Name: idx_agentphone_user_links_vm0_org; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_agentphone_user_links_vm0_org ON public.agentphone_user_links USING btree (vm0_user_id, org_id);


--
-- Name: idx_archived_task_runs_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_archived_task_runs_unique ON public.archived_task_runs USING btree (user_id, org_id, task_id, task_type);


--
-- Name: idx_banking_access_audit_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_banking_access_audit_created ON public.banking_access_audit_events USING btree (created_at);


--
-- Name: idx_banking_access_audit_org_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_banking_access_audit_org_user ON public.banking_access_audit_events USING btree (org_id, user_id);


--
-- Name: idx_banking_access_audit_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_banking_access_audit_run ON public.banking_access_audit_events USING btree (run_id);


--
-- Name: idx_banking_accounts_connection_provider_account; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_banking_accounts_connection_provider_account ON public.banking_accounts USING btree (connection_id, provider_account_id);


--
-- Name: idx_banking_accounts_org_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_banking_accounts_org_user ON public.banking_accounts USING btree (org_id, user_id);


--
-- Name: idx_banking_agent_enablements_agent_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_banking_agent_enablements_agent_user ON public.banking_agent_enablements USING btree (agent_id, user_id);


--
-- Name: idx_banking_agent_enablements_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_banking_agent_enablements_unique ON public.banking_agent_enablements USING btree (org_id, user_id, agent_id, connection_id);


--
-- Name: idx_banking_connections_org_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_banking_connections_org_user ON public.banking_connections USING btree (org_id, user_id);


--
-- Name: idx_banking_connections_owner_provider; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_banking_connections_owner_provider ON public.banking_connections USING btree (org_id, user_id, provider);


--
-- Name: idx_blobs_ref_count; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_blobs_ref_count ON public.blobs USING btree (ref_count);


--
-- Name: idx_browser_authorization_requests_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_browser_authorization_requests_expires ON public.browser_authorization_requests USING btree (expires_at);


--
-- Name: idx_browser_authorization_requests_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_browser_authorization_requests_owner ON public.browser_authorization_requests USING btree (org_id, user_id);


--
-- Name: idx_browser_session_instances_reconcile; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_browser_session_instances_reconcile ON public.browser_session_instances USING btree (status, updated_at);


--
-- Name: idx_browser_session_instances_run_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_browser_session_instances_run_status ON public.browser_session_instances USING btree (run_id, status);


--
-- Name: idx_browser_session_instances_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_browser_session_instances_session ON public.browser_session_instances USING btree (browser_session_id, created_at DESC NULLS LAST);


--
-- Name: idx_browser_session_instances_thread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_browser_session_instances_thread ON public.browser_session_instances USING btree (chat_thread_id, created_at DESC NULLS LAST);


--
-- Name: idx_browser_sessions_chat_thread_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_browser_sessions_chat_thread_created ON public.browser_sessions USING btree (chat_thread_id, created_at DESC NULLS LAST);


--
-- Name: idx_browser_sessions_owner_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_browser_sessions_owner_created ON public.browser_sessions USING btree (org_id, user_id, created_at DESC NULLS LAST);


--
-- Name: idx_browser_sessions_reconcile; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_browser_sessions_reconcile ON public.browser_sessions USING btree (status, updated_at);


--
-- Name: idx_browser_thread_profiles_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_browser_thread_profiles_owner ON public.browser_thread_profiles USING btree (org_id, user_id);


--
-- Name: idx_built_in_generation_jobs_org_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_built_in_generation_jobs_org_status ON public.built_in_generation_jobs USING btree (org_id, status);


--
-- Name: idx_built_in_generation_jobs_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_built_in_generation_jobs_run ON public.built_in_generation_jobs USING btree (run_id);


--
-- Name: idx_built_in_generation_jobs_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_built_in_generation_jobs_user_created ON public.built_in_generation_jobs USING btree (user_id, created_at DESC NULLS LAST);


--
-- Name: idx_chat_events_run_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_events_run_id ON public.chat_events USING btree (run_id);


--
-- Name: idx_chat_events_thread_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_events_thread_created ON public.chat_events USING btree (chat_thread_id, created_at);


--
-- Name: idx_chat_events_thread_run_terminal_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_events_thread_run_terminal_created ON public.chat_events USING btree (chat_thread_id, created_at DESC NULLS LAST) WHERE (event_type = ANY (ARRAY['run.completed'::text, 'run.failed'::text, 'run.cancelled'::text]));


--
-- Name: idx_chat_thread_events_thread_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_thread_events_thread_created ON public.chat_thread_events USING btree (chat_thread_id, created_at, id);


--
-- Name: idx_chat_thread_events_user_org_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_thread_events_user_org_created ON public.chat_thread_events USING btree (user_id, org_id, created_at, id);


--
-- Name: idx_chat_threads_user_compose_last_message; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_threads_user_compose_last_message ON public.chat_threads USING btree (user_id, agent_compose_id, last_message_at DESC NULLS LAST);


--
-- Name: idx_chat_threads_user_compose_pinned; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_threads_user_compose_pinned ON public.chat_threads USING btree (user_id, agent_compose_id) WHERE (pinned_at IS NOT NULL);


--
-- Name: idx_chat_threads_user_compose_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_threads_user_compose_updated ON public.chat_threads USING btree (user_id, agent_compose_id, updated_at DESC NULLS LAST);


--
-- Name: idx_chat_threads_user_last_read; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_threads_user_last_read ON public.chat_threads USING btree (user_id, last_read_at);


--
-- Name: idx_compose_jobs_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_compose_jobs_created ON public.compose_jobs USING btree (created_at);


--
-- Name: idx_compose_jobs_user_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_compose_jobs_user_active ON public.compose_jobs USING btree (user_id) WHERE status IN ('pending', 'running');


--
-- Name: idx_compose_jobs_user_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_compose_jobs_user_status ON public.compose_jobs USING btree (user_id, status);


--
-- Name: idx_computer_use_auth_requests_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_computer_use_auth_requests_expires ON public.computer_use_authorization_requests USING btree (expires_at);


--
-- Name: idx_computer_use_auth_requests_org_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_computer_use_auth_requests_org_user ON public.computer_use_authorization_requests USING btree (org_id, user_id);


--
-- Name: idx_computer_use_auth_requests_token_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_computer_use_auth_requests_token_hash ON public.computer_use_authorization_requests USING btree (request_token_hash);


--
-- Name: idx_computer_use_command_audit_command; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_computer_use_command_audit_command ON public.computer_use_command_audit_events USING btree (command_id);


--
-- Name: idx_computer_use_command_audit_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_computer_use_command_audit_created ON public.computer_use_command_audit_events USING btree (created_at);


--
-- Name: idx_computer_use_command_audit_org_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_computer_use_command_audit_org_user ON public.computer_use_command_audit_events USING btree (org_id, user_id);


--
-- Name: idx_computer_use_commands_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_computer_use_commands_created ON public.computer_use_commands USING btree (created_at);


--
-- Name: idx_computer_use_commands_host_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_computer_use_commands_host_status ON public.computer_use_commands USING btree (host_id, status);


--
-- Name: idx_computer_use_commands_org_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_computer_use_commands_org_user ON public.computer_use_commands USING btree (org_id, user_id);


--
-- Name: idx_computer_use_hosts_active_installation; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_computer_use_hosts_active_installation ON public.computer_use_hosts USING btree (org_id, user_id, installation_id) WHERE ((installation_id IS NOT NULL) AND (revoked_at IS NULL));


--
-- Name: idx_computer_use_hosts_last_seen; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_computer_use_hosts_last_seen ON public.computer_use_hosts USING btree (last_seen_at);


--
-- Name: idx_computer_use_hosts_org_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_computer_use_hosts_org_user ON public.computer_use_hosts USING btree (org_id, user_id);


--
-- Name: idx_computer_use_hosts_token_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_computer_use_hosts_token_hash ON public.computer_use_hosts USING btree (token_hash);


--
-- Name: idx_connector_external_code_sessions_expiration; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_connector_external_code_sessions_expiration ON public.connector_external_code_sessions USING btree (status, expires_at);


--
-- Name: idx_connector_external_code_sessions_owner_slug_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_connector_external_code_sessions_owner_slug_status ON public.connector_external_code_sessions USING btree (org_id, user_id, connector_slug, auth_method, status);


--
-- Name: idx_connector_external_code_sessions_token; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_connector_external_code_sessions_token ON public.connector_external_code_sessions USING btree (session_token_hash);


--
-- Name: idx_connector_oauth_device_authorization_sessions_expiration; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_connector_oauth_device_authorization_sessions_expiration ON public.connector_oauth_device_authorization_sessions USING btree (status, expires_at);


--
-- Name: idx_connector_oauth_device_authorization_sessions_token; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_connector_oauth_device_authorization_sessions_token ON public.connector_oauth_device_authorization_sessions USING btree (session_token_hash);


--
-- Name: idx_connector_oauth_device_sessions_owner_slug_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_connector_oauth_device_sessions_owner_slug_status ON public.connector_oauth_device_authorization_sessions USING btree (org_id, user_id, connector_slug, auth_method, status);


--
-- Name: idx_connector_oauth_states_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_connector_oauth_states_expires_at ON public.connector_oauth_states USING btree (expires_at);


--
-- Name: idx_connector_oauth_states_state; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_connector_oauth_states_state ON public.connector_oauth_states USING btree (state);


--
-- Name: idx_connector_oauth_states_user_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_connector_oauth_states_user_org ON public.connector_oauth_states USING btree (user_id, org_id);


--
-- Name: idx_connectors_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_connectors_org ON public.connectors USING btree (org_id);


--
-- Name: idx_connectors_org_user_custom_connector; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_connectors_org_user_custom_connector ON public.connectors USING btree (org_id, user_id, custom_connector_id) WHERE (custom_connector_id IS NOT NULL);


--
-- Name: idx_connectors_org_user_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_connectors_org_user_slug ON public.connectors USING btree (org_id, user_id, connector_slug) WHERE (connector_slug IS NOT NULL);


--
-- Name: idx_credit_expires_org_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_credit_expires_org_active ON public.credit_expires_record USING btree (org_id, expires_at) WHERE (remaining > 0);


--
-- Name: idx_desktop_auth_handoff_codes_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_desktop_auth_handoff_codes_expires ON public.desktop_auth_handoff_codes USING btree (expires_at);


--
-- Name: idx_desktop_auth_handoff_codes_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_desktop_auth_handoff_codes_user_created ON public.desktop_auth_handoff_codes USING btree (user_id, created_at);


--
-- Name: idx_e2e_slack_mock_call_log_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_e2e_slack_mock_call_log_created_at ON public.e2e_slack_mock_call_log USING btree (created_at);


--
-- Name: idx_e2e_slack_mock_call_log_method; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_e2e_slack_mock_call_log_method ON public.e2e_slack_mock_call_log USING btree (method);


--
-- Name: idx_e2e_teams_mock_call_log_conversation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_e2e_teams_mock_call_log_conversation ON public.e2e_teams_mock_call_log USING btree (conversation_id);


--
-- Name: idx_e2e_teams_mock_call_log_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_e2e_teams_mock_call_log_created_at ON public.e2e_teams_mock_call_log USING btree (created_at);


--
-- Name: idx_e2e_teams_mock_call_log_method; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_e2e_teams_mock_call_log_method ON public.e2e_teams_mock_call_log USING btree (method);


--
-- Name: idx_e2e_teams_mock_call_log_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_e2e_teams_mock_call_log_tenant ON public.e2e_teams_mock_call_log USING btree (tenant_id);


--
-- Name: idx_e2e_telegram_mock_call_log_chat_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_e2e_telegram_mock_call_log_chat_id ON public.e2e_telegram_mock_call_log USING btree (chat_id);


--
-- Name: idx_e2e_telegram_mock_call_log_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_e2e_telegram_mock_call_log_created_at ON public.e2e_telegram_mock_call_log USING btree (created_at);


--
-- Name: idx_e2e_telegram_mock_call_log_method; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_e2e_telegram_mock_call_log_method ON public.e2e_telegram_mock_call_log USING btree (method);


--
-- Name: idx_export_jobs_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_export_jobs_created ON public.export_jobs USING btree (created_at);


--
-- Name: idx_export_jobs_user_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_export_jobs_user_active ON public.export_jobs USING btree (user_id) WHERE status IN ('pending', 'running');


--
-- Name: idx_export_jobs_user_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_export_jobs_user_status ON public.export_jobs USING btree (user_id, status);


--
-- Name: idx_feishu_chat_ingress_installation_event; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_feishu_chat_ingress_installation_event ON public.feishu_chat_ingress USING btree (installation_id, event_id);


--
-- Name: idx_feishu_chat_thread_routes_conn_chat_thread_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_feishu_chat_thread_routes_conn_chat_thread_user ON public.feishu_chat_thread_routes USING btree (connection_id, chat_id, thread_id, user_id);


--
-- Name: idx_feishu_org_connections_installation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_feishu_org_connections_installation ON public.feishu_org_connections USING btree (installation_id);


--
-- Name: idx_feishu_org_connections_user_installation; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_feishu_org_connections_user_installation ON public.feishu_org_connections USING btree (feishu_open_id, installation_id);


--
-- Name: idx_feishu_org_connections_vm0_installation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_feishu_org_connections_vm0_installation ON public.feishu_org_connections USING btree (vm0_user_id, installation_id);


--
-- Name: idx_feishu_org_installations_app; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_feishu_org_installations_app ON public.feishu_org_installations USING btree (app_id);


--
-- Name: idx_feishu_org_installations_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_feishu_org_installations_org ON public.feishu_org_installations USING btree (org_id);


--
-- Name: idx_feishu_org_installations_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_feishu_org_installations_tenant ON public.feishu_org_installations USING btree (feishu_tenant_key);


--
-- Name: idx_github_chat_thread_routes_install_repo_subject_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_github_chat_thread_routes_install_repo_subject_user ON public.github_chat_thread_routes USING btree (installation_id, repo, subject_number, user_id);


--
-- Name: idx_github_installations_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_github_installations_org ON public.github_installations USING btree (org_id);


--
-- Name: idx_github_user_links_user_installation; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_github_user_links_user_installation ON public.github_user_links USING btree (github_user_id, installation_id);


--
-- Name: idx_gmail_processed_events_automation_event; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_gmail_processed_events_automation_event ON public.gmail_processed_events USING btree (watch_state_id, automation_id, history_id, message_id);


--
-- Name: idx_gmail_processed_events_pubsub_message; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gmail_processed_events_pubsub_message ON public.gmail_processed_events USING btree (pubsub_message_id);


--
-- Name: idx_gmail_watch_states_connector_topic; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_gmail_watch_states_connector_topic ON public.gmail_watch_states USING btree (connector_id, topic_name);


--
-- Name: idx_gmail_watch_states_email_topic; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gmail_watch_states_email_topic ON public.gmail_watch_states USING btree (email_address, topic_name);


--
-- Name: idx_gmail_watch_states_renewal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gmail_watch_states_renewal ON public.gmail_watch_states USING btree (watch_expiration_at);


--
-- Name: idx_google_calendar_event_snapshots_event; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_google_calendar_event_snapshots_event ON public.google_calendar_event_snapshots USING btree (watch_state_id, calendar_event_id);


--
-- Name: idx_google_calendar_event_snapshots_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_google_calendar_event_snapshots_updated ON public.google_calendar_event_snapshots USING btree (event_updated_at);


--
-- Name: idx_google_calendar_processed_events_automation_event; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_google_calendar_processed_events_automation_event ON public.google_calendar_processed_events USING btree (watch_state_id, automation_id, calendar_event_id, event_change_key);


--
-- Name: idx_google_calendar_processed_events_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_google_calendar_processed_events_channel ON public.google_calendar_processed_events USING btree (channel_id);


--
-- Name: idx_google_calendar_watch_states_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_google_calendar_watch_states_channel ON public.google_calendar_watch_states USING btree (channel_id);


--
-- Name: idx_google_calendar_watch_states_connector_calendar; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_google_calendar_watch_states_connector_calendar ON public.google_calendar_watch_states USING btree (connector_id, calendar_id);


--
-- Name: idx_google_calendar_watch_states_renewal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_google_calendar_watch_states_renewal ON public.google_calendar_watch_states USING btree (watch_expiration_at);


--
-- Name: idx_google_calendar_watch_states_resource; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_google_calendar_watch_states_resource ON public.google_calendar_watch_states USING btree (resource_id);


--
-- Name: idx_google_workspace_event_subscription_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_google_workspace_event_subscription_name ON public.google_workspace_event_subscription_states USING btree (subscription_name);


--
-- Name: idx_google_workspace_event_subscription_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_google_workspace_event_subscription_owner ON public.google_workspace_event_subscription_states USING btree (org_id, user_id, provider);


--
-- Name: idx_google_workspace_event_subscription_renewal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_google_workspace_event_subscription_renewal ON public.google_workspace_event_subscription_states USING btree (expire_time);


--
-- Name: idx_google_workspace_event_subscription_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_google_workspace_event_subscription_scope ON public.google_workspace_event_subscription_states USING btree (connector_id, provider, target_resource, pubsub_topic, event_types_key);


--
-- Name: idx_google_workspace_processed_events_automation_cloudevent; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_google_workspace_processed_events_automation_cloudevent ON public.google_workspace_processed_events USING btree (subscription_state_id, automation_id, cloud_event_id);


--
-- Name: idx_google_workspace_processed_events_automation_transcript; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_google_workspace_processed_events_automation_transcript ON public.google_workspace_processed_events USING btree (subscription_state_id, automation_id, transcript_name);


--
-- Name: idx_google_workspace_processed_events_pubsub_message; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_google_workspace_processed_events_pubsub_message ON public.google_workspace_processed_events USING btree (pubsub_message_id);


--
-- Name: idx_hosted_deployments_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hosted_deployments_org ON public.hosted_deployments USING btree (org_id);


--
-- Name: idx_hosted_deployments_site; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hosted_deployments_site ON public.hosted_deployments USING btree (site_id);


--
-- Name: idx_hosted_deployments_site_version; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_hosted_deployments_site_version ON public.hosted_deployments USING btree (site_id, deployment_version) WHERE (deployment_version IS NOT NULL);


--
-- Name: idx_hosted_deployments_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hosted_deployments_status ON public.hosted_deployments USING btree (status);


--
-- Name: idx_hosted_sites_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hosted_sites_org ON public.hosted_sites USING btree (org_id);


--
-- Name: idx_hosted_sites_org_chat_thread_requested_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_hosted_sites_org_chat_thread_requested_slug ON public.hosted_sites USING btree (org_id, chat_thread_id, requested_slug) WHERE ((chat_thread_id IS NOT NULL) AND (requested_slug IS NOT NULL));


--
-- Name: idx_hosted_sites_org_requested_slug_non_chat; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_hosted_sites_org_requested_slug_non_chat ON public.hosted_sites USING btree (org_id, requested_slug) WHERE ((chat_thread_id IS NULL) AND (requested_slug IS NOT NULL));


--
-- Name: idx_hosted_sites_org_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_hosted_sites_org_slug ON public.hosted_sites USING btree (org_id, slug);


--
-- Name: idx_hosted_sites_public_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_hosted_sites_public_slug ON public.hosted_sites USING btree (public_slug);


--
-- Name: idx_image_artifact_edit_snapshots_owner_artifact; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_image_artifact_edit_snapshots_owner_artifact ON public.image_artifact_edit_snapshots USING btree (org_id, user_id, artifact_url);


--
-- Name: idx_insights_daily_org_user_date_desc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_insights_daily_org_user_date_desc ON public.insights_daily USING btree (org_id, user_id, date DESC NULLS LAST);


--
-- Name: idx_mail_drafts_chat_thread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mail_drafts_chat_thread ON public.mail_drafts USING btree (chat_thread_id);


--
-- Name: idx_mail_drafts_follow_up_automation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mail_drafts_follow_up_automation ON public.mail_drafts USING btree (follow_up_automation_id);


--
-- Name: idx_model_provider_auth_sessions_expiration; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_model_provider_auth_sessions_expiration ON public.model_provider_auth_sessions USING btree (status, expires_at);


--
-- Name: idx_model_provider_auth_sessions_owner_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_model_provider_auth_sessions_owner_status ON public.model_provider_auth_sessions USING btree (org_id, user_id, connector_type, source, status);


--
-- Name: idx_model_provider_auth_sessions_sandbox; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_model_provider_auth_sessions_sandbox ON public.model_provider_auth_sessions USING btree (sandbox_id) WHERE (sandbox_id IS NOT NULL);


--
-- Name: idx_model_provider_connections_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_model_provider_connections_org ON public.model_provider_connections USING btree (org_id);


--
-- Name: idx_model_provider_connections_secret; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_model_provider_connections_secret ON public.model_provider_connections USING btree (secret_id);


--
-- Name: idx_model_provider_surfaces_connection; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_model_provider_surfaces_connection ON public.model_provider_surfaces USING btree (connection_id);


--
-- Name: idx_model_provider_surfaces_connection_protocol; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_model_provider_surfaces_connection_protocol ON public.model_provider_surfaces USING btree (connection_id, protocol);


--
-- Name: idx_model_providers_one_default_per_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_model_providers_one_default_per_user ON public.model_providers USING btree (org_id, user_id) WHERE (is_default = true);


--
-- Name: idx_model_providers_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_model_providers_org ON public.model_providers USING btree (org_id);


--
-- Name: idx_model_providers_org_user_type; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_model_providers_org_user_type ON public.model_providers USING btree (org_id, user_id, type);


--
-- Name: idx_model_providers_secret; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_model_providers_secret ON public.model_providers USING btree (secret_id);


--
-- Name: idx_model_stat_hour_start; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_model_stat_hour_start ON public.model_stat USING btree (hour_start DESC NULLS LAST);


--
-- Name: idx_model_stat_model_hour; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_model_stat_model_hour ON public.model_stat USING btree (model, hour_start DESC NULLS LAST);


--
-- Name: idx_model_usage_observation_observed_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_model_usage_observation_observed_at ON public.model_usage_observation USING btree (observed_at DESC NULLS LAST);


--
-- Name: idx_morning_brief_deliveries_org_user_date; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_morning_brief_deliveries_org_user_date ON public.morning_brief_deliveries USING btree (org_id, user_id, brief_date);


--
-- Name: idx_morning_brief_deliveries_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_morning_brief_deliveries_run ON public.morning_brief_deliveries USING btree (run_id);


--
-- Name: idx_morning_brief_schedules_next_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_morning_brief_schedules_next_run ON public.morning_brief_schedules USING btree (next_run_at) WHERE (next_run_at IS NOT NULL);


--
-- Name: idx_notion_pending_events_automation_page_family_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_notion_pending_events_automation_page_family_active ON public.notion_workflow_pending_events USING btree (automation_id, page_id, event_family) WHERE status IN ('pending', 'running');


--
-- Name: idx_notion_pending_events_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notion_pending_events_due ON public.notion_workflow_pending_events USING btree (status, run_after);


--
-- Name: idx_notion_pending_events_page_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notion_pending_events_page_pending ON public.notion_workflow_pending_events USING btree (page_id, status);


--
-- Name: idx_notion_pending_events_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notion_pending_events_scope ON public.notion_workflow_pending_events USING btree (scope_type, scope_id);


--
-- Name: idx_notion_webhook_events_event_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_notion_webhook_events_event_id ON public.notion_webhook_events USING btree (notion_event_id);


--
-- Name: idx_notion_webhook_events_page; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notion_webhook_events_page ON public.notion_webhook_events USING btree (page_id);


--
-- Name: idx_notion_webhook_secrets_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notion_webhook_secrets_active ON public.notion_webhook_secrets USING btree (active);


--
-- Name: idx_notion_webhook_secrets_active_single; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_notion_webhook_secrets_active_single ON public.notion_webhook_secrets USING btree (active) WHERE (active = true);


--
-- Name: idx_org_cache_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_cache_slug ON public.org_cache USING btree (slug);


--
-- Name: idx_org_concurrency_entitlements_org_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_concurrency_entitlements_org_active ON public.org_concurrency_entitlements USING btree (org_id, starts_at, expires_at);


--
-- Name: idx_org_concurrency_subscriptions_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_concurrency_subscriptions_org ON public.org_concurrency_subscriptions USING btree (org_id);


--
-- Name: idx_org_concurrency_subscriptions_status_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_concurrency_subscriptions_status_period ON public.org_concurrency_subscriptions USING btree (subscription_status, current_period_end);


--
-- Name: idx_org_custom_connector_secrets_connector; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_custom_connector_secrets_connector ON public.org_custom_connector_secrets USING btree (connector_id);


--
-- Name: idx_org_custom_connector_secrets_connector_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_org_custom_connector_secrets_connector_user ON public.org_custom_connector_secrets USING btree (connector_id, user_id);


--
-- Name: idx_org_custom_connector_secrets_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_custom_connector_secrets_user ON public.org_custom_connector_secrets USING btree (user_id);


--
-- Name: idx_org_custom_connector_values_connector; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_custom_connector_values_connector ON public.org_custom_connector_values USING btree (connector_id);


--
-- Name: idx_org_custom_connector_values_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_org_custom_connector_values_unique ON public.org_custom_connector_values USING btree (connector_id, user_id, kind, key);


--
-- Name: idx_org_custom_connector_values_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_custom_connector_values_user ON public.org_custom_connector_values USING btree (user_id);


--
-- Name: idx_org_custom_connectors_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_custom_connectors_org ON public.org_custom_connectors USING btree (org_id);


--
-- Name: idx_org_custom_connectors_org_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_org_custom_connectors_org_slug ON public.org_custom_connectors USING btree (org_id, slug);


--
-- Name: idx_org_model_policies_one_default_per_org; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_org_model_policies_one_default_per_org ON public.org_model_policies USING btree (org_id) WHERE (is_default = true);


--
-- Name: idx_org_model_policies_org_model; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_org_model_policies_org_model ON public.org_model_policies USING btree (org_id, model);


--
-- Name: idx_org_model_policies_provider; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_model_policies_provider ON public.org_model_policies USING btree (model_provider_id) WHERE (model_provider_id IS NOT NULL);


--
-- Name: idx_org_model_policies_surface; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_model_policies_surface ON public.org_model_policies USING btree (model_provider_surface_id) WHERE (model_provider_surface_id IS NOT NULL);


--
-- Name: idx_org_plan_entitlements_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_plan_entitlements_expires ON public.org_plan_entitlements USING btree (expires_at);


--
-- Name: idx_org_plan_entitlements_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_plan_entitlements_source ON public.org_plan_entitlements USING btree (source);


--
-- Name: idx_org_plan_entitlements_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_plan_entitlements_status ON public.org_plan_entitlements USING btree (status);


--
-- Name: idx_org_usage_allowance_entitlements_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_usage_allowance_entitlements_status ON public.org_usage_allowance_entitlements USING btree (status);


--
-- Name: idx_org_usage_allowance_entitlements_stripe_subscription; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_usage_allowance_entitlements_stripe_subscription ON public.org_usage_allowance_entitlements USING btree (stripe_subscription_id);


--
-- Name: idx_org_usage_allowance_windows_org_kind_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_usage_allowance_windows_org_kind_expires ON public.org_usage_allowance_windows USING btree (org_id, kind, expires_at);


--
-- Name: idx_org_usage_allowance_windows_org_kind_starts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_usage_allowance_windows_org_kind_starts ON public.org_usage_allowance_windows USING btree (org_id, kind, starts_at DESC NULLS LAST);


--
-- Name: idx_push_subscriptions_endpoint; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_push_subscriptions_endpoint ON public.push_subscriptions USING btree (endpoint);


--
-- Name: idx_push_subscriptions_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_push_subscriptions_user_id ON public.push_subscriptions USING btree (user_id);


--
-- Name: idx_run_builtin_admissions_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_run_builtin_admissions_expires_at ON public.run_built_in_admissions USING btree (expires_at);


--
-- Name: idx_run_builtin_admissions_run_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_run_builtin_admissions_run_created ON public.run_built_in_admissions USING btree (run_id, created_at);


--
-- Name: idx_run_builtin_admissions_run_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_run_builtin_admissions_run_status ON public.run_built_in_admissions USING btree (run_id, status);


--
-- Name: idx_run_uploaded_files_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_run_uploaded_files_run ON public.run_uploaded_files USING btree (run_id);


--
-- Name: idx_run_uploaded_files_run_source_external; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_run_uploaded_files_run_source_external ON public.run_uploaded_files USING btree (run_id, source, external_id);


--
-- Name: idx_run_uploaded_files_source_external; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_run_uploaded_files_source_external ON public.run_uploaded_files USING btree (source, external_id);


--
-- Name: idx_run_uploaded_files_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_run_uploaded_files_updated ON public.run_uploaded_files USING btree (updated_at, id) WHERE (url IS NOT NULL);


--
-- Name: idx_sandbox_telemetry_run_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sandbox_telemetry_run_id ON public.sandbox_telemetry USING btree (run_id);


--
-- Name: idx_secrets_connector; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_secrets_connector ON public.secrets USING btree (connector_id) WHERE (connector_id IS NOT NULL);


--
-- Name: idx_secrets_connector_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_secrets_connector_name ON public.secrets USING btree (connector_id, name) WHERE (connector_id IS NOT NULL);


--
-- Name: idx_secrets_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_secrets_org ON public.secrets USING btree (org_id);


--
-- Name: idx_secrets_org_user_name_type; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_secrets_org_user_name_type ON public.secrets USING btree (org_id, user_id, name, type) WHERE (connector_id IS NULL);


--
-- Name: idx_secrets_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_secrets_type ON public.secrets USING btree (type);


--
-- Name: idx_skills_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_skills_name ON public.skills USING btree (name);


--
-- Name: idx_skills_storage_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_skills_storage_id ON public.skills USING btree (storage_id);


--
-- Name: idx_slack_chat_ingress_event_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_slack_chat_ingress_event_id ON public.slack_chat_ingress USING btree (event_id);


--
-- Name: idx_slack_chat_thread_routes_conn_channel_thread_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_slack_chat_thread_routes_conn_channel_thread_user ON public.slack_chat_thread_routes USING btree (connection_id, channel_id, thread_ts, user_id);


--
-- Name: idx_slack_org_connections_user_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_slack_org_connections_user_workspace ON public.slack_org_connections USING btree (slack_user_id, slack_workspace_id);


--
-- Name: idx_slack_org_connections_vm0_user_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_slack_org_connections_vm0_user_workspace ON public.slack_org_connections USING btree (vm0_user_id, slack_workspace_id);


--
-- Name: idx_slack_org_connections_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_slack_org_connections_workspace ON public.slack_org_connections USING btree (slack_workspace_id);


--
-- Name: idx_slack_org_installations_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_slack_org_installations_org ON public.slack_org_installations USING btree (org_id);


--
-- Name: idx_slack_org_installations_org_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_slack_org_installations_org_unique ON public.slack_org_installations USING btree (org_id) WHERE (org_id IS NOT NULL);


--
-- Name: idx_storage_version_lineage_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_storage_version_lineage_run ON public.storage_version_lineage USING btree (run_id);


--
-- Name: idx_storage_version_lineage_storage_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_storage_version_lineage_storage_parent ON public.storage_version_lineage USING btree (storage_id, parent_version_id);


--
-- Name: idx_storage_version_lineage_storage_version; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_storage_version_lineage_storage_version ON public.storage_version_lineage USING btree (storage_id, version_id);


--
-- Name: idx_storages_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_storages_org ON public.storages USING btree (org_id);


--
-- Name: idx_storages_org_user_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_storages_org_user_name ON public.storages USING btree (org_id, user_id, name);


--
-- Name: idx_strapi_integrations_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_strapi_integrations_org ON public.strapi_integrations USING btree (org_id);


--
-- Name: idx_strapi_integrations_org_base_url; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_strapi_integrations_org_base_url ON public.strapi_integrations USING btree (org_id, normalized_base_url);


--
-- Name: idx_strapi_integrations_token_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_strapi_integrations_token_hash ON public.strapi_integrations USING btree (token_hash);


--
-- Name: idx_strapi_pending_events_automation_document_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_strapi_pending_events_automation_document_active ON public.strapi_workflow_pending_events USING btree (automation_id, uid, document_id) WHERE ((status)::text = 'pending'::text);


--
-- Name: idx_strapi_pending_events_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_strapi_pending_events_due ON public.strapi_workflow_pending_events USING btree (status, run_after);


--
-- Name: idx_strapi_pending_events_integration; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_strapi_pending_events_integration ON public.strapi_workflow_pending_events USING btree (integration_id);


--
-- Name: idx_strapi_webhook_deliveries_integration_body; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_strapi_webhook_deliveries_integration_body ON public.strapi_webhook_deliveries USING btree (integration_id, body_sha256);


--
-- Name: idx_strapi_webhook_deliveries_received; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_strapi_webhook_deliveries_received ON public.strapi_webhook_deliveries USING btree (received_at);


--
-- Name: idx_system_storage_presigned_url_cache_active_refresh; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_system_storage_presigned_url_cache_active_refresh ON public.system_storage_presigned_url_cache USING btree (last_requested_at, refresh_after);


--
-- Name: idx_system_storage_presigned_url_cache_last_requested_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_system_storage_presigned_url_cache_last_requested_at ON public.system_storage_presigned_url_cache USING btree (last_requested_at);


--
-- Name: idx_system_storage_presigned_url_cache_refresh_after; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_system_storage_presigned_url_cache_refresh_after ON public.system_storage_presigned_url_cache USING btree (refresh_after);


--
-- Name: idx_system_storage_presigned_url_cache_scope_active_refresh; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_system_storage_presigned_url_cache_scope_active_refresh ON public.system_storage_presigned_url_cache USING btree (scope, last_requested_at, refresh_after);


--
-- Name: idx_system_storage_presigned_url_cache_scope_refresh_after; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_system_storage_presigned_url_cache_scope_refresh_after ON public.system_storage_presigned_url_cache USING btree (scope, refresh_after);


--
-- Name: idx_teams_chat_thread_routes_conn_conversation_thread_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_teams_chat_thread_routes_conn_conversation_thread_user ON public.teams_chat_thread_routes USING btree (connection_id, conversation_id, thread_id, user_id);


--
-- Name: idx_teams_org_connections_aad_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_teams_org_connections_aad_tenant ON public.teams_org_connections USING btree (teams_aad_object_id, teams_tenant_id) WHERE (teams_aad_object_id IS NOT NULL);


--
-- Name: idx_teams_org_connections_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_teams_org_connections_tenant ON public.teams_org_connections USING btree (teams_tenant_id);


--
-- Name: idx_teams_org_connections_user_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_teams_org_connections_user_tenant ON public.teams_org_connections USING btree (teams_user_id, teams_tenant_id) WHERE (teams_user_id IS NOT NULL);


--
-- Name: idx_teams_org_connections_vm0_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_teams_org_connections_vm0_tenant ON public.teams_org_connections USING btree (vm0_user_id, teams_tenant_id);


--
-- Name: idx_teams_org_installations_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_teams_org_installations_org ON public.teams_org_installations USING btree (org_id);


--
-- Name: idx_teams_org_installations_org_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_teams_org_installations_org_unique ON public.teams_org_installations USING btree (org_id) WHERE (org_id IS NOT NULL);


--
-- Name: idx_telegram_chat_thread_routes_chat_official_link; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_telegram_chat_thread_routes_chat_official_link ON public.telegram_chat_thread_routes USING btree (telegram_official_user_link_id, chat_id, root_message_id) WHERE (telegram_official_user_link_id IS NOT NULL);


--
-- Name: idx_telegram_chat_thread_routes_chat_user_link; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_telegram_chat_thread_routes_chat_user_link ON public.telegram_chat_thread_routes USING btree (telegram_user_link_id, chat_id, root_message_id) WHERE (telegram_user_link_id IS NOT NULL);


--
-- Name: idx_telegram_chat_thread_routes_official_user_link; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_telegram_chat_thread_routes_official_user_link ON public.telegram_chat_thread_routes USING btree (telegram_official_user_link_id) WHERE (telegram_official_user_link_id IS NOT NULL);


--
-- Name: idx_telegram_chat_thread_routes_user_link; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_telegram_chat_thread_routes_user_link ON public.telegram_chat_thread_routes USING btree (telegram_user_link_id) WHERE (telegram_user_link_id IS NOT NULL);


--
-- Name: idx_telegram_installations_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_telegram_installations_org ON public.telegram_installations USING btree (org_id);


--
-- Name: idx_telegram_installations_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_telegram_installations_owner ON public.telegram_installations USING btree (owner_user_id);


--
-- Name: idx_telegram_messages_chat; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_telegram_messages_chat ON public.telegram_messages USING btree (installation_id, chat_id) WHERE (installation_id IS NOT NULL);


--
-- Name: idx_telegram_messages_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_telegram_messages_created_at ON public.telegram_messages USING btree (created_at);


--
-- Name: idx_telegram_messages_official_chat; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_telegram_messages_official_chat ON public.telegram_messages USING btree (official_org_id, chat_id) WHERE (official_org_id IS NOT NULL);


--
-- Name: idx_telegram_messages_official_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_telegram_messages_official_unique ON public.telegram_messages USING btree (official_org_id, chat_id, message_id) WHERE (official_org_id IS NOT NULL);


--
-- Name: idx_telegram_messages_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_telegram_messages_unique ON public.telegram_messages USING btree (installation_id, chat_id, message_id) WHERE (installation_id IS NOT NULL);


--
-- Name: idx_telegram_official_user_links_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_telegram_official_user_links_org ON public.telegram_official_user_links USING btree (org_id);


--
-- Name: idx_telegram_official_user_links_tg_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_telegram_official_user_links_tg_user ON public.telegram_official_user_links USING btree (telegram_user_id);


--
-- Name: idx_telegram_official_user_links_vm0_org; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_telegram_official_user_links_vm0_org ON public.telegram_official_user_links USING btree (vm0_user_id, org_id);


--
-- Name: idx_telegram_user_links_user_installation; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_telegram_user_links_user_installation ON public.telegram_user_links USING btree (telegram_user_id, installation_id);


--
-- Name: idx_telegram_user_links_vm0_installation; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_telegram_user_links_vm0_installation ON public.telegram_user_links USING btree (vm0_user_id, installation_id);


--
-- Name: idx_thread_goals_chat_thread_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_thread_goals_chat_thread_unique ON public.thread_goals USING btree (chat_thread_id);


--
-- Name: idx_thread_goals_org_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_thread_goals_org_owner ON public.thread_goals USING btree (org_id, owner_user_id);


--
-- Name: idx_thread_goals_org_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_thread_goals_org_status ON public.thread_goals USING btree (org_id, status);


--
-- Name: idx_usage_allowance_allocations_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_usage_allowance_allocations_org ON public.usage_allowance_allocations USING btree (org_id);


--
-- Name: idx_usage_allowance_allocations_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_usage_allowance_allocations_run ON public.usage_allowance_allocations USING btree (run_id);


--
-- Name: idx_usage_event_compacted_created_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_usage_event_compacted_created_id ON public.usage_event USING btree (created_at, id) WHERE ((status)::text = 'compacted'::text);


--
-- Name: idx_usage_event_hourly_rollup_org_hour; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_usage_event_hourly_rollup_org_hour ON public.usage_event_hourly_rollup USING btree (org_id, processed_hour);


--
-- Name: idx_usage_event_hourly_rollup_physical_grain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_usage_event_hourly_rollup_physical_grain ON public.usage_event_hourly_rollup USING btree (processed_hour DESC NULLS LAST, org_id, user_id, run_id, kind, provider, category, short_window_id, weekly_window_id);


--
-- Name: idx_usage_event_hourly_rollup_run_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_usage_event_hourly_rollup_run_id ON public.usage_event_hourly_rollup USING btree (run_id);


--
-- Name: idx_usage_event_hourly_rollup_short_window_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_usage_event_hourly_rollup_short_window_id ON public.usage_event_hourly_rollup USING btree (short_window_id);


--
-- Name: idx_usage_event_hourly_rollup_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_usage_event_hourly_rollup_user_id ON public.usage_event_hourly_rollup USING btree (user_id);


--
-- Name: idx_usage_event_hourly_rollup_weekly_window_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_usage_event_hourly_rollup_weekly_window_id ON public.usage_event_hourly_rollup USING btree (weekly_window_id);


--
-- Name: idx_usage_event_model_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_usage_event_model_created ON public.usage_event USING btree (created_at DESC NULLS LAST) WHERE ((kind)::text = 'model'::text);


--
-- Name: idx_usage_event_org_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_usage_event_org_created ON public.usage_event USING btree (org_id, created_at DESC NULLS LAST);


--
-- Name: idx_usage_event_org_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_usage_event_org_status ON public.usage_event USING btree (org_id, status);


--
-- Name: idx_usage_event_org_user_status_processed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_usage_event_org_user_status_processed ON public.usage_event USING btree (org_id, user_id, status, processed_at);


--
-- Name: idx_usage_event_processed_org_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_usage_event_processed_org_user ON public.usage_event USING btree (processed_at DESC NULLS LAST, org_id, user_id) WHERE (((status)::text = 'processed'::text) AND (processed_at IS NOT NULL));


--
-- Name: idx_usage_event_run_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_usage_event_run_id ON public.usage_event USING btree (run_id);


--
-- Name: idx_user_connectors_agent_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_connectors_agent_user ON public.user_connectors USING btree (agent_id, user_id);


--
-- Name: idx_user_connectors_unique_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_user_connectors_unique_slug ON public.user_connectors USING btree (org_id, user_id, agent_id, connector_slug);


--
-- Name: idx_user_custom_connectors_agent_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_custom_connectors_agent_user ON public.user_custom_connectors USING btree (agent_id, user_id);


--
-- Name: idx_user_custom_connectors_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_user_custom_connectors_unique ON public.user_custom_connectors USING btree (org_id, user_id, agent_id, custom_connector_id);


--
-- Name: idx_user_permission_grants_agent_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_permission_grants_agent_id ON public.user_permission_grants USING btree (agent_id);


--
-- Name: idx_user_permission_grants_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_permission_grants_lookup ON public.user_permission_grants USING btree (org_id, user_id, agent_id);


--
-- Name: idx_user_permission_grants_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_permission_grants_user_id ON public.user_permission_grants USING btree (user_id);


--
-- Name: idx_variables_connector; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_variables_connector ON public.variables USING btree (connector_id) WHERE (connector_id IS NOT NULL);


--
-- Name: idx_variables_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_variables_org ON public.variables USING btree (org_id);


--
-- Name: idx_variables_org_user_type_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_variables_org_user_type_name ON public.variables USING btree (org_id, user_id, type, name);


--
-- Name: idx_vm0_api_keys_vendor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vm0_api_keys_vendor ON public.vm0_api_keys USING btree (vendor);


--
-- Name: idx_workflow_user_automation_threads_chat_thread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_user_automation_threads_chat_thread ON public.workflow_user_automation_threads USING btree (chat_thread_id);


--
-- Name: idx_workflow_user_automation_threads_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_workflow_user_automation_threads_unique ON public.workflow_user_automation_threads USING btree (org_id, user_id, workflow_id);


--
-- Name: idx_workflow_user_automation_threads_workflow_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_user_automation_threads_workflow_user ON public.workflow_user_automation_threads USING btree (workflow_id, user_id);


--
-- Name: idx_zero_agent_drafts_user_org_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_zero_agent_drafts_user_org_agent ON public.zero_agent_drafts USING btree (user_id, org_id, agent_id);


--
-- Name: idx_zero_agents_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_zero_agents_org ON public.zero_agents USING btree (org_id);


--
-- Name: idx_zero_agents_org_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_zero_agents_org_name ON public.zero_agents USING btree (org_id, name);


--
-- Name: idx_zero_runs_chat_thread_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_zero_runs_chat_thread_id ON public.zero_runs USING btree (chat_thread_id) WHERE (chat_thread_id IS NOT NULL);


--
-- Name: idx_zero_runs_goal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_zero_runs_goal ON public.zero_runs USING btree (goal_id) WHERE (goal_id IS NOT NULL);


--
-- Name: idx_zero_runs_run_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_zero_runs_run_group ON public.zero_runs USING btree (run_group_id) WHERE (run_group_id IS NOT NULL);


--
-- Name: idx_zero_runs_workflow_automation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_zero_runs_workflow_automation ON public.zero_runs USING btree (workflow_automation_id) WHERE (workflow_automation_id IS NOT NULL);


--
-- Name: idx_zero_workflow_automations_next_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_zero_workflow_automations_next_run ON public.zero_workflow_automations USING btree (next_run_at) WHERE (enabled = true);


--
-- Name: idx_zero_workflow_automations_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_zero_workflow_automations_org ON public.zero_workflow_automations USING btree (org_id);


--
-- Name: idx_zero_workflow_automations_workflow; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_zero_workflow_automations_workflow ON public.zero_workflow_automations USING btree (workflow_id);


--
-- Name: idx_zero_workflow_github_processed_automation_delivery; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_zero_workflow_github_processed_automation_delivery ON public.zero_workflow_github_processed_events USING btree (automation_id, github_delivery_id);


--
-- Name: idx_zero_workflow_github_processed_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_zero_workflow_github_processed_subject ON public.zero_workflow_github_processed_events USING btree (repo, subject_type, subject_number);


--
-- Name: idx_zero_workflow_strapi_automations_integration; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_zero_workflow_strapi_automations_integration ON public.zero_workflow_strapi_automations USING btree (integration_id);


--
-- Name: idx_zero_workflow_webhook_automations_token_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_zero_workflow_webhook_automations_token_hash ON public.zero_workflow_webhook_automations USING btree (token_hash);


--
-- Name: idx_zero_workflow_webhook_deliveries_automation_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_zero_workflow_webhook_deliveries_automation_key ON public.zero_workflow_webhook_deliveries USING btree (automation_id, delivery_key);


--
-- Name: idx_zero_workflow_webhook_deliveries_automation_received; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_zero_workflow_webhook_deliveries_automation_received ON public.zero_workflow_webhook_deliveries USING btree (automation_id, received_at);


--
-- Name: idx_zero_workflows_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_zero_workflows_agent ON public.zero_workflows USING btree (agent_id, name);


--
-- Name: idx_zero_workflows_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_zero_workflows_org ON public.zero_workflows USING btree (org_id);


--
-- Name: idx_zero_workflows_org_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_zero_workflows_org_owner ON public.zero_workflows USING btree (org_id, owner_user_id);


--
-- Name: idx_zero_workflows_private_owner_agent_name_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_zero_workflows_private_owner_agent_name_unique ON public.zero_workflows USING btree (org_id, agent_id, owner_user_id, name) WHERE ((visibility)::text = 'private'::text);


--
-- Name: idx_zero_workflows_public_agent_name_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_zero_workflows_public_agent_name_unique ON public.zero_workflows USING btree (org_id, agent_id, name) WHERE ((visibility)::text = 'public'::text);


--
-- Name: image_artifacts_file_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX image_artifacts_file_unique ON public.image_artifacts USING btree (file_id);


--
-- Name: mail_drafts_connector_gmail_draft_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX mail_drafts_connector_gmail_draft_unique ON public.mail_drafts USING btree (connector_id, gmail_draft_id);


--
-- Name: presentation_artifacts_site_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX presentation_artifacts_site_unique ON public.presentation_artifacts USING btree (hosted_site_id);


--
-- Name: run_uploaded_files_canonical_idempotency_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX run_uploaded_files_canonical_idempotency_unique ON public.run_uploaded_files USING btree (user_id, idempotency_scope, idempotency_key) WHERE (asset_version = 1);


--
-- Name: run_uploaded_files_chat_thread_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX run_uploaded_files_chat_thread_idx ON public.run_uploaded_files USING btree (chat_thread_id) WHERE (chat_thread_id IS NOT NULL);


--
-- Name: runner_job_queue_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runner_job_queue_expires_at_idx ON public.runner_job_queue USING btree (expires_at);


--
-- Name: runner_job_queue_group_profile_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runner_job_queue_group_profile_idx ON public.runner_job_queue USING btree (runner_group, profile);


--
-- Name: runner_state_group_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runner_state_group_idx ON public.runner_state USING btree (runner_group);


--
-- Name: runner_state_last_seen_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runner_state_last_seen_idx ON public.runner_state USING btree (last_seen_at);


--
-- Name: uq_browser_authorization_requests_token_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_browser_authorization_requests_token_hash ON public.browser_authorization_requests USING btree (request_token_hash);


--
-- Name: uq_browser_profiles_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_browser_profiles_owner ON public.browser_profiles USING btree (org_id, user_id);


--
-- Name: uq_browser_profiles_provider_profile; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_browser_profiles_provider_profile ON public.browser_profiles USING btree (provider_profile_id);


--
-- Name: uq_browser_session_instances_thread_owned; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_browser_session_instances_thread_owned ON public.browser_session_instances USING btree (chat_thread_id) WHERE status IN ('active', 'stopping');


--
-- Name: uq_browser_sessions_thread_owned; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_browser_sessions_thread_owned ON public.browser_sessions USING btree (chat_thread_id) WHERE status IN ('creating', 'active', 'resuming', 'stopping');


--
-- Name: uq_browser_thread_profiles_provider_profile; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_browser_thread_profiles_provider_profile ON public.browser_thread_profiles USING btree (provider_profile_id);


--
-- Name: uq_browser_thread_profiles_thread; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_browser_thread_profiles_thread ON public.browser_thread_profiles USING btree (chat_thread_id);


--
-- Name: uq_credit_expires_invoice; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_credit_expires_invoice ON public.credit_expires_record USING btree (org_id, stripe_invoice_id) WHERE (stripe_invoice_id IS NOT NULL);


--
-- Name: uq_credit_expires_starter_grant; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_credit_expires_starter_grant ON public.credit_expires_record USING btree (org_id) WHERE ((source)::text = 'starter_grant'::text);


--
-- Name: uq_insights_daily_org_user_date; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_insights_daily_org_user_date ON public.insights_daily USING btree (org_id, user_id, date);


--
-- Name: uq_model_stat_hour_model; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_model_stat_hour_model ON public.model_stat USING btree (hour_start, model);


--
-- Name: uq_org_concurrency_entitlements_invoice_line; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_org_concurrency_entitlements_invoice_line ON public.org_concurrency_entitlements USING btree (stripe_invoice_line_id);


--
-- Name: uq_org_plan_entitlements_stripe_subscription; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_org_plan_entitlements_stripe_subscription ON public.org_plan_entitlements USING btree (stripe_subscription_id);


--
-- Name: uq_org_promo_redemption; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_org_promo_redemption ON public.org_promo_redemption USING btree (org_id, campaign_key);


--
-- Name: uq_org_stripe_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_org_stripe_customer ON public.org_metadata USING btree (stripe_customer_id);


--
-- Name: uq_org_usage_allowance_entitlements_org; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_org_usage_allowance_entitlements_org ON public.org_usage_allowance_entitlements USING btree (org_id);


--
-- Name: uq_usage_allowance_allocations_usage_event; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_usage_allowance_allocations_usage_event ON public.usage_allowance_allocations USING btree (usage_event_id);


--
-- Name: uq_usage_daily_user_org_date; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_usage_daily_user_org_date ON public.usage_daily USING btree (user_id, org_id, date);


--
-- Name: uq_usage_event_idempotency_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_usage_event_idempotency_key ON public.usage_event USING btree (idempotency_key);


--
-- Name: uq_usage_pricing_kind_provider_category; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_usage_pricing_kind_provider_category ON public.usage_pricing USING btree (kind, provider, category);


--
-- Name: uq_user_permission_grants_slug_permission; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_user_permission_grants_slug_permission ON public.user_permission_grants USING btree (org_id, user_id, agent_id, connector_slug, permission);


--
-- Name: video_artifacts_file_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX video_artifacts_file_unique ON public.video_artifacts USING btree (file_id);


--
-- Name: chat_thread_events allocate_legacy_chat_thread_event_seq_id; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER allocate_legacy_chat_thread_event_seq_id BEFORE INSERT ON public.chat_thread_events FOR EACH ROW EXECUTE FUNCTION public.allocate_legacy_chat_thread_event_seq_id();


--
-- Name: chat_events bridge_chat_event_run_event_sequence_number_0807; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER bridge_chat_event_run_event_sequence_number_0807 BEFORE INSERT ON public.chat_events FOR EACH ROW EXECUTE FUNCTION public.bridge_chat_event_run_event_sequence_number_0807();


--
-- Name: hosted_sites canonicalize_hosted_site_scope_0753; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER canonicalize_hosted_site_scope_0753 BEFORE INSERT OR UPDATE OF created_from_run_id, requested_slug, chat_thread_id ON public.hosted_sites FOR EACH ROW EXECUTE FUNCTION public.canonicalize_hosted_site_scope_0753();


--
-- Name: chat_events chat_events_reject_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER chat_events_reject_update BEFORE UPDATE ON public.chat_events FOR EACH ROW EXECUTE FUNCTION public.reject_chat_event_source_update();


--
-- Name: chat_thread_events chat_thread_events_reject_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER chat_thread_events_reject_update BEFORE UPDATE ON public.chat_thread_events FOR EACH ROW EXECUTE FUNCTION public.reject_chat_event_source_update();


--
-- Name: chat_threads chat_threads_normalize_computer_access; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER chat_threads_normalize_computer_access BEFORE INSERT OR UPDATE OF computer_use_host_id, cloud_browser_enabled ON public.chat_threads FOR EACH ROW EXECUTE FUNCTION public.chat_threads_normalize_computer_access();


--
-- Name: hosted_deployments enforce_hosted_deployment_scope_0753; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER enforce_hosted_deployment_scope_0753 BEFORE INSERT ON public.hosted_deployments FOR EACH ROW EXECUTE FUNCTION public.enforce_hosted_deployment_scope_0753();


--
-- Name: org_metadata ensure_legacy_org_metadata_plan_entitlement; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ensure_legacy_org_metadata_plan_entitlement AFTER INSERT ON public.org_metadata FOR EACH ROW EXECUTE FUNCTION public.ensure_legacy_org_metadata_plan_entitlement();


--
-- Name: chat_thread_snapshots fill_legacy_chat_thread_snapshot_event_seq_id; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER fill_legacy_chat_thread_snapshot_event_seq_id BEFORE INSERT OR UPDATE ON public.chat_thread_snapshots FOR EACH ROW EXECUTE FUNCTION public.fill_legacy_chat_thread_snapshot_event_seq_id();


--
-- Name: hosted_sites hosted_sites_delete_artifact_registry; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER hosted_sites_delete_artifact_registry AFTER DELETE ON public.hosted_sites FOR EACH ROW EXECUTE FUNCTION public.delete_artifact_registry_entity('hosted-site');


--
-- Name: image_artifacts image_artifacts_delete_artifact_registry; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER image_artifacts_delete_artifact_registry AFTER DELETE ON public.image_artifacts FOR EACH ROW EXECUTE FUNCTION public.delete_artifact_registry_entity('image');


--
-- Name: presentation_artifacts presentation_artifacts_delete_artifact_registry; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER presentation_artifacts_delete_artifact_registry AFTER DELETE ON public.presentation_artifacts FOR EACH ROW EXECUTE FUNCTION public.delete_artifact_registry_entity('presentation');


--
-- Name: run_uploaded_files run_uploaded_files_delete_artifact_registry; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER run_uploaded_files_delete_artifact_registry AFTER DELETE ON public.run_uploaded_files FOR EACH ROW EXECUTE FUNCTION public.delete_artifact_registry_entity('file');


--
-- Name: run_uploaded_files run_uploaded_files_queue_artifact_catalog; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER run_uploaded_files_queue_artifact_catalog AFTER INSERT OR UPDATE OF run_id, chat_thread_id, user_id, org_id, external_id, filename, content_type, url, preview_image_url, metadata ON public.run_uploaded_files FOR EACH ROW EXECUTE FUNCTION public.queue_artifact_catalog_file();


--
-- Name: org_plan_entitlements sync_legacy_org_plan_entitlement_can_buy_credits; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sync_legacy_org_plan_entitlement_can_buy_credits BEFORE INSERT OR UPDATE OF plan_key ON public.org_plan_entitlements FOR EACH ROW EXECUTE FUNCTION public.sync_legacy_org_plan_entitlement_can_buy_credits();


--
-- Name: org_custom_connector_oauth_configs trg_org_custom_connector_oauth_configs_mode; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER trg_org_custom_connector_oauth_configs_mode AFTER INSERT OR DELETE OR UPDATE ON public.org_custom_connector_oauth_configs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.enforce_org_custom_connector_oauth_mode();


--
-- Name: org_custom_connectors trg_org_custom_connectors_oauth_mode; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER trg_org_custom_connectors_oauth_mode AFTER INSERT OR UPDATE ON public.org_custom_connectors DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.enforce_org_custom_connector_oauth_mode();


--
-- Name: video_artifacts video_artifacts_delete_artifact_registry; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER video_artifacts_delete_artifact_registry AFTER DELETE ON public.video_artifacts FOR EACH ROW EXECUTE FUNCTION public.delete_artifact_registry_entity('video');


--
-- Name: agent_compose_versions agent_compose_versions_compose_id_agent_composes_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_compose_versions
    ADD CONSTRAINT agent_compose_versions_compose_id_agent_composes_id_fk FOREIGN KEY (compose_id) REFERENCES public.agent_composes(id) ON DELETE CASCADE;


--
-- Name: agent_run_callbacks agent_run_callbacks_run_id_agent_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_run_callbacks
    ADD CONSTRAINT agent_run_callbacks_run_id_agent_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.agent_runs(id) ON DELETE CASCADE;


--
-- Name: agent_run_custom_connector_auth_refs agent_run_custom_connector_auth_refs_run_id_agent_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_run_custom_connector_auth_refs
    ADD CONSTRAINT agent_run_custom_connector_auth_refs_run_id_agent_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.agent_runs(id) ON DELETE CASCADE;


--
-- Name: agent_run_queue agent_run_queue_run_id_agent_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_run_queue
    ADD CONSTRAINT agent_run_queue_run_id_agent_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.agent_runs(id) ON DELETE CASCADE;


--
-- Name: agent_runs agent_runs_agent_compose_version_id_agent_compose_versions_id_f; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_runs
    ADD CONSTRAINT agent_runs_agent_compose_version_id_agent_compose_versions_id_f FOREIGN KEY (agent_compose_version_id) REFERENCES public.agent_compose_versions(id) ON DELETE SET NULL;


--
-- Name: agent_runs agent_runs_session_id_agent_sessions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_runs
    ADD CONSTRAINT agent_runs_session_id_agent_sessions_id_fk FOREIGN KEY (session_id) REFERENCES public.agent_sessions(id) ON DELETE CASCADE;


--
-- Name: agent_sessions agent_sessions_agent_compose_id_agent_composes_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_sessions
    ADD CONSTRAINT agent_sessions_agent_compose_id_agent_composes_id_fk FOREIGN KEY (agent_compose_id) REFERENCES public.agent_composes(id) ON DELETE CASCADE;


--
-- Name: agent_sessions agent_sessions_conversation_id_conversations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_sessions
    ADD CONSTRAINT agent_sessions_conversation_id_conversations_id_fk FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE SET NULL;


--
-- Name: agentphone_chat_thread_routes agentphone_chat_thread_routes_agentphone_user_link_id_agentphon; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agentphone_chat_thread_routes
    ADD CONSTRAINT agentphone_chat_thread_routes_agentphone_user_link_id_agentphon FOREIGN KEY (agentphone_user_link_id) REFERENCES public.agentphone_user_links(id) ON DELETE CASCADE;


--
-- Name: agentphone_chat_thread_routes agentphone_chat_thread_routes_chat_thread_id_chat_threads_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agentphone_chat_thread_routes
    ADD CONSTRAINT agentphone_chat_thread_routes_chat_thread_id_chat_threads_id_fk FOREIGN KEY (chat_thread_id) REFERENCES public.chat_threads(id) ON DELETE CASCADE;


--
-- Name: agentphone_messages agentphone_messages_agentphone_user_link_id_agentphone_user_lin; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agentphone_messages
    ADD CONSTRAINT agentphone_messages_agentphone_user_link_id_agentphone_user_lin FOREIGN KEY (agentphone_user_link_id) REFERENCES public.agentphone_user_links(id) ON DELETE SET NULL;


--
-- Name: agentphone_user_agent_preferences agentphone_user_agent_preferences_selected_compose_id_agent_com; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agentphone_user_agent_preferences
    ADD CONSTRAINT agentphone_user_agent_preferences_selected_compose_id_agent_com FOREIGN KEY (selected_compose_id) REFERENCES public.agent_composes(id) ON DELETE SET NULL;


--
-- Name: artifact_catalog_pending_files artifact_catalog_pending_files_file_id_run_uploaded_files_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_catalog_pending_files
    ADD CONSTRAINT artifact_catalog_pending_files_file_id_run_uploaded_files_id_fk FOREIGN KEY (file_id) REFERENCES public.run_uploaded_files(id) ON DELETE CASCADE;


--
-- Name: banking_accounts banking_accounts_connection_id_banking_connections_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.banking_accounts
    ADD CONSTRAINT banking_accounts_connection_id_banking_connections_id_fk FOREIGN KEY (connection_id) REFERENCES public.banking_connections(id) ON DELETE CASCADE;


--
-- Name: banking_agent_enablements banking_agent_enablements_agent_id_zero_agents_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.banking_agent_enablements
    ADD CONSTRAINT banking_agent_enablements_agent_id_zero_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.zero_agents(id) ON DELETE CASCADE;


--
-- Name: banking_agent_enablements banking_agent_enablements_connection_id_banking_connections_id_; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.banking_agent_enablements
    ADD CONSTRAINT banking_agent_enablements_connection_id_banking_connections_id_ FOREIGN KEY (connection_id) REFERENCES public.banking_connections(id) ON DELETE CASCADE;


--
-- Name: browser_session_instances browser_session_instances_browser_session_id_browser_sessions_i; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_session_instances
    ADD CONSTRAINT browser_session_instances_browser_session_id_browser_sessions_i FOREIGN KEY (browser_session_id) REFERENCES public.browser_sessions(id) ON DELETE CASCADE;


--
-- Name: browser_session_resize_states browser_session_resize_states_provider_session_id_browser_sessi; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_session_resize_states
    ADD CONSTRAINT browser_session_resize_states_provider_session_id_browser_sessi FOREIGN KEY (provider_session_id) REFERENCES public.browser_session_instances(provider_session_id) ON DELETE CASCADE;


--
-- Name: browser_session_tab_snapshots browser_session_tab_snapshots_chat_thread_id_chat_threads_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_session_tab_snapshots
    ADD CONSTRAINT browser_session_tab_snapshots_chat_thread_id_chat_threads_id_fk FOREIGN KEY (chat_thread_id) REFERENCES public.chat_threads(id) ON DELETE CASCADE;


--
-- Name: browser_sessions browser_sessions_browser_profile_id_browser_profiles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_sessions
    ADD CONSTRAINT browser_sessions_browser_profile_id_browser_profiles_id_fk FOREIGN KEY (browser_profile_id) REFERENCES public.browser_profiles(id);


--
-- Name: browser_sessions browser_sessions_browser_thread_profile_id_browser_thread_profi; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_sessions
    ADD CONSTRAINT browser_sessions_browser_thread_profile_id_browser_thread_profi FOREIGN KEY (browser_thread_profile_id) REFERENCES public.browser_thread_profiles(id);


--
-- Name: browser_sessions browser_sessions_run_id_agent_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_sessions
    ADD CONSTRAINT browser_sessions_run_id_agent_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.agent_runs(id) ON DELETE SET NULL;


--
-- Name: built_in_generation_jobs built_in_generation_jobs_run_id_agent_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.built_in_generation_jobs
    ADD CONSTRAINT built_in_generation_jobs_run_id_agent_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.agent_runs(id) ON DELETE SET NULL;


--
-- Name: canonical_asset_deliveries canonical_asset_deliveries_asset_id_run_uploaded_files_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_asset_deliveries
    ADD CONSTRAINT canonical_asset_deliveries_asset_id_run_uploaded_files_id_fk FOREIGN KEY (asset_id) REFERENCES public.run_uploaded_files(id) ON DELETE CASCADE;


--
-- Name: chat_agentphone_context chat_agentphone_context_chat_thread_id_chat_threads_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_agentphone_context
    ADD CONSTRAINT chat_agentphone_context_chat_thread_id_chat_threads_id_fk FOREIGN KEY (chat_thread_id) REFERENCES public.chat_threads(id) ON DELETE CASCADE;


--
-- Name: chat_automation_context chat_automation_context_chat_thread_id_chat_threads_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_automation_context
    ADD CONSTRAINT chat_automation_context_chat_thread_id_chat_threads_id_fk FOREIGN KEY (chat_thread_id) REFERENCES public.chat_threads(id) ON DELETE CASCADE;


--
-- Name: chat_event_asset_refs chat_event_asset_refs_asset_id_run_uploaded_files_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_event_asset_refs
    ADD CONSTRAINT chat_event_asset_refs_asset_id_run_uploaded_files_id_fk FOREIGN KEY (asset_id) REFERENCES public.run_uploaded_files(id) ON DELETE CASCADE;


--
-- Name: chat_event_asset_refs chat_event_asset_refs_chat_event_id_chat_events_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_event_asset_refs
    ADD CONSTRAINT chat_event_asset_refs_chat_event_id_chat_events_id_fk FOREIGN KEY (chat_event_id) REFERENCES public.chat_events(id) ON DELETE CASCADE;


--
-- Name: chat_events chat_events_chat_thread_id_chat_threads_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_events
    ADD CONSTRAINT chat_events_chat_thread_id_chat_threads_id_fk FOREIGN KEY (chat_thread_id) REFERENCES public.chat_threads(id) ON DELETE CASCADE;


--
-- Name: chat_events chat_events_revokes_event_id_chat_events_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_events
    ADD CONSTRAINT chat_events_revokes_event_id_chat_events_id_fk FOREIGN KEY (revokes_event_id) REFERENCES public.chat_events(id);


--
-- Name: chat_feishu_context chat_feishu_context_chat_thread_id_chat_threads_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_feishu_context
    ADD CONSTRAINT chat_feishu_context_chat_thread_id_chat_threads_id_fk FOREIGN KEY (chat_thread_id) REFERENCES public.chat_threads(id) ON DELETE CASCADE;


--
-- Name: chat_github_context chat_github_context_chat_thread_id_chat_threads_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_github_context
    ADD CONSTRAINT chat_github_context_chat_thread_id_chat_threads_id_fk FOREIGN KEY (chat_thread_id) REFERENCES public.chat_threads(id) ON DELETE CASCADE;


--
-- Name: chat_goal_context chat_goal_context_chat_thread_id_chat_threads_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_goal_context
    ADD CONSTRAINT chat_goal_context_chat_thread_id_chat_threads_id_fk FOREIGN KEY (chat_thread_id) REFERENCES public.chat_threads(id) ON DELETE CASCADE;


--
-- Name: chat_morning_brief_context chat_morning_brief_context_chat_thread_id_chat_threads_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_morning_brief_context
    ADD CONSTRAINT chat_morning_brief_context_chat_thread_id_chat_threads_id_fk FOREIGN KEY (chat_thread_id) REFERENCES public.chat_threads(id) ON DELETE CASCADE;


--
-- Name: chat_output_materializations chat_output_materializations_run_id_agent_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_output_materializations
    ADD CONSTRAINT chat_output_materializations_run_id_agent_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.agent_runs(id) ON DELETE CASCADE;


--
-- Name: chat_slack_context chat_slack_context_chat_thread_id_chat_threads_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_slack_context
    ADD CONSTRAINT chat_slack_context_chat_thread_id_chat_threads_id_fk FOREIGN KEY (chat_thread_id) REFERENCES public.chat_threads(id) ON DELETE CASCADE;


--
-- Name: chat_teams_context chat_teams_context_chat_thread_id_chat_threads_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_teams_context
    ADD CONSTRAINT chat_teams_context_chat_thread_id_chat_threads_id_fk FOREIGN KEY (chat_thread_id) REFERENCES public.chat_threads(id) ON DELETE CASCADE;


--
-- Name: chat_telegram_context chat_telegram_context_chat_thread_id_chat_threads_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_telegram_context
    ADD CONSTRAINT chat_telegram_context_chat_thread_id_chat_threads_id_fk FOREIGN KEY (chat_thread_id) REFERENCES public.chat_threads(id) ON DELETE CASCADE;


--
-- Name: chat_threads chat_threads_agent_compose_id_agent_composes_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_threads
    ADD CONSTRAINT chat_threads_agent_compose_id_agent_composes_id_fk FOREIGN KEY (agent_compose_id) REFERENCES public.agent_composes(id) ON DELETE CASCADE;


--
-- Name: chat_threads chat_threads_agent_session_id_agent_sessions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_threads
    ADD CONSTRAINT chat_threads_agent_session_id_agent_sessions_id_fk FOREIGN KEY (agent_session_id) REFERENCES public.agent_sessions(id) ON DELETE SET NULL;


--
-- Name: chat_threads chat_threads_agent_session_run_id_agent_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_threads
    ADD CONSTRAINT chat_threads_agent_session_run_id_agent_runs_id_fk FOREIGN KEY (agent_session_run_id) REFERENCES public.agent_runs(id) ON DELETE SET NULL;


--
-- Name: chat_threads chat_threads_computer_use_host_id_computer_use_hosts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_threads
    ADD CONSTRAINT chat_threads_computer_use_host_id_computer_use_hosts_id_fk FOREIGN KEY (computer_use_host_id) REFERENCES public.computer_use_hosts(id) ON DELETE SET NULL;


--
-- Name: checkpoints checkpoints_conversation_id_conversations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.checkpoints
    ADD CONSTRAINT checkpoints_conversation_id_conversations_id_fk FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: checkpoints checkpoints_run_id_agent_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.checkpoints
    ADD CONSTRAINT checkpoints_run_id_agent_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.agent_runs(id) ON DELETE CASCADE;


--
-- Name: computer_use_command_audit_events computer_use_command_audit_events_command_id_computer_use_comma; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.computer_use_command_audit_events
    ADD CONSTRAINT computer_use_command_audit_events_command_id_computer_use_comma FOREIGN KEY (command_id) REFERENCES public.computer_use_commands(id);


--
-- Name: computer_use_command_audit_events computer_use_command_audit_events_host_id_computer_use_hosts_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.computer_use_command_audit_events
    ADD CONSTRAINT computer_use_command_audit_events_host_id_computer_use_hosts_id FOREIGN KEY (host_id) REFERENCES public.computer_use_hosts(id);


--
-- Name: computer_use_commands computer_use_commands_host_id_computer_use_hosts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.computer_use_commands
    ADD CONSTRAINT computer_use_commands_host_id_computer_use_hosts_id_fk FOREIGN KEY (host_id) REFERENCES public.computer_use_hosts(id);


--
-- Name: connector_catalog_active_snapshot connector_catalog_active_snapshot_sync_state_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connector_catalog_active_snapshot
    ADD CONSTRAINT connector_catalog_active_snapshot_sync_state_fk FOREIGN KEY (source_id, schema_version) REFERENCES public.connector_catalog_sync_state(source_id, schema_version);


--
-- Name: connector_catalog_compatibility_evaluation connector_catalog_compatibility_evaluation_sync_state_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connector_catalog_compatibility_evaluation
    ADD CONSTRAINT connector_catalog_compatibility_evaluation_sync_state_fk FOREIGN KEY (source_id, schema_version) REFERENCES public.connector_catalog_sync_state(source_id, schema_version);


--
-- Name: conversations conversations_run_id_agent_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_run_id_agent_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.agent_runs(id) ON DELETE CASCADE;


--
-- Name: feishu_chat_ingress feishu_chat_ingress_installation_id_feishu_org_installations_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feishu_chat_ingress
    ADD CONSTRAINT feishu_chat_ingress_installation_id_feishu_org_installations_id FOREIGN KEY (installation_id) REFERENCES public.feishu_org_installations(id) ON DELETE CASCADE;


--
-- Name: feishu_chat_thread_routes feishu_chat_thread_routes_chat_thread_id_chat_threads_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feishu_chat_thread_routes
    ADD CONSTRAINT feishu_chat_thread_routes_chat_thread_id_chat_threads_id_fk FOREIGN KEY (chat_thread_id) REFERENCES public.chat_threads(id) ON DELETE CASCADE;


--
-- Name: feishu_chat_thread_routes feishu_chat_thread_routes_connection_id_feishu_org_connections_; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feishu_chat_thread_routes
    ADD CONSTRAINT feishu_chat_thread_routes_connection_id_feishu_org_connections_ FOREIGN KEY (connection_id) REFERENCES public.feishu_org_connections(id) ON DELETE CASCADE;


--
-- Name: feishu_org_connections feishu_org_connections_installation_id_feishu_org_installations; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feishu_org_connections
    ADD CONSTRAINT feishu_org_connections_installation_id_feishu_org_installations FOREIGN KEY (installation_id) REFERENCES public.feishu_org_installations(id) ON DELETE CASCADE;


--
-- Name: feishu_org_events feishu_org_events_installation_id_feishu_org_installations_id_f; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feishu_org_events
    ADD CONSTRAINT feishu_org_events_installation_id_feishu_org_installations_id_f FOREIGN KEY (installation_id) REFERENCES public.feishu_org_installations(id) ON DELETE CASCADE;


--
-- Name: feishu_org_installations feishu_org_installations_default_compose_id_agent_composes_id_f; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feishu_org_installations
    ADD CONSTRAINT feishu_org_installations_default_compose_id_agent_composes_id_f FOREIGN KEY (default_compose_id) REFERENCES public.agent_composes(id) ON DELETE CASCADE;


--
-- Name: feishu_user_agent_preferences feishu_user_agent_preferences_selected_compose_id_agent_compose; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feishu_user_agent_preferences
    ADD CONSTRAINT feishu_user_agent_preferences_selected_compose_id_agent_compose FOREIGN KEY (selected_compose_id) REFERENCES public.agent_composes(id) ON DELETE SET NULL;


--
-- Name: connector_oauth_states fk_connector_oauth_states_custom_connector; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connector_oauth_states
    ADD CONSTRAINT fk_connector_oauth_states_custom_connector FOREIGN KEY (custom_connector_id, org_id) REFERENCES public.org_custom_connectors(id, org_id) ON DELETE CASCADE;


--
-- Name: connectors fk_connectors_custom_connector; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connectors
    ADD CONSTRAINT fk_connectors_custom_connector FOREIGN KEY (custom_connector_id, org_id) REFERENCES public.org_custom_connectors(id, org_id) ON DELETE CASCADE;


--
-- Name: org_custom_connector_oauth_configs fk_org_custom_connector_oauth_configs_connector; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_custom_connector_oauth_configs
    ADD CONSTRAINT fk_org_custom_connector_oauth_configs_connector FOREIGN KEY (connector_id, org_id) REFERENCES public.org_custom_connectors(id, org_id) ON DELETE CASCADE;


--
-- Name: org_custom_connector_secrets fk_org_custom_connector_secrets_connector; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_custom_connector_secrets
    ADD CONSTRAINT fk_org_custom_connector_secrets_connector FOREIGN KEY (connector_id, org_id) REFERENCES public.org_custom_connectors(id, org_id) ON DELETE CASCADE;


--
-- Name: org_custom_connector_values fk_org_custom_connector_values_connector; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_custom_connector_values
    ADD CONSTRAINT fk_org_custom_connector_values_connector FOREIGN KEY (connector_id, org_id) REFERENCES public.org_custom_connectors(id, org_id) ON DELETE CASCADE;


--
-- Name: secrets fk_secrets_connector_owner; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.secrets
    ADD CONSTRAINT fk_secrets_connector_owner FOREIGN KEY (connector_id, org_id, user_id) REFERENCES public.connectors(id, org_id, user_id) ON DELETE CASCADE;


--
-- Name: usage_event_hourly_rollup fk_usage_event_hourly_rollup_short_window; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_event_hourly_rollup
    ADD CONSTRAINT fk_usage_event_hourly_rollup_short_window FOREIGN KEY (short_window_id) REFERENCES public.org_usage_allowance_windows(id);


--
-- Name: usage_event_hourly_rollup fk_usage_event_hourly_rollup_weekly_window; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_event_hourly_rollup
    ADD CONSTRAINT fk_usage_event_hourly_rollup_weekly_window FOREIGN KEY (weekly_window_id) REFERENCES public.org_usage_allowance_windows(id);


--
-- Name: user_custom_connectors fk_user_custom_connectors_custom_connector; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_custom_connectors
    ADD CONSTRAINT fk_user_custom_connectors_custom_connector FOREIGN KEY (custom_connector_id, org_id) REFERENCES public.org_custom_connectors(id, org_id) ON DELETE CASCADE;


--
-- Name: github_chat_thread_routes github_chat_thread_routes_chat_thread_id_chat_threads_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.github_chat_thread_routes
    ADD CONSTRAINT github_chat_thread_routes_chat_thread_id_chat_threads_id_fk FOREIGN KEY (chat_thread_id) REFERENCES public.chat_threads(id) ON DELETE CASCADE;


--
-- Name: github_chat_thread_routes github_chat_thread_routes_installation_id_github_installations_; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.github_chat_thread_routes
    ADD CONSTRAINT github_chat_thread_routes_installation_id_github_installations_ FOREIGN KEY (installation_id) REFERENCES public.github_installations(id) ON DELETE CASCADE;


--
-- Name: github_installations github_installations_default_compose_id_agent_composes_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.github_installations
    ADD CONSTRAINT github_installations_default_compose_id_agent_composes_id_fk FOREIGN KEY (default_compose_id) REFERENCES public.agent_composes(id) ON DELETE CASCADE;


--
-- Name: github_user_links github_user_links_installation_id_github_installations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.github_user_links
    ADD CONSTRAINT github_user_links_installation_id_github_installations_id_fk FOREIGN KEY (installation_id) REFERENCES public.github_installations(id) ON DELETE CASCADE;


--
-- Name: gmail_processed_events gmail_processed_events_automation_id_zero_workflow_automations_; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gmail_processed_events
    ADD CONSTRAINT gmail_processed_events_automation_id_zero_workflow_automations_ FOREIGN KEY (automation_id) REFERENCES public.zero_workflow_automations(id) ON DELETE CASCADE;


--
-- Name: gmail_processed_events gmail_processed_events_watch_state_id_gmail_watch_states_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gmail_processed_events
    ADD CONSTRAINT gmail_processed_events_watch_state_id_gmail_watch_states_id_fk FOREIGN KEY (watch_state_id) REFERENCES public.gmail_watch_states(id) ON DELETE CASCADE;


--
-- Name: gmail_watch_states gmail_watch_states_connector_id_connectors_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gmail_watch_states
    ADD CONSTRAINT gmail_watch_states_connector_id_connectors_id_fk FOREIGN KEY (connector_id) REFERENCES public.connectors(id) ON DELETE CASCADE;


--
-- Name: google_calendar_event_snapshots google_calendar_event_snapshots_watch_state_id_google_calendar_; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_calendar_event_snapshots
    ADD CONSTRAINT google_calendar_event_snapshots_watch_state_id_google_calendar_ FOREIGN KEY (watch_state_id) REFERENCES public.google_calendar_watch_states(id) ON DELETE CASCADE;


--
-- Name: google_calendar_processed_events google_calendar_processed_events_automation_id_zero_workflow_au; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_calendar_processed_events
    ADD CONSTRAINT google_calendar_processed_events_automation_id_zero_workflow_au FOREIGN KEY (automation_id) REFERENCES public.zero_workflow_automations(id) ON DELETE CASCADE;


--
-- Name: google_calendar_processed_events google_calendar_processed_events_watch_state_id_google_calendar; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_calendar_processed_events
    ADD CONSTRAINT google_calendar_processed_events_watch_state_id_google_calendar FOREIGN KEY (watch_state_id) REFERENCES public.google_calendar_watch_states(id) ON DELETE CASCADE;


--
-- Name: google_calendar_watch_states google_calendar_watch_states_connector_id_connectors_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_calendar_watch_states
    ADD CONSTRAINT google_calendar_watch_states_connector_id_connectors_id_fk FOREIGN KEY (connector_id) REFERENCES public.connectors(id) ON DELETE CASCADE;


--
-- Name: google_workspace_event_subscription_states google_workspace_event_subscription_states_connector_id_connect; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_workspace_event_subscription_states
    ADD CONSTRAINT google_workspace_event_subscription_states_connector_id_connect FOREIGN KEY (connector_id) REFERENCES public.connectors(id) ON DELETE CASCADE;


--
-- Name: google_workspace_processed_events google_workspace_processed_events_automation_id_zero_workflow_a; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_workspace_processed_events
    ADD CONSTRAINT google_workspace_processed_events_automation_id_zero_workflow_a FOREIGN KEY (automation_id) REFERENCES public.zero_workflow_automations(id) ON DELETE CASCADE;


--
-- Name: google_workspace_processed_events google_workspace_processed_events_subscription_state_id_google_; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_workspace_processed_events
    ADD CONSTRAINT google_workspace_processed_events_subscription_state_id_google_ FOREIGN KEY (subscription_state_id) REFERENCES public.google_workspace_event_subscription_states(id) ON DELETE CASCADE;


--
-- Name: hosted_deployments hosted_deployments_site_id_hosted_sites_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hosted_deployments
    ADD CONSTRAINT hosted_deployments_site_id_hosted_sites_id_fk FOREIGN KEY (site_id) REFERENCES public.hosted_sites(id) ON DELETE CASCADE;


--
-- Name: image_artifacts image_artifacts_file_id_run_uploaded_files_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_artifacts
    ADD CONSTRAINT image_artifacts_file_id_run_uploaded_files_id_fk FOREIGN KEY (file_id) REFERENCES public.run_uploaded_files(id) ON DELETE CASCADE;


--
-- Name: image_artifacts image_artifacts_generation_job_id_built_in_generation_jobs_id_f; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_artifacts
    ADD CONSTRAINT image_artifacts_generation_job_id_built_in_generation_jobs_id_f FOREIGN KEY (generation_job_id) REFERENCES public.built_in_generation_jobs(id) ON DELETE SET NULL;


--
-- Name: mail_drafts mail_drafts_chat_thread_id_chat_threads_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mail_drafts
    ADD CONSTRAINT mail_drafts_chat_thread_id_chat_threads_id_fk FOREIGN KEY (chat_thread_id) REFERENCES public.chat_threads(id) ON DELETE CASCADE;


--
-- Name: mail_drafts mail_drafts_connector_id_connectors_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mail_drafts
    ADD CONSTRAINT mail_drafts_connector_id_connectors_id_fk FOREIGN KEY (connector_id) REFERENCES public.connectors(id) ON DELETE SET NULL;


--
-- Name: mail_drafts mail_drafts_follow_up_automation_id_zero_workflow_automations_i; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mail_drafts
    ADD CONSTRAINT mail_drafts_follow_up_automation_id_zero_workflow_automations_i FOREIGN KEY (follow_up_automation_id) REFERENCES public.zero_workflow_automations(id) ON DELETE SET NULL;


--
-- Name: model_provider_connections model_provider_connections_secret_id_secrets_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_provider_connections
    ADD CONSTRAINT model_provider_connections_secret_id_secrets_id_fk FOREIGN KEY (secret_id) REFERENCES public.secrets(id) ON DELETE CASCADE;


--
-- Name: model_provider_surfaces model_provider_surfaces_connection_id_model_provider_connection; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_provider_surfaces
    ADD CONSTRAINT model_provider_surfaces_connection_id_model_provider_connection FOREIGN KEY (connection_id) REFERENCES public.model_provider_connections(id) ON DELETE CASCADE;


--
-- Name: model_providers model_providers_secret_id_secrets_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_providers
    ADD CONSTRAINT model_providers_secret_id_secrets_id_fk FOREIGN KEY (secret_id) REFERENCES public.secrets(id) ON DELETE CASCADE;


--
-- Name: morning_brief_deliveries morning_brief_deliveries_run_id_agent_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.morning_brief_deliveries
    ADD CONSTRAINT morning_brief_deliveries_run_id_agent_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.agent_runs(id) ON DELETE SET NULL;


--
-- Name: morning_brief_schedules morning_brief_schedules_chat_thread_id_chat_threads_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.morning_brief_schedules
    ADD CONSTRAINT morning_brief_schedules_chat_thread_id_chat_threads_id_fk FOREIGN KEY (chat_thread_id) REFERENCES public.chat_threads(id) ON DELETE SET NULL;


--
-- Name: notion_workflow_pending_events notion_workflow_pending_events_automation_id_zero_workflow_auto; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notion_workflow_pending_events
    ADD CONSTRAINT notion_workflow_pending_events_automation_id_zero_workflow_auto FOREIGN KEY (automation_id) REFERENCES public.zero_workflow_automations(id) ON DELETE CASCADE;


--
-- Name: org_metadata org_metadata_default_agent_id_agent_composes_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_metadata
    ADD CONSTRAINT org_metadata_default_agent_id_agent_composes_id_fk FOREIGN KEY (default_agent_id) REFERENCES public.agent_composes(id) ON DELETE SET NULL;


--
-- Name: org_model_policies org_model_policies_model_provider_id_model_providers_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_model_policies
    ADD CONSTRAINT org_model_policies_model_provider_id_model_providers_id_fk FOREIGN KEY (model_provider_id) REFERENCES public.model_providers(id) ON DELETE SET NULL;


--
-- Name: org_model_policies org_model_policies_model_provider_surface_id_model_provider_sur; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_model_policies
    ADD CONSTRAINT org_model_policies_model_provider_surface_id_model_provider_sur FOREIGN KEY (model_provider_surface_id) REFERENCES public.model_provider_surfaces(id) ON DELETE SET NULL;


--
-- Name: org_usage_allowance_windows org_usage_allowance_windows_created_by_run_id_agent_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_usage_allowance_windows
    ADD CONSTRAINT org_usage_allowance_windows_created_by_run_id_agent_runs_id_fk FOREIGN KEY (created_by_run_id) REFERENCES public.agent_runs(id) ON DELETE SET NULL;


--
-- Name: org_usage_allowance_windows org_usage_allowance_windows_entitlement_id_org_usage_allowance_; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_usage_allowance_windows
    ADD CONSTRAINT org_usage_allowance_windows_entitlement_id_org_usage_allowance_ FOREIGN KEY (entitlement_id) REFERENCES public.org_usage_allowance_entitlements(id) ON DELETE CASCADE;


--
-- Name: presentation_artifacts presentation_artifacts_generation_job_id_built_in_generation_jo; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.presentation_artifacts
    ADD CONSTRAINT presentation_artifacts_generation_job_id_built_in_generation_jo FOREIGN KEY (generation_job_id) REFERENCES public.built_in_generation_jobs(id) ON DELETE SET NULL;


--
-- Name: presentation_artifacts presentation_artifacts_hosted_site_id_hosted_sites_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.presentation_artifacts
    ADD CONSTRAINT presentation_artifacts_hosted_site_id_hosted_sites_id_fk FOREIGN KEY (hosted_site_id) REFERENCES public.hosted_sites(id) ON DELETE CASCADE;


--
-- Name: run_built_in_admissions run_built_in_admissions_run_id_agent_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_built_in_admissions
    ADD CONSTRAINT run_built_in_admissions_run_id_agent_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.agent_runs(id) ON DELETE CASCADE;


--
-- Name: run_uploaded_files run_uploaded_files_chat_thread_id_chat_threads_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_uploaded_files
    ADD CONSTRAINT run_uploaded_files_chat_thread_id_chat_threads_id_fk FOREIGN KEY (chat_thread_id) REFERENCES public.chat_threads(id) ON DELETE SET NULL;


--
-- Name: run_uploaded_files run_uploaded_files_run_id_agent_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_uploaded_files
    ADD CONSTRAINT run_uploaded_files_run_id_agent_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.agent_runs(id) ON DELETE CASCADE;


--
-- Name: runner_job_queue runner_job_queue_run_id_agent_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runner_job_queue
    ADD CONSTRAINT runner_job_queue_run_id_agent_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.agent_runs(id) ON DELETE CASCADE;


--
-- Name: sandbox_telemetry sandbox_telemetry_run_id_agent_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_telemetry
    ADD CONSTRAINT sandbox_telemetry_run_id_agent_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.agent_runs(id) ON DELETE CASCADE;


--
-- Name: skills skills_storage_id_storages_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skills
    ADD CONSTRAINT skills_storage_id_storages_id_fk FOREIGN KEY (storage_id) REFERENCES public.storages(id);


--
-- Name: slack_chat_ingress slack_chat_ingress_route_id_slack_chat_thread_routes_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_chat_ingress
    ADD CONSTRAINT slack_chat_ingress_route_id_slack_chat_thread_routes_id_fk FOREIGN KEY (route_id) REFERENCES public.slack_chat_thread_routes(id) ON DELETE CASCADE;


--
-- Name: slack_chat_thread_routes slack_chat_thread_routes_chat_thread_id_chat_threads_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_chat_thread_routes
    ADD CONSTRAINT slack_chat_thread_routes_chat_thread_id_chat_threads_id_fk FOREIGN KEY (chat_thread_id) REFERENCES public.chat_threads(id) ON DELETE CASCADE;


--
-- Name: slack_chat_thread_routes slack_chat_thread_routes_connection_id_slack_org_connections_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_chat_thread_routes
    ADD CONSTRAINT slack_chat_thread_routes_connection_id_slack_org_connections_id FOREIGN KEY (connection_id) REFERENCES public.slack_org_connections(id) ON DELETE CASCADE;


--
-- Name: slack_org_connections slack_org_connections_slack_workspace_id_slack_org_installation; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_org_connections
    ADD CONSTRAINT slack_org_connections_slack_workspace_id_slack_org_installation FOREIGN KEY (slack_workspace_id) REFERENCES public.slack_org_installations(slack_workspace_id);


--
-- Name: slack_user_agent_preferences slack_user_agent_preferences_selected_compose_id_agent_composes; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_user_agent_preferences
    ADD CONSTRAINT slack_user_agent_preferences_selected_compose_id_agent_composes FOREIGN KEY (selected_compose_id) REFERENCES public.agent_composes(id) ON DELETE SET NULL;


--
-- Name: storage_version_lineage storage_version_lineage_run_id_agent_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_version_lineage
    ADD CONSTRAINT storage_version_lineage_run_id_agent_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.agent_runs(id) ON DELETE CASCADE;


--
-- Name: storage_version_lineage storage_version_lineage_storage_id_storages_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_version_lineage
    ADD CONSTRAINT storage_version_lineage_storage_id_storages_id_fk FOREIGN KEY (storage_id) REFERENCES public.storages(id) ON DELETE CASCADE;


--
-- Name: storage_versions storage_versions_storage_id_storages_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_versions
    ADD CONSTRAINT storage_versions_storage_id_storages_id_fk FOREIGN KEY (storage_id) REFERENCES public.storages(id) ON DELETE CASCADE;


--
-- Name: storages storages_head_version_id_storage_versions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storages
    ADD CONSTRAINT storages_head_version_id_storage_versions_id_fk FOREIGN KEY (head_version_id) REFERENCES public.storage_versions(id);


--
-- Name: strapi_webhook_deliveries strapi_webhook_deliveries_integration_id_strapi_integrations_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strapi_webhook_deliveries
    ADD CONSTRAINT strapi_webhook_deliveries_integration_id_strapi_integrations_id FOREIGN KEY (integration_id) REFERENCES public.strapi_integrations(id) ON DELETE CASCADE;


--
-- Name: strapi_workflow_pending_events strapi_workflow_pending_events_automation_id_zero_workflow_auto; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strapi_workflow_pending_events
    ADD CONSTRAINT strapi_workflow_pending_events_automation_id_zero_workflow_auto FOREIGN KEY (automation_id) REFERENCES public.zero_workflow_automations(id) ON DELETE CASCADE;


--
-- Name: strapi_workflow_pending_events strapi_workflow_pending_events_integration_id_strapi_integratio; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strapi_workflow_pending_events
    ADD CONSTRAINT strapi_workflow_pending_events_integration_id_strapi_integratio FOREIGN KEY (integration_id) REFERENCES public.strapi_integrations(id) ON DELETE CASCADE;


--
-- Name: teams_chat_thread_routes teams_chat_thread_routes_chat_thread_id_chat_threads_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams_chat_thread_routes
    ADD CONSTRAINT teams_chat_thread_routes_chat_thread_id_chat_threads_id_fk FOREIGN KEY (chat_thread_id) REFERENCES public.chat_threads(id) ON DELETE CASCADE;


--
-- Name: teams_chat_thread_routes teams_chat_thread_routes_connection_id_teams_org_connections_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams_chat_thread_routes
    ADD CONSTRAINT teams_chat_thread_routes_connection_id_teams_org_connections_id FOREIGN KEY (connection_id) REFERENCES public.teams_org_connections(id) ON DELETE CASCADE;


--
-- Name: teams_org_connections teams_org_connections_teams_tenant_id_teams_org_installations_t; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams_org_connections
    ADD CONSTRAINT teams_org_connections_teams_tenant_id_teams_org_installations_t FOREIGN KEY (teams_tenant_id) REFERENCES public.teams_org_installations(teams_tenant_id);


--
-- Name: teams_user_agent_preferences teams_user_agent_preferences_selected_compose_id_agent_composes; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams_user_agent_preferences
    ADD CONSTRAINT teams_user_agent_preferences_selected_compose_id_agent_composes FOREIGN KEY (selected_compose_id) REFERENCES public.agent_composes(id) ON DELETE SET NULL;


--
-- Name: telegram_chat_thread_routes telegram_chat_thread_routes_chat_thread_id_chat_threads_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_chat_thread_routes
    ADD CONSTRAINT telegram_chat_thread_routes_chat_thread_id_chat_threads_id_fk FOREIGN KEY (chat_thread_id) REFERENCES public.chat_threads(id) ON DELETE CASCADE;


--
-- Name: telegram_chat_thread_routes telegram_chat_thread_routes_telegram_official_user_link_id_tele; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_chat_thread_routes
    ADD CONSTRAINT telegram_chat_thread_routes_telegram_official_user_link_id_tele FOREIGN KEY (telegram_official_user_link_id) REFERENCES public.telegram_official_user_links(id) ON DELETE CASCADE;


--
-- Name: telegram_chat_thread_routes telegram_chat_thread_routes_telegram_user_link_id_telegram_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_chat_thread_routes
    ADD CONSTRAINT telegram_chat_thread_routes_telegram_user_link_id_telegram_user FOREIGN KEY (telegram_user_link_id) REFERENCES public.telegram_user_links(id) ON DELETE CASCADE;


--
-- Name: telegram_installations telegram_installations_default_compose_id_agent_composes_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_installations
    ADD CONSTRAINT telegram_installations_default_compose_id_agent_composes_id_fk FOREIGN KEY (default_compose_id) REFERENCES public.agent_composes(id) ON DELETE CASCADE;


--
-- Name: telegram_messages telegram_messages_installation_id_telegram_installations_telegr; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_messages
    ADD CONSTRAINT telegram_messages_installation_id_telegram_installations_telegr FOREIGN KEY (installation_id) REFERENCES public.telegram_installations(telegram_bot_id) ON DELETE CASCADE;


--
-- Name: telegram_messages telegram_messages_official_user_link_id_telegram_official_user_; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_messages
    ADD CONSTRAINT telegram_messages_official_user_link_id_telegram_official_user_ FOREIGN KEY (official_user_link_id) REFERENCES public.telegram_official_user_links(id) ON DELETE SET NULL;


--
-- Name: telegram_user_agent_preferences telegram_user_agent_preferences_selected_compose_id_agent_compo; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_user_agent_preferences
    ADD CONSTRAINT telegram_user_agent_preferences_selected_compose_id_agent_compo FOREIGN KEY (selected_compose_id) REFERENCES public.agent_composes(id) ON DELETE SET NULL;


--
-- Name: telegram_user_links telegram_user_links_installation_id_telegram_installations_tele; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_user_links
    ADD CONSTRAINT telegram_user_links_installation_id_telegram_installations_tele FOREIGN KEY (installation_id) REFERENCES public.telegram_installations(telegram_bot_id) ON DELETE CASCADE;


--
-- Name: thread_goals thread_goals_agent_id_zero_agents_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.thread_goals
    ADD CONSTRAINT thread_goals_agent_id_zero_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.zero_agents(id) ON DELETE CASCADE;


--
-- Name: thread_goals thread_goals_chat_thread_id_chat_threads_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.thread_goals
    ADD CONSTRAINT thread_goals_chat_thread_id_chat_threads_id_fk FOREIGN KEY (chat_thread_id) REFERENCES public.chat_threads(id) ON DELETE CASCADE;


--
-- Name: usage_allowance_allocations usage_allowance_allocations_run_id_agent_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_allowance_allocations
    ADD CONSTRAINT usage_allowance_allocations_run_id_agent_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.agent_runs(id) ON DELETE SET NULL;


--
-- Name: usage_allowance_allocations usage_allowance_allocations_short_window_id_org_usage_allowance; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_allowance_allocations
    ADD CONSTRAINT usage_allowance_allocations_short_window_id_org_usage_allowance FOREIGN KEY (short_window_id) REFERENCES public.org_usage_allowance_windows(id) ON DELETE CASCADE;


--
-- Name: usage_allowance_allocations usage_allowance_allocations_usage_event_id_usage_event_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_allowance_allocations
    ADD CONSTRAINT usage_allowance_allocations_usage_event_id_usage_event_id_fk FOREIGN KEY (usage_event_id) REFERENCES public.usage_event(id) ON DELETE CASCADE;


--
-- Name: usage_allowance_allocations usage_allowance_allocations_weekly_window_id_org_usage_allowanc; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_allowance_allocations
    ADD CONSTRAINT usage_allowance_allocations_weekly_window_id_org_usage_allowanc FOREIGN KEY (weekly_window_id) REFERENCES public.org_usage_allowance_windows(id) ON DELETE CASCADE;


--
-- Name: usage_event_hourly_rollup usage_event_hourly_rollup_run_id_agent_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_event_hourly_rollup
    ADD CONSTRAINT usage_event_hourly_rollup_run_id_agent_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.agent_runs(id) ON DELETE SET NULL;


--
-- Name: usage_event usage_event_run_id_agent_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_event
    ADD CONSTRAINT usage_event_run_id_agent_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.agent_runs(id) ON DELETE SET NULL;


--
-- Name: user_connectors user_connectors_agent_id_zero_agents_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_connectors
    ADD CONSTRAINT user_connectors_agent_id_zero_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.zero_agents(id) ON DELETE CASCADE;


--
-- Name: user_custom_connectors user_custom_connectors_agent_id_zero_agents_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_custom_connectors
    ADD CONSTRAINT user_custom_connectors_agent_id_zero_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.zero_agents(id) ON DELETE CASCADE;


--
-- Name: user_permission_grants user_permission_grants_agent_id_zero_agents_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_permission_grants
    ADD CONSTRAINT user_permission_grants_agent_id_zero_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.zero_agents(id) ON DELETE CASCADE;


--
-- Name: variables variables_connector_id_connectors_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.variables
    ADD CONSTRAINT variables_connector_id_connectors_id_fk FOREIGN KEY (connector_id) REFERENCES public.connectors(id) ON DELETE CASCADE;


--
-- Name: video_artifacts video_artifacts_file_id_run_uploaded_files_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.video_artifacts
    ADD CONSTRAINT video_artifacts_file_id_run_uploaded_files_id_fk FOREIGN KEY (file_id) REFERENCES public.run_uploaded_files(id) ON DELETE CASCADE;


--
-- Name: video_artifacts video_artifacts_generation_job_id_built_in_generation_jobs_id_f; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.video_artifacts
    ADD CONSTRAINT video_artifacts_generation_job_id_built_in_generation_jobs_id_f FOREIGN KEY (generation_job_id) REFERENCES public.built_in_generation_jobs(id) ON DELETE SET NULL;


--
-- Name: workflow_user_automation_threads workflow_user_automation_threads_chat_thread_id_chat_threads_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_user_automation_threads
    ADD CONSTRAINT workflow_user_automation_threads_chat_thread_id_chat_threads_id FOREIGN KEY (chat_thread_id) REFERENCES public.chat_threads(id) ON DELETE SET NULL;


--
-- Name: workflow_user_automation_threads workflow_user_automation_threads_workflow_id_zero_workflows_id_; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_user_automation_threads
    ADD CONSTRAINT workflow_user_automation_threads_workflow_id_zero_workflows_id_ FOREIGN KEY (workflow_id) REFERENCES public.zero_workflows(id) ON DELETE CASCADE;


--
-- Name: zero_agent_drafts zero_agent_drafts_agent_id_zero_agents_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zero_agent_drafts
    ADD CONSTRAINT zero_agent_drafts_agent_id_zero_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.zero_agents(id) ON DELETE CASCADE;


--
-- Name: zero_agents zero_agents_id_agent_composes_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zero_agents
    ADD CONSTRAINT zero_agents_id_agent_composes_id_fk FOREIGN KEY (id) REFERENCES public.agent_composes(id) ON DELETE CASCADE;


--
-- Name: zero_agents zero_agents_model_provider_id_model_providers_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zero_agents
    ADD CONSTRAINT zero_agents_model_provider_id_model_providers_id_fk FOREIGN KEY (model_provider_id) REFERENCES public.model_providers(id) ON DELETE SET NULL;


--
-- Name: zero_runs zero_runs_chat_thread_id_chat_threads_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zero_runs
    ADD CONSTRAINT zero_runs_chat_thread_id_chat_threads_id_fk FOREIGN KEY (chat_thread_id) REFERENCES public.chat_threads(id) ON DELETE SET NULL;


--
-- Name: zero_runs zero_runs_goal_id_thread_goals_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zero_runs
    ADD CONSTRAINT zero_runs_goal_id_thread_goals_id_fk FOREIGN KEY (goal_id) REFERENCES public.thread_goals(id) ON DELETE SET NULL;


--
-- Name: zero_runs zero_runs_id_agent_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zero_runs
    ADD CONSTRAINT zero_runs_id_agent_runs_id_fk FOREIGN KEY (id) REFERENCES public.agent_runs(id) ON DELETE CASCADE;


--
-- Name: zero_runs zero_runs_trigger_agent_id_agent_composes_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zero_runs
    ADD CONSTRAINT zero_runs_trigger_agent_id_agent_composes_id_fk FOREIGN KEY (trigger_agent_id) REFERENCES public.agent_composes(id) ON DELETE SET NULL;


--
-- Name: zero_runs zero_runs_workflow_automation_id_zero_workflow_automations_id_f; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zero_runs
    ADD CONSTRAINT zero_runs_workflow_automation_id_zero_workflow_automations_id_f FOREIGN KEY (workflow_automation_id) REFERENCES public.zero_workflow_automations(id) ON DELETE SET NULL;


--
-- Name: zero_workflow_automations zero_workflow_automations_workflow_id_zero_workflows_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zero_workflow_automations
    ADD CONSTRAINT zero_workflow_automations_workflow_id_zero_workflows_id_fk FOREIGN KEY (workflow_id) REFERENCES public.zero_workflows(id) ON DELETE CASCADE;


--
-- Name: zero_workflow_github_processed_events zero_workflow_github_processed_events_automation_id_zero_workfl; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zero_workflow_github_processed_events
    ADD CONSTRAINT zero_workflow_github_processed_events_automation_id_zero_workfl FOREIGN KEY (automation_id) REFERENCES public.zero_workflow_automations(id) ON DELETE CASCADE;


--
-- Name: zero_workflow_strapi_automations zero_workflow_strapi_automations_automation_id_zero_workflow_au; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zero_workflow_strapi_automations
    ADD CONSTRAINT zero_workflow_strapi_automations_automation_id_zero_workflow_au FOREIGN KEY (automation_id) REFERENCES public.zero_workflow_automations(id) ON DELETE CASCADE;


--
-- Name: zero_workflow_strapi_automations zero_workflow_strapi_automations_integration_id_strapi_integrat; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zero_workflow_strapi_automations
    ADD CONSTRAINT zero_workflow_strapi_automations_integration_id_strapi_integrat FOREIGN KEY (integration_id) REFERENCES public.strapi_integrations(id) ON DELETE RESTRICT;


--
-- Name: zero_workflow_webhook_automations zero_workflow_webhook_automations_automation_id_zero_workflow_a; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zero_workflow_webhook_automations
    ADD CONSTRAINT zero_workflow_webhook_automations_automation_id_zero_workflow_a FOREIGN KEY (automation_id) REFERENCES public.zero_workflow_automations(id) ON DELETE CASCADE;


--
-- Name: zero_workflow_webhook_deliveries zero_workflow_webhook_deliveries_automation_id_zero_workflow_au; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zero_workflow_webhook_deliveries
    ADD CONSTRAINT zero_workflow_webhook_deliveries_automation_id_zero_workflow_au FOREIGN KEY (automation_id) REFERENCES public.zero_workflow_automations(id) ON DELETE CASCADE;


--
-- Name: zero_workflows zero_workflows_agent_id_zero_agents_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zero_workflows
    ADD CONSTRAINT zero_workflows_agent_id_zero_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.zero_agents(id) ON DELETE CASCADE;


RESET ALL;


--
-- PostgreSQL database dump complete
--
