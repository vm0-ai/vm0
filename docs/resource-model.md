# Resource Model

## Table of Contents

- [Overview](#overview)
- [Org](#org)
- [Two Orgs at Runtime](#two-orgs-at-runtime)
  - [Agent Org](#agent-org)
  - [Runtime Org](#runtime-org)
- [Resource Classification](#resource-classification)
  - [Static Resources](#static-resources)
  - [Dynamic Resources](#dynamic-resources)
  - [User Private Resources](#user-private-resources)
- [Resource Resolution at Runtime](#resource-resolution-at-runtime)
- [Cross-Org Execution](#cross-org-execution)

---

## Overview

VM0 organizes all resources under **orgs** (Clerk Organizations). An org is a namespace that provides isolation — every resource belongs to exactly one org.

When an agent runs, two orgs are involved:

- **Agent Org**: Where the agent is defined. Owns the agent definition and its static dependencies.
- **Runtime Org**: Where the agent is executed. Determined by who triggers the run.

---

## Org

An org is the fundamental unit of resource isolation in VM0. Each org:

- Is a **Clerk Organization** — Clerk is the single source of truth for identity, membership, and metadata
- Has a globally unique **slug** (e.g., `acme-corp`, `user-a3b4c5d6`)
- Has a **tier** (`free`, `pro`, `max`) that governs usage limits

Users are associated with orgs through **Clerk membership**. A user can belong to multiple orgs with different roles (`admin` or `member`). Every user has a **default org** — typically the first org they joined.

---

## Two Orgs at Runtime

When an agent runs, the system resolves resources from two different orgs:

### Agent Org

The org where the agent compose is defined. This org owns:

- **Agent Compose** — the agent definition itself
- **Volumes** — read-only data dependencies declared by the agent

These resources are **shared across all members** within the org. Any org member can access them regardless of who created them.

### Runtime Org

The org of the user who triggers the run. Combined with the **user's identity**, this org determines:

- **Artifacts** — read-write working directories produced by runs
- **Memories** — persistent memory across runs
- **Secrets** — encrypted credentials (API keys, OAuth tokens)
- **Variables** — non-sensitive configuration values
- **Connectors** — third-party service connections (GitHub, Slack, etc.)
- **Model Providers** — LLM provider configurations (Anthropic, OpenAI, etc.)

These resources are **isolated per user within the org**. Two users in the same Runtime Org each have their own independent set of secrets, artifacts, memories, and so on.

> **Key distinction**: Agent Org resources are identified by org alone. Runtime Org resources are identified by **org + userId**.

---

## Resource Classification

### Static Resources

Static resources belong to the Agent Org. They are created by explicit user actions (deploy, upload) and do not change during agent execution.

#### Agent Compose

The agent definition, written as a `vm0.yaml` file and deployed to an org.

- **Ownership**: Org-level. One agent name maps to exactly one definition within an org.
- **Versioning**: Content-addressed (SHA-256). Each deploy creates an immutable version. A HEAD pointer tracks the current active version.
- **Access control**: Three-tier model:
  1. **Owner** — the user who created the compose (can delete, manage permissions)
  2. **Org member** — any member of the same org (can run, view)
  3. **ACL grants** — explicit public or email-based access for external users

#### Volume

Read-only data mounted into the agent sandbox at specified paths.

- **Ownership**: Org-level. Volumes are shared by all members within the org.
- **Versioning**: Content-addressed (SHA-256), same mechanism as agent compose.
- **Typical use**: Code repositories, reference datasets, dependency bundles.

### Dynamic Resources

Dynamic resources belong to the Runtime Org + userId. They are created or updated automatically during agent execution.

#### Artifact

A read-write working directory that persists agent output across runs.

- **Ownership**: Per-user within the Runtime Org.
- **Versioning**: A new version is committed after each run completes.
- **Typical use**: Generated code, modified files, build outputs.

#### Memory

Persistent storage that carries context across multiple runs of the same agent.

- **Ownership**: Per-user within the Runtime Org.
- **Versioning**: A new version is committed after each run completes.
- **Typical use**: Accumulated knowledge, learned preferences, conversation history.

### User Private Resources

User private resources belong to the Runtime Org + userId. They are configured by the user and consumed during agent execution.

#### Secret

Encrypted credentials for third-party services.

- **Ownership**: Per-user within the Runtime Org.
- **Storage**: Encrypted at rest (AES-256-GCM).
- **Sub-types**:
  - `user` — user-defined secrets (e.g., custom API keys)
  - `connector` — credentials managed by connector integrations
  - `model-provider` — LLM provider credentials
- **Referenced in compose**: `${{ secrets.MY_SECRET }}`

#### Variable

Non-sensitive configuration values stored in plaintext.

- **Ownership**: Per-user within the Runtime Org.
- **Overridable**: CLI-provided values take priority over stored values.
- **Referenced in compose**: `${{ vars.MY_VAR }}`

#### Connector

Metadata for connected third-party services (GitHub, Slack, Linear, etc.).

- **Ownership**: Per-user within the Runtime Org. One connector per service type per user.
- **Note**: Connectors store OAuth metadata only. The actual tokens are stored as secrets with `type=connector`.

#### Model Provider

LLM provider configuration (Anthropic, OpenAI, AWS Bedrock, etc.).

- **Ownership**: Per-user within the Runtime Org. One provider per type per user.
- **Features**: Default provider selection, model selection, multi-auth support.

---

## Resource Resolution at Runtime

When an agent run is triggered, the system resolves all required resources in two phases:

```
Phase 1: Build Execution Context (Runtime Org + userId)
  ├── Resolve secrets referenced in agent compose environment
  ├── Resolve model provider and its credentials
  ├── Resolve connector tokens (with automatic OAuth refresh)
  └── Resolve and merge variables (stored + CLI overrides)

Phase 2: Prepare for Execution (Agent Org + Runtime Org)
  ├── Resolve volumes from Agent Org
  ├── Ensure artifact storage exists in Runtime Org
  ├── Ensure memory storage exists in Runtime Org
  └── Generate storage manifest with presigned URLs
```

All Runtime Org queries use the **(orgId, userId)** key to locate the correct user-specific resources.

---

## Cross-Org Execution

The two-org model enables cross-org execution: a user in one org can run an agent defined in another org.

**Example**: User B (member of `org-b`) runs an agent owned by User A (defined in `org-a`).

```
Agent Org = org-a
  → Agent compose definition
  → Volumes

Runtime Org = org-b, userId = User B
  → User B's secrets, variables, connectors, model providers
  → User B's artifacts and memories
```

This pattern is also used by **scheduled runs**. A schedule carries its own `(orgId, userId)` pair, which becomes the Runtime Org when the schedule fires. This allows User B to schedule User A's agent while using User B's own credentials and producing User B's own artifacts.
