#!/usr/bin/python3

from __future__ import annotations

import json
import os
import sys
import tempfile
import uuid
from collections import Counter
from pathlib import Path

SANDBOX_STATES = ("active", "idle", "preparing", "unknown")
RUNNER_MODES = ("starting", "running", "draining", "stopping", "unknown")
STATUS_RESULTS = ("included", "stopped", "invalid")
STATE_PRECEDENCE = {"unknown": 0, "preparing": 1, "active": 2, "idle": 3}
CANONICAL_RUNNERS_DIR_ENV = "OKOU_RUNNERS_DIR"
DEFAULT_RUNNERS_DIR = "/var/lib/vm0-runner/runners"
CANONICAL_TEXTFILE_DIR_ENV = "OKOU_MONITORING_TEXTFILE_DIR"
DEFAULT_TEXTFILE_DIR = "/var/lib/vm0-monitoring/textfile-collector"


class InvalidStatus(ValueError):
    pass


def parse_sandbox_entry(entry: object) -> tuple[dict[object, object], str]:
    if not isinstance(entry, dict):
        raise InvalidStatus("sandbox entry must be an object")

    value = entry.get("sandbox_id")
    if not isinstance(value, str):
        raise InvalidStatus("sandbox_id must be a string")

    try:
        return entry, str(uuid.UUID(value))
    except ValueError as error:
        raise InvalidStatus("sandbox_id must be a UUID") from error


def parse_collection(status: dict[object, object], field: str) -> list[object]:
    value = status.get(field, [])
    if not isinstance(value, list):
        raise InvalidStatus(f"{field} must be an array")
    return value


def parse_status(path: Path) -> tuple[str, list[tuple[str, str]]]:
    with path.open(encoding="utf-8") as status_file:
        status: object = json.load(status_file)

    if not isinstance(status, dict):
        raise InvalidStatus("status must be an object")

    mode = status.get("mode")
    if not isinstance(mode, str) or not mode:
        raise InvalidStatus("mode must be a non-empty string")

    if mode == "stopped":
        return mode, []

    sandbox_states: list[tuple[str, str]] = []
    for entry in parse_collection(status, "active_runs"):
        active_run, sandbox_id = parse_sandbox_entry(entry)
        if "phase" not in active_run:
            state = "active"
        else:
            phase = active_run["phase"]
            if not isinstance(phase, str):
                raise InvalidStatus("active run phase must be a string")
            state = {"running": "active", "preparing": "preparing"}.get(
                phase, "unknown"
            )
        sandbox_states.append((sandbox_id, state))

    for entry in parse_collection(status, "idle_sandboxes"):
        _, sandbox_id = parse_sandbox_entry(entry)
        sandbox_states.append((sandbox_id, "idle"))

    return mode, sandbox_states


def record_state(states: dict[str, str], sandbox_id: str, state: str) -> None:
    current = states.get(sandbox_id)
    if current is None or STATE_PRECEDENCE[state] > STATE_PRECEDENCE[current]:
        states[sandbox_id] = state


def collect(
    runners_dir: Path,
) -> tuple[Counter[str], Counter[str], Counter[str], int]:
    sandbox_states: dict[str, str] = {}
    runner_modes: Counter[str] = Counter()
    status_results: Counter[str] = Counter()
    collection_success = 1

    if runners_dir.is_symlink():
        print(f"invalid runners directory symlink: {runners_dir}", file=sys.stderr)
        return Counter(), runner_modes, status_results, 0

    if not runners_dir.exists():
        return Counter(), runner_modes, status_results, collection_success

    if not runners_dir.is_dir():
        print(f"invalid runners directory: {runners_dir}", file=sys.stderr)
        return Counter(), runner_modes, status_results, 0

    try:
        runner_dirs = sorted(runners_dir.iterdir(), key=lambda path: path.name)
    except OSError as error:
        print(f"cannot scan runners directory {runners_dir}: {error}", file=sys.stderr)
        return Counter(), runner_modes, status_results, 0

    for runner_dir in runner_dirs:
        if runner_dir.is_symlink():
            print(f"invalid runner directory symlink: {runner_dir}", file=sys.stderr)
            status_results["invalid"] += 1
            collection_success = 0
            continue
        if not runner_dir.is_dir():
            continue

        status_path = runner_dir / "status.json"
        if status_path.is_symlink():
            print(f"invalid status file symlink: {status_path}", file=sys.stderr)
            status_results["invalid"] += 1
            collection_success = 0
            continue
        if not status_path.exists():
            continue
        if not status_path.is_file():
            print(f"invalid status file: {status_path}", file=sys.stderr)
            status_results["invalid"] += 1
            collection_success = 0
            continue

        try:
            mode, entries = parse_status(status_path)
        except (OSError, UnicodeError, json.JSONDecodeError, InvalidStatus) as error:
            print(f"invalid runner status {status_path}: {error}", file=sys.stderr)
            status_results["invalid"] += 1
            collection_success = 0
            continue

        if mode == "stopped":
            status_results["stopped"] += 1
            continue

        status_results["included"] += 1
        runner_modes[mode if mode in RUNNER_MODES else "unknown"] += 1
        for sandbox_id, state in entries:
            record_state(sandbox_states, sandbox_id, state)

    return (
        Counter(sandbox_states.values()),
        runner_modes,
        status_results,
        collection_success,
    )


def render_metrics(
    sandbox_states: Counter[str],
    runner_modes: Counter[str],
    status_results: Counter[str],
    collection_success: int,
) -> str:
    lines = [
        "# HELP vm0_runner_sandboxes Runner-managed sandboxes by lifecycle state.",
        "# TYPE vm0_runner_sandboxes gauge",
    ]
    lines.extend(
        f'vm0_runner_sandboxes{{state="{state}"}} {sandbox_states[state]}'
        for state in SANDBOX_STATES
    )
    lines.extend(
        [
            "",
            "# HELP vm0_runner_instances Live runner instances by lifecycle mode.",
            "# TYPE vm0_runner_instances gauge",
        ]
    )
    lines.extend(
        f'vm0_runner_instances{{mode="{mode}"}} {runner_modes[mode]}'
        for mode in RUNNER_MODES
    )
    lines.extend(
        [
            "",
            "# HELP vm0_runner_status_files Runner status files by collection result.",
            "# TYPE vm0_runner_status_files gauge",
        ]
    )
    lines.extend(
        f'vm0_runner_status_files{{result="{result}"}} {status_results[result]}'
        for result in STATUS_RESULTS
    )
    lines.extend(
        [
            "",
            "# HELP vm0_runner_status_collection_success Whether all runner status inputs were collected successfully.",
            "# TYPE vm0_runner_status_collection_success gauge",
            f"vm0_runner_status_collection_success {collection_success}",
        ]
    )
    return "\n".join(lines) + "\n"


def write_metrics(textfile_dir: Path, metrics: str) -> None:
    if not textfile_dir.is_dir():
        raise FileNotFoundError(f"missing textfile directory: {textfile_dir}")

    descriptor, temporary_name = tempfile.mkstemp(
        prefix=".runner-status.prom.", dir=textfile_dir
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write(metrics)
        temporary_path.chmod(0o644)
        temporary_path.replace(textfile_dir / "runner-status.prom")
    finally:
        temporary_path.unlink(missing_ok=True)


def main() -> None:
    runners_dir = Path(os.environ.get(CANONICAL_RUNNERS_DIR_ENV) or DEFAULT_RUNNERS_DIR)
    textfile_dir = Path(
        os.environ.get(CANONICAL_TEXTFILE_DIR_ENV) or DEFAULT_TEXTFILE_DIR
    )

    metrics = render_metrics(*collect(runners_dir))
    write_metrics(textfile_dir, metrics)


if __name__ == "__main__":
    main()
