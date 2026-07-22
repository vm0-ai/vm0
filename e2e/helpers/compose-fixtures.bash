#!/usr/bin/env bash

# Create or update an agent compose fixture through the legacy compose API.
# Local instructions are uploaded through seed_storage_fixture before the
# compose is created so runner tests exercise the same storage layout as the
# retired vm0 compose command.
#
# Usage: seed_compose_fixture <compose-yaml>
seed_compose_fixture() (
    set -euo pipefail

    if [[ "$#" -ne 1 ]]; then
        echo "# Usage: seed_compose_fixture <compose-yaml>" >&2
        return 1
    fi

    local config_file="$1"
    if [[ ! -f "$config_file" ]]; then
        echo "# Compose fixture not found: $config_file" >&2
        return 1
    fi
    config_file="$(cd "$(dirname "$config_file")" && pwd -P)/$(basename "$config_file")"

    local fixture_tmp_dir
    fixture_tmp_dir="$(mktemp -d)"
    trap 'rm -rf -- "$fixture_tmp_dir"' EXIT

    local content_json="$fixture_tmp_dir/content.json"
    local request_json="$fixture_tmp_dir/request.json"

    ruby -ryaml -rjson - "$config_file" > "$content_json" <<'RUBY'
path = ARGV.fetch(0)
content = YAML.safe_load(
  File.read(path),
  permitted_classes: [],
  permitted_symbols: [],
  aliases: false,
)
STDOUT.write(JSON.generate(content))
RUBY

    local agent_name normalized_agent_name instructions_path framework
    agent_name="$(jq -er '
        .agents
        | keys
        | if length == 1 then .[0] else error("compose fixture must define exactly one agent") end
    ' "$content_json")"
    normalized_agent_name="$(printf '%s' "$agent_name" | tr '[:upper:]' '[:lower:]')"
    instructions_path="$(jq -r --arg agent "$agent_name" '.agents[$agent].instructions // empty' "$content_json")"
    framework="$(jq -r --arg agent "$agent_name" '.agents[$agent].framework // "claude-code"' "$content_json")"

    if [[ -n "$instructions_path" ]]; then
        if [[ "$instructions_path" == /* || "$instructions_path" == *".."* ]]; then
            echo "# Instructions path must be relative and cannot contain '..': $instructions_path" >&2
            return 1
        fi

        local source_path canonical_filename instructions_dir storage_name
        source_path="$(dirname "$config_file")/$instructions_path"
        if [[ ! -f "$source_path" ]]; then
            echo "# Instructions fixture not found: $source_path" >&2
            return 1
        fi

        case "$framework" in
            claude-code) canonical_filename="CLAUDE.md" ;;
            codex) canonical_filename="AGENTS.md" ;;
            *)
                echo "# Unsupported instructions framework: $framework" >&2
                return 1
                ;;
        esac

        instructions_dir="$fixture_tmp_dir/instructions"
        mkdir -p "$instructions_dir"
        cp -- "$source_path" "$instructions_dir/$canonical_filename"
        storage_name="agent-instructions@$normalized_agent_name"
        seed_storage_fixture volume "$storage_name" "$instructions_dir" >/dev/null
    fi

    jq -n --slurpfile content "$content_json" '{content: $content[0]}' > "$request_json"

    local response
    response="$(e2e_api_curl "/api/agent/composes" -X POST --data-binary "@$request_json")"
    jq -e --arg expectedName "$normalized_agent_name" '
        (.composeId | type == "string" and length > 0)
        and (.name == $expectedName)
        and (.versionId | type == "string" and length > 0)
        and (.action == "created" or .action == "existing")
    ' <<< "$response" >/dev/null
    jq -c '.' <<< "$response"
)
