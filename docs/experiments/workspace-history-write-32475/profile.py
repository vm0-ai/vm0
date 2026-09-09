"""Source-pinned synthetic history-write experiment; no production API calls."""

import argparse
import base64
import concurrent.futures
import hashlib
import json
import math
import os
import random
import re
import signal
import subprocess
import time
from pathlib import Path

MIB = 1024 * 1024
CASES = {
    "small": (32768, "claude-code", False),
    "below": (15 * MIB - 1, "claude-code", False),
    "at": (15 * MIB, "claude-code", False),
    "above": (15 * MIB + 1, "claude-code", False),
    "large": (32 * MIB, "claude-code", False),
    "codex": (32768, "codex", False),
    "pi": (32768, "pi", False),
    "native-zstd": (32 * MIB, "codex", True),
    "native-zstd-large": (32 * MIB, "codex", True),
}
ANSI = re.compile(r"\x1b\[[0-9;]*m")


def fixtures(root):
    directory = root / "fixtures"
    directory.mkdir(exist_ok=True)
    metadata = {}
    for name, (size, framework, compressed) in CASES.items():
        # Valid JSONL, exact raw size, deterministic synthetic text. The restore
        # boundary is under test, not the provider's complete conversation parser.
        header = b'{"type":"session_meta","payload":{"id":"019e9154-c304-70f0-adde-36efb1be1701","timestamp":"2026-09-09T00:00:00Z"}}\n'
        prefix = b'{"type":"user","message":{"role":"user","content":"'
        suffix = b'"}}\n'
        content_size = size - len(header + prefix + suffix)
        content = (
            base64.b64encode(random.Random(32475).randbytes(content_size))[
                :content_size
            ]
            if name == "native-zstd-large"
            else b"x" * content_size
        )
        raw = header + prefix + content + suffix
        assert len(raw) == size
        for line in raw.splitlines():
            json.loads(line)
        encoded = (
            subprocess.run(
                ["zstd", "-q", "-3", "-c"], input=raw, capture_output=True, check=True
            ).stdout
            if compressed
            else raw
        )
        if compressed:
            decoded = subprocess.run(
                ["zstd", "-q", "-d", "-c"],
                input=encoded,
                capture_output=True,
                check=True,
            ).stdout
            assert decoded == raw
        target = directory / name
        if target.exists():
            if target.read_bytes() != encoded:
                raise ValueError(f"existing fixture differs: {name}")
        else:
            target.write_bytes(encoded)
        metadata[name] = {
            "raw_bytes": len(raw),
            "transfer_bytes": len(encoded),
            "framework": framework,
            "representation": "native_zstd" if compressed else "raw",
            "sha256": hashlib.sha256(encoded).hexdigest(),
        }
    (directory / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(json.dumps(metadata, indent=2))


def parse_log(log):
    """Join by protocol sequence inside one isolated VM process, never clocks."""
    samples = []
    current = None
    details = {}
    guest_sequence = None
    decoder = json.JSONDecoder()
    for line in ANSI.sub("", log).splitlines():
        if "PROFILE_BEGIN iteration=" in line:
            current = {
                "iteration": int(line.split("PROFILE_BEGIN iteration=", 1)[1]),
                "host_chunks": [],
                "host_path_ns": [],
                "publish_ns": [],
                "verified": False,
            }
        if "PROFILE_DETAIL " in line:
            detail, _ = decoder.raw_decode(line.split("PROFILE_DETAIL ", 1)[1])
            phase = detail["phase"]
            if phase == "guest_begin":
                guest_sequence = detail["seq"]
            sequence = detail.get(
                "seq", guest_sequence if phase.startswith("guest_") else None
            )
            if sequence is not None:
                details.setdefault(sequence, {})[phase] = detail
            if current is not None and phase == "host_chunk":
                current["host_chunks"].append(detail["seq"])
            if current is not None and phase == "host_path":
                current["host_path_ns"].append(detail["duration_ns"])
            if current is not None and phase == "host_publish":
                current["publish_ns"].append(detail["duration_ns"])
        if "PROFILE_RESULT " in line:
            result, _ = decoder.raw_decode(line.split("PROFILE_RESULT ", 1)[1])
            if current is None or current["iteration"] != result["iteration"]:
                raise ValueError("result without matching invocation")
            current.update(result)
            samples.append(current)
            current = None
        if "PROFILE_VERIFIED iteration=" in line:
            iteration = int(line.split("PROFILE_VERIFIED iteration=", 1)[1])
            matches = [sample for sample in samples if sample["iteration"] == iteration]
            if len(matches) != 1:
                raise ValueError("verification without unique result")
            matches[0]["verified"] = True
    for sample in samples:
        sample["details"] = [details[seq] for seq in sample.pop("host_chunks")]
        sample["timings_ns"] = phase_totals(sample)
    return samples


def phase_totals(sample):
    chunks = sample["details"]
    if not chunks:
        return None
    if len(chunks) != sample["chunks"]:
        raise ValueError("missing chunk measurements")

    def total(phase, field):
        values = [chunk.get(phase, {}).get(field) for chunk in chunks]
        return sum(values) if all(value is not None for value in values) else None

    fields = {
        "host_gate": ("host_chunk", "gate_ns"),
        "host_chunks": ("host_chunk", "duration_ns"),
        "host_builder_wait": ("host_frame", "builder_wait_ns"),
        "host_encode": ("host_frame", "encode_ns"),
        "host_write_with_lock": ("host_frame", "write_with_lock_ns"),
        "host_reply": ("host_reply", "duration_ns"),
        "guest_queue_copy": ("guest_begin", "queue_and_copy_ns"),
        "guest_handler": ("guest_handler", "duration_ns"),
        "guest_spawn": ("guest_spawn", "duration_ns"),
        "guest_child_setup": ("guest_wait", "child_and_setup_ns"),
        "guest_stdin_join": ("guest_wait", "stdin_join_ns"),
        "guest_stderr_drain": ("guest_wait", "stderr_drain_ns"),
        "guest_stdin_overlap": ("guest_stdin", "duration_ns"),
        "guest_open": ("guest_io", "open_ns"),
        "guest_copy_stdin_overlap": ("guest_io", "copy_with_stdin_ns"),
        "guest_flush": ("guest_io", "flush_ns"),
    }
    result = {name: total(*field) for name, field in fields.items()}
    result["host_path"] = (
        sum(sample["host_path_ns"]) if len(sample["host_path_ns"]) == 1 else None
    )
    result["host_publish"] = (
        sum(sample["publish_ns"]) if len(sample["publish_ns"]) == 1 else None
    )
    for name, outer, children in (
        (
            "host_chunk_residual",
            result["host_chunks"],
            [
                result[key]
                for key in (
                    "host_gate",
                    "host_builder_wait",
                    "host_encode",
                    "host_write_with_lock",
                    "host_reply",
                )
            ],
        ),
        (
            "host_outer_residual",
            sample["duration_ns"],
            [
                result["host_path"],
                result["host_chunks"],
                result["host_publish"] if sample["chunks"] > 1 else 0,
            ],
        ),
        (
            "guest_handler_residual",
            result["guest_handler"],
            [
                result[key]
                for key in (
                    "guest_spawn",
                    "guest_child_setup",
                    "guest_stdin_join",
                    "guest_stderr_drain",
                )
            ],
        ),
    ):
        result[name] = (
            outer - sum(children)
            if outer is not None and all(value is not None for value in children)
            else None
        )
        if result[name] is not None and result[name] < 0:
            raise ValueError(f"negative same-process residual: {name}")
    return result


def run_one(root, config, arm, case, block, index, slot, repeats, output):
    runner = root / arm / "runner"
    framework, native = CASES[case][1:]
    command = [
        str(runner),
        "benchmark",
        "--config",
        str(config),
        "--profile",
        "vm0/default",
        "--history-file",
        str(root / "fixtures" / case),
        "--history-framework",
        framework,
        "--history-repeat",
        str(repeats),
        "true",
    ]
    if native:
        command += ["--history-zstd"]
    env = dict(os.environ, NO_COLOR="1", RUST_LOG="info")
    name = f"{block}-{index}-{case}-{arm}-{slot}"
    before = time.monotonic()
    failure = None
    with subprocess.Popen(
        ["/usr/bin/time", "-f", "PROFILE_RESOURCE %U %S %M", *command],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=env,
        start_new_session=True,
    ) as process:
        try:
            log, _ = process.communicate(timeout=240)
            status = process.returncode
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                log, _ = process.communicate(timeout=30)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                log, _ = process.communicate()
            status = 124
            failure = "timed out; inspect owned resources before continuing"
    (output / f"{name}.log").write_text(log)
    try:
        samples = parse_log(log)
    except (ValueError, KeyError, TypeError) as error:
        samples = []
        failure = f"invalid measurement capture: {error}"
    if failure is None and (
        status
        or len(samples) != repeats
        or not all(s["success"] and s["verified"] for s in samples)
    ):
        failure = "failed or incomplete experiment"
    counters = re.search(r"PROFILE_RESOURCE ([0-9.]+) ([0-9.]+) ([0-9]+)", log)
    record = {
        "block": block,
        "index": index,
        "case": case,
        "arm": arm,
        "slot": slot,
        "status": status,
        "failure": failure,
        "expected_samples": repeats,
        "wall_ms": (time.monotonic() - before) * 1000,
        "load": os.getloadavg(),
        "samples": samples,
        "cpu_seconds": float(counters[1]) + float(counters[2]) if counters else None,
        "maxrss_kib": int(counters[3]) if counters else None,
    }
    (output / f"{name}.json").write_text(json.dumps(record, indent=2) + "\n")
    print(
        json.dumps({key: value for key, value in record.items() if key != "samples"}),
        flush=True,
    )
    if failure:
        raise RuntimeError(f"{failure}: {name}")
    return record


def matrix(args):
    root = args.root.resolve()
    images = json.loads(args.images.read_text())
    output = root / args.output
    output.mkdir()
    configs = {}
    for arm in ("baseline", "observed"):
        for slot in range(args.concurrency):
            dirname = f"issue-32475-vm4-{arm}-{slot}"
            subprocess.run(
                [
                    str(root / arm / "runner"),
                    "config",
                    "--runner-dirname",
                    dirname,
                    "--group",
                    f"vm0/{dirname}",
                    "--hostname",
                    "local-11.gcp.vm3.ai",
                    "--profile",
                    "vm0/default",
                    "--rootfs-hash",
                    images[arm]["rootfs"],
                    "--snapshot-hash",
                    images[arm]["snapshot"],
                    "--max-concurrent",
                    "1",
                    "--api-url",
                    "http://127.0.0.1:19975",
                    "--token",
                    "synthetic-no-api",
                ],
                check=True,
                stdout=subprocess.DEVNULL,
            )
            configs[arm, slot] = (
                Path("/var/lib/vm0-runner/runners") / dirname / "runner.yaml"
            )
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        for block in range(args.blocks):
            for index in range(args.samples):
                for case in args.cases:
                    arms = (
                        ("baseline", "observed")
                        if (block + index) % 2 == 0
                        else ("observed", "baseline")
                    )
                    for arm in arms:
                        futures = [
                            pool.submit(
                                run_one,
                                root,
                                configs[arm, slot],
                                arm,
                                case,
                                block,
                                index,
                                slot,
                                args.repeats,
                                output,
                            )
                            for slot in range(args.concurrency)
                        ]
                        for future in futures:
                            future.result()
    print(f"COMPLETE {output}", flush=True)


def percentile(values, percent):
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * percent / 100) - 1)]


def read_records(source):
    if source.is_file():
        return [json.loads(line) for line in source.read_text().splitlines()]
    missing = {path.stem for path in source.glob("*.log")} - {
        path.stem for path in source.glob("*.json")
    }
    if missing:
        raise ValueError(f"logs without process records: {sorted(missing)}")
    return [json.loads(path.read_text()) for path in sorted(source.glob("*.json"))]


def export(directory):
    for record in read_records(directory):
        for sample in record["samples"]:
            # Keep already-derived per-invocation times and outcomes. Full
            # sequence-correlated records and console logs stay in raw evidence.
            sample.pop("details")
            sample.pop("host_path_ns")
            sample.pop("publish_ns")
        print(json.dumps(record, separators=(",", ":")))


def analyze(directory):
    groups = {}
    processes = read_records(directory)
    for record in processes:
        for sample in record["samples"]:
            sample = dict(
                sample,
                process_success=record["status"] == 0 and record["failure"] is None,
            )
            key = (
                record["case"],
                record["arm"],
                "first" if sample["iteration"] == 0 else "repeat",
            )
            groups.setdefault(key, []).append(sample)
    summary = []
    for (case, arm, lifecycle), samples in sorted(groups.items()):
        complete = [
            sample
            for sample in samples
            if sample["success"] and sample["verified"] and sample["process_success"]
        ]
        durations = [sample["duration_ns"] / 1e6 for sample in complete]
        row = {
            "case": case,
            "arm": arm,
            "lifecycle": lifecycle,
            "n": len(samples),
            "complete": len(complete),
            "ms": {str(p): percentile(durations, p) for p in (50, 90, 95, 99)}
            if durations
            else None,
        }
        phase_names = {
            name for sample in complete for name in (sample.get("timings_ns") or {})
        }
        row["phases"] = {}
        for name in sorted(phase_names):
            values = [
                sample["timings_ns"][name] / 1e6
                for sample in complete
                if sample.get("timings_ns") and sample["timings_ns"][name] is not None
            ]
            row["phases"][name] = {
                "n": len(values),
                "ms": {str(p): percentile(values, p) for p in (50, 90, 95, 99)}
                if values
                else None,
            }
        summary.append(row)
    if not processes:
        raise ValueError("no experiment process records")
    print(
        json.dumps(
            {
                "processes": len(processes),
                "failed_processes": sum(
                    record["status"] != 0 or record["failure"] is not None
                    for record in processes
                ),
                "expected_samples": sum(
                    record["expected_samples"] for record in processes
                ),
                "captured_samples": sum(len(record["samples"]) for record in processes),
                "groups": summary,
            },
            indent=2,
        )
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    prepare = commands.add_parser("fixtures")
    prepare.add_argument("root", type=Path)
    run = commands.add_parser("matrix")
    run.add_argument("root", type=Path)
    run.add_argument("images", type=Path)
    run.add_argument("--output", required=True)
    run.add_argument("--cases", nargs="+", choices=CASES, default=list(CASES))
    run.add_argument("--blocks", type=int, default=2)
    run.add_argument("--samples", type=int, default=2)
    run.add_argument("--repeats", type=int, default=5)
    run.add_argument("--concurrency", type=int, choices=(1, 2), default=1)
    report = commands.add_parser("analyze")
    report.add_argument("directory", type=Path)
    compact = commands.add_parser("export")
    compact.add_argument("directory", type=Path)
    parse = commands.add_parser("parse")
    parse.add_argument("log", type=Path)
    args = parser.parse_args()
    if args.command == "fixtures":
        fixtures(args.root)
    elif args.command == "matrix":
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", args.output):
            parser.error("output must be a fresh simple directory name")
        if not (
            1 <= args.blocks <= 10
            and 1 <= args.samples <= 20
            and 1 <= args.repeats <= 100
        ):
            parser.error("matrix bounds exceeded")
        matrix(args)
    elif args.command == "analyze":
        analyze(args.directory)
    elif args.command == "export":
        export(args.directory)
    else:
        print(json.dumps(parse_log(args.log.read_text()), indent=2))


if __name__ == "__main__":
    main()
