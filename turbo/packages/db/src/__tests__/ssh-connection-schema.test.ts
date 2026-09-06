import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { schema } from "../index";
import { agentSshAccess } from "../schema/agent-ssh-access";
import { agents } from "../schema/agent";
import { sshConnectionCredentials } from "../schema/ssh-connection-credential";
import { sshConnections } from "../schema/ssh-connection";

describe("SSH connection schema", () => {
  it("exports the standalone SSH tables", () => {
    expect(schema.sshConnections).toBe(sshConnections);
    expect(schema.sshConnectionCredentials).toBe(sshConnectionCredentials);
    expect(schema.agentSshAccess).toBe(agentSshAccess);
  });

  it("defines bounded owner-scoped connection storage", () => {
    const config = getTableConfig(sshConnections);
    expect(
      config.columns.map((column) => {
        return column.name;
      }),
    ).toStrictEqual([
      "id",
      "org_id",
      "user_id",
      "display_name",
      "host",
      "port",
      "username",
      "learned_host_key_algorithm",
      "learned_host_key_fingerprint",
      "generation",
      "created_at",
      "updated_at",
    ]);
    expect(
      config.indexes.map((index) => {
        return {
          name: index.config.name,
          unique: index.config.unique,
        };
      }),
    ).toStrictEqual([
      { name: "idx_ssh_connections_owner_host_port", unique: true },
      { name: "idx_ssh_connections_owner_created", unique: false },
    ]);

    const dialect = new PgDialect();
    const checks = Object.fromEntries(
      config.checks.map((check) => {
        return [check.name, dialect.sqlToQuery(check.value).sql];
      }),
    );
    expect(Object.keys(checks)).toStrictEqual([
      "chk_ssh_connections_display_name",
      "chk_ssh_connections_host",
      "chk_ssh_connections_port",
      "chk_ssh_connections_username",
      "chk_ssh_connections_generation",
      "chk_ssh_connections_learned_host_key_pair",
    ]);
    expect(checks.chk_ssh_connections_port).toContain("BETWEEN 1 AND 65535");
    expect(checks.chk_ssh_connections_generation).toContain("> 0");
    expect(checks.chk_ssh_connections_learned_host_key_pair).toContain(
      "IS NULL",
    );
  });

  it("owns one cascading credential row per connection", () => {
    const config = getTableConfig(sshConnectionCredentials);
    expect(config.primaryKeys).toHaveLength(0);
    expect(sshConnectionCredentials.connectionId.primary).toBe(true);
    expect(config.foreignKeys).toHaveLength(1);
    expect(config.foreignKeys[0]?.onDelete).toBe("cascade");
    expect(config.foreignKeys[0]?.reference().foreignTable).toBe(
      sshConnections,
    );
  });

  it("enforces Agent ownership for sparse SSH access", () => {
    const agentConfig = getTableConfig(agents);
    expect(
      agentConfig.uniqueConstraints.map((constraint) => {
        return constraint.name;
      }),
    ).toContain("idx_agents_id_org_owner");

    const accessConfig = getTableConfig(agentSshAccess);
    expect(accessConfig.primaryKeys[0]?.getName()).toBe(
      "agent_ssh_access_pkey",
    );
    const ownerForeignKey = accessConfig.foreignKeys[0];
    expect(ownerForeignKey?.getName()).toBe("agent_ssh_access_agent_owner_fk");
    expect(ownerForeignKey?.onDelete).toBe("cascade");
    expect(ownerForeignKey?.reference().foreignTable).toBe(agents);
    expect(
      ownerForeignKey?.reference().columns.map((column) => {
        return column.name;
      }),
    ).toStrictEqual(["agent_id", "org_id", "user_id"]);
  });
});
