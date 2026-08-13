#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

ruby -ryaml - \
  "${repo_root}/.github/workflows/release-please.yml" \
  "${repo_root}/.github/actions/production-migration-smoke/action.yml" \
  "${repo_root}/.github/actions/neon-branch/action.yml" \
  "${repo_root}/.github/workflows/turbo.yml" <<'RUBY'
def named_step(container, name)
  Array(container.fetch("steps")).find { |step| step["name"] == name } ||
    raise("missing step: #{name}")
end

def guarded_block(source, prefix)
  lines = source.lines.map(&:strip)
  start_index = lines.index { |line| line.start_with?(prefix) }
  raise "missing fail-closed guard: #{prefix}" unless start_index

  end_index = ((start_index + 1)...lines.length).find do |index|
    lines.fetch(index) == "fi"
  end
  raise "unterminated fail-closed guard: #{prefix}" unless end_index

  lines[start_index..end_index]
end

def assert_connection_resolution(source, variable, pooled:)
  prefix = "if ! #{variable}=$(neonctl connection-string"
  assignments = source.lines.map(&:strip).select do |line|
    line.match?(/(?:^|\s)#{Regexp.escape(variable)}=\$\(neonctl connection-string/)
  end
  unless assignments.length == 1
    raise "#{variable} must have exactly one Neon connection-string assignment"
  end
  unless assignments.fetch(0).start_with?(prefix)
    raise "#{variable} retrieval must be guarded"
  end

  has_pooled_flag = assignments.fetch(0).match?(/(?:^|\s)--pooled(?:\s|\))/)
  unless has_pooled_flag == pooled
    connection_class = pooled ? "pooled" : "direct"
    raise "#{variable} must resolve a #{connection_class} Neon URL"
  end

  command_guard = guarded_block(source, prefix)
  unless command_guard.include?("exit 1")
    raise "#{variable} retrieval failure must abort"
  end

  empty_guard = guarded_block(source, %(if [ -z "$#{variable}" ]; then))
  unless empty_guard.include?("exit 1")
    raise "empty #{variable} must abort"
  end
  if empty_guard.any? { |line| line.include?("neonctl connection-string") }
    raise "empty #{variable} must not fall back to another connection class"
  end
end

def assert_masked_before(source, variable, sink)
  mask_index = source.index(%(echo "::add-mask::$#{variable}"))
  sink_index = source.index(sink)
  raise "missing mask for #{variable}" unless mask_index
  raise "missing protected sink for #{variable}: #{sink}" unless sink_index
  unless mask_index < sink_index
    raise "#{variable} must be masked before it is used or written to outputs"
  end
end

def assert_no_url_logging(source, *variables)
  raise "shell tracing could expose database URLs" if source.include?("set -x")

  variables.each do |variable|
    source.lines.each do |line|
      stripped = line.strip
      next unless stripped.start_with?("echo ") && stripped.include?("$#{variable}")
      next if stripped == %(echo "::add-mask::$#{variable}")
      next if stripped.end_with?('>> "$GITHUB_OUTPUT"')

      raise "#{variable} must not be printed"
    end
  end
end

def database_variable_from_command(command)
  match = command.match(
    /\bDATABASE_URL=(?:"?\$\{?)([A-Z][A-Z0-9_]*)(?:\}?"?)/,
  )
  match&.captures&.fetch(0)
end

def output_assignment(source, output_name)
  matches = source.lines.map(&:strip).filter_map do |line|
    match = line.match(
      /(?:^|["'])#{Regexp.escape(output_name)}=\$([A-Z][A-Z0-9_]*)/,
    )
    [match.captures.fetch(0), line] if match
  end
  unless matches.length == 1
    raise "#{output_name} must have exactly one variable-backed output assignment"
  end
  matches.fetch(0)
end

def assert_companion_runtime_routes(source, migration_variable)
  runtime_sinks = source.lines.map(&:strip).filter_map do |line|
    if line.match?(/\bpnpm\b.*\bdb:dev-seed\b/)
      variable = database_variable_from_command(line)
      raise "preview seed must receive an explicit database variable" unless variable
      [variable, line]
    else
      match = line.match(
        /(?:^|["'])((?:runtime-)?database-url)=\$([A-Z][A-Z0-9_]*)/,
      )
      [match.captures.fetch(1), line] if match
    end
  end

  runtime_sinks.each do |variable, sink|
    if variable == migration_variable
      raise "runtime and seed traffic must not share the direct migration URL"
    end
    assert_connection_resolution(source, variable, pooled: true)
    assert_masked_before(source, variable, sink)
    assert_no_url_logging(source, variable)
  end
end

def assert_direct_migration_route(source, variable, sink)
  unless variable.include?("MIGRATION_DATABASE_URL")
    raise "db:migrate must receive an explicitly named migration database URL"
  end
  assert_connection_resolution(source, variable, pooled: false)
  assert_masked_before(source, variable, sink)
  assert_no_url_logging(source, variable)
  assert_companion_runtime_routes(source, variable)
end

def resolve_step_output(steps, expression)
  match = expression.match(
    /\A\$\{\{\s*steps\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)\s*\}\}\z/,
  )
  raise "db:migrate DATABASE_URL must resolve from a step output" unless match

  step_id, output_name = match.captures
  producer = steps.find { |step| step["id"] == step_id }
  raise "missing database URL producer step: #{step_id}" unless producer
  producer_source = producer.fetch("run")
  variable, sink = output_assignment(producer_source, output_name)
  [producer_source, variable, sink]
end

def audit_migration_routes(repo_root)
  paths = Dir[File.join(repo_root, ".github/workflows/*.{yml,yaml}")] +
    Dir[File.join(repo_root, ".github/actions/**/action.{yml,yaml}")]
  neon_route_count = 0

  paths.sort.each do |path|
    document = YAML.load_file(path)
    containers = if document.key?("jobs")
      document.fetch("jobs").map do |name, job|
        ["#{path}:#{name}", job]
      end
    elsif document.key?("runs")
      [[path, document.fetch("runs")]]
    else
      []
    end

    containers.each do |context, container|
      steps = Array(container["steps"])
      steps.each do |step|
        source = step["run"].to_s
        migration_commands = source.lines.map(&:strip).select do |line|
          !line.start_with?("#") && line.match?(/\bpnpm\b.*\bdb:migrate\b/)
        end
        migration_commands.each do |command|
          database_env = step.dig("env", "DATABASE_URL")
          migration_variable = database_variable_from_command(command)
          if !migration_variable &&
              database_env&.start_with?("postgresql://postgres@postgres:")
            next
          end

          migration_source = source
          sink = command
          unless migration_variable
            unless database_env.is_a?(String)
              raise "#{context}: db:migrate has no auditable DATABASE_URL route"
            end
            migration_source, migration_variable, sink = resolve_step_output(
              steps,
              database_env,
            )
          end

          begin
            assert_direct_migration_route(
              migration_source,
              migration_variable,
              sink,
            )
          rescue RuntimeError => error
            raise "#{context}: #{error.message}"
          end
          neon_route_count += 1
        end
      end
    end
  end

  unless neon_route_count >= 5
    raise "expected all five current Neon-backed db:migrate routes to be audited"
  end
end

release = YAML.load_file(ARGV.fetch(0))
release_job = release.fetch("jobs").fetch("promote-api-production")
release_urls = named_step(release_job, "Get Production Database URLs")
raise "production URL step id changed" unless release_urls["id"] == "get-db-urls"
release_source = release_urls.fetch("run")
assert_connection_resolution(release_source, "RUNTIME_DATABASE_URL", pooled: true)
assert_connection_resolution(release_source, "MIGRATION_DATABASE_URL", pooled: false)
assert_masked_before(
  release_source,
  "RUNTIME_DATABASE_URL",
  'echo "runtime-database-url=$RUNTIME_DATABASE_URL" >> "$GITHUB_OUTPUT"',
)
assert_masked_before(
  release_source,
  "MIGRATION_DATABASE_URL",
  'echo "migration-database-url=$MIGRATION_DATABASE_URL" >> "$GITHUB_OUTPUT"',
)
assert_no_url_logging(
  release_source,
  "RUNTIME_DATABASE_URL",
  "MIGRATION_DATABASE_URL",
)

production_environment = named_step(
  release_job,
  "Resolve API production environment",
)
unless production_environment.dig("with", "database-url") ==
    "${{ steps.get-db-urls.outputs.runtime-database-url }}"
  raise "production API must keep the pooled runtime URL"
end
production_migration = named_step(release_job, "Run Production Migrations")
unless production_migration.dig("env", "DATABASE_URL") ==
    "${{ steps.get-db-urls.outputs.migration-database-url }}"
  raise "production db:migrate must use the direct migration URL"
end
unless production_migration.fetch("run").scan("db:migrate").length == 1
  raise "production migration route changed"
end

smoke = YAML.load_file(ARGV.fetch(1)).fetch("runs")
smoke_branch = named_step(smoke, "Create Production Migration Smoke Branch")
smoke_source = smoke_branch.fetch("run")
assert_connection_resolution(smoke_source, "MIGRATION_DATABASE_URL", pooled: false)
assert_masked_before(
  smoke_source,
  "MIGRATION_DATABASE_URL",
  'echo "migration-database-url=$MIGRATION_DATABASE_URL" >> "$GITHUB_OUTPUT"',
)
assert_no_url_logging(smoke_source, "MIGRATION_DATABASE_URL")
raise "production smoke must not resolve pooled URLs" if smoke_source.include?("--pooled")

smoke_migration = named_step(smoke, "Run Production Migration Smoke Test")
unless smoke_migration.dig("env", "DATABASE_URL") ==
    "${{ steps.create-migration-smoke-branch.outputs.migration-database-url }}"
  raise "production smoke db:migrate must use its direct URL"
end
unless smoke_migration.fetch("run").scan("db:migrate").length == 1
  raise "production smoke migration route changed"
end

branch_action = YAML.load_file(ARGV.fetch(2))
unless branch_action.dig("outputs", "database-url", "value") ==
    "${{ steps.branch.outputs.database-url }}"
  raise "Neon branch public database-url output must remain the runtime URL"
end
if branch_action.fetch("outputs").key?("migration-database-url")
  raise "Neon branch direct migration URL must remain internal"
end

branch_runs = branch_action.fetch("runs")
branch = named_step(branch_runs, "Create or Update Neon Branch")
branch_source = branch.fetch("run")
assert_connection_resolution(branch_source, "RUNTIME_DATABASE_URL", pooled: true)
assert_connection_resolution(branch_source, "MIGRATION_DATABASE_URL", pooled: false)
assert_masked_before(
  branch_source,
  "RUNTIME_DATABASE_URL",
  'echo "database-url=$RUNTIME_DATABASE_URL" >> "$GITHUB_OUTPUT"',
)
assert_masked_before(
  branch_source,
  "MIGRATION_DATABASE_URL",
  'echo "migration-database-url=$MIGRATION_DATABASE_URL" >> "$GITHUB_OUTPUT"',
)
assert_no_url_logging(
  branch_source,
  "RUNTIME_DATABASE_URL",
  "MIGRATION_DATABASE_URL",
)

branch_migration = named_step(branch_runs, "Run Database Migrations")
unless branch_migration.dig("env", "DATABASE_URL") ==
    "${{ steps.branch.outputs.migration-database-url }}"
  raise "reusable Neon branch db:migrate must use the direct URL"
end
unless branch_migration.fetch("run").scan("db:migrate").length == 1
  raise "reusable Neon branch migration route changed"
end
if branch_migration.fetch("run").include?("skipping migrations")
  raise "reusable Neon branch migrations must fail closed instead of skipping"
end

turbo = YAML.load_file(ARGV.fetch(3))
deploy_api = turbo.fetch("jobs").fetch("deploy-api")
preview_branch = named_step(deploy_api, "Create Neon Branch")
preview_source = preview_branch.fetch("run")
assert_connection_resolution(
  preview_source,
  "PARENT_MIGRATION_DATABASE_URL",
  pooled: false,
)
assert_connection_resolution(preview_source, "RUNTIME_DATABASE_URL", pooled: true)
assert_connection_resolution(preview_source, "MIGRATION_DATABASE_URL", pooled: false)
assert_masked_before(
  preview_source,
  "PARENT_MIGRATION_DATABASE_URL",
  'DATABASE_URL="$PARENT_MIGRATION_DATABASE_URL" pnpm -F @okouai/db db:migrate',
)
assert_masked_before(
  preview_source,
  "RUNTIME_DATABASE_URL",
  'ENV=preview DATABASE_URL="$RUNTIME_DATABASE_URL" pnpm -F api db:dev-seed',
)
assert_masked_before(
  preview_source,
  "RUNTIME_DATABASE_URL",
  'echo "database-url=$RUNTIME_DATABASE_URL" >> "$GITHUB_OUTPUT"',
)
assert_masked_before(
  preview_source,
  "MIGRATION_DATABASE_URL",
  'DATABASE_URL="$MIGRATION_DATABASE_URL" pnpm -F @okouai/db db:migrate',
)
assert_no_url_logging(
  preview_source,
  "PARENT_MIGRATION_DATABASE_URL",
  "RUNTIME_DATABASE_URL",
  "MIGRATION_DATABASE_URL",
)
preview_migration_count = preview_source.lines.count do |line|
  line.include?("pnpm -F @okouai/db db:migrate")
end
unless preview_migration_count == 2
  raise "Turbo must retain exactly the test-parent and preview migration routes"
end
if preview_source.include?(
  'ENV=preview DATABASE_URL="$MIGRATION_DATABASE_URL" pnpm -F api db:dev-seed',
)
  raise "preview seed traffic must not use the direct migration URL"
end

preview_environment = named_step(deploy_api, "Resolve API deploy environment")
unless preview_environment.dig("with", "database-url") ==
    "${{ steps.neon.outputs.database-url }}"
  raise "deployed preview API must keep the pooled runtime URL"
end

repo_root = File.expand_path("../..", File.dirname(ARGV.fetch(0)))
audit_migration_routes(repo_root)
RUBY

echo "neon-migration-routing-workflow-test: ok"
