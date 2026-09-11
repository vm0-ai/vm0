#!/usr/bin/env python3
"""Collect read-only recovery and runner evidence; never grant retirement clearance."""

import base64
import binascii
import datetime as dt
import errno
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import urllib.parse

SOURCE = "arn:aws:kms:us-west-2:072707626411:key/a1b3922b-fab1-4ed3-aa9e-40f86f92a7a8"
TARGET = "arn:aws:kms:us-west-2:251964670836:key/e68917e2-5541-4597-b6ef-7e9eb5670947"
PROJECT = "hidden-lab-39609750"
REGISTRY_LIMIT = 16 * 1024 * 1024
PRODUCTION_VERSION = re.compile(r"v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?")
REGISTRY_FAILURE_CODES = {
    "invalid_runner_directory",
    "non_regular_registry",
    "registry_size_limit",
    "invalid_registry",
    "duplicate_json_key",
    "missing_registry",
    "registry_access_denied",
    "symlink_registry",
    "registry_io_error",
    "invalid_registry_json",
}
COUNTERS = (
    "productionDirectories",
    "registriesRead",
    "entries",
    "noSecret",
    "source",
    "target",
    "unknownKey",
    "invalid",
    "unreadable",
    "changedDuringRead",
)


class CheckError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise CheckError(code)


def timestamp(value):
    require(isinstance(value, str), "invalid_timestamp")
    require(
        bool(re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z", value)),
        "invalid_timestamp",
    )
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise CheckError("invalid_timestamp") from None


def now():
    return dt.datetime.now(dt.timezone.utc)


def strict_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate_json_key")
        result[key] = value
    return result


def decode_json(content):
    return json.loads(content, object_pairs_hook=strict_object)


def decode_base64(value, size=None):
    require(isinstance(value, str), "invalid_base64")
    decoded = base64.b64decode(value, validate=True)
    require(base64.b64encode(decoded).decode() == value, "invalid_base64")
    require(size is None or len(decoded) == size, "invalid_base64_size")
    return decoded


def key_category(value):
    """Inspect only the documented outer envelope, without decrypting anything."""
    if value is None:
        return "noSecret"
    try:
        require(
            isinstance(value, str) and value.startswith("vm0secret:v1:"),
            "invalid_envelope",
        )
        encoded = value[len("vm0secret:v1:") :]
        require(bool(re.fullmatch(r"[A-Za-z0-9_-]+", encoded)), "invalid_envelope")
        decoded = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
        require(
            base64.urlsafe_b64encode(decoded).decode().rstrip("=") == encoded,
            "invalid_envelope",
        )
        envelope = decode_json(decoded)
        require(isinstance(envelope, dict), "invalid_envelope")
        require(
            type(envelope.get("v")) is int
            and envelope["v"] == 1
            and envelope.get("kind") == "stored-secret",
            "invalid_envelope",
        )
        kms = envelope.get("kms")
        require(isinstance(kms, dict), "invalid_envelope")
        decode_base64(kms.get("ciphertext"))
        if any(k in kms for k in ("encryptedDataKey", "iv", "authTag")):
            require(
                bool(decode_base64(kms.get("encryptedDataKey"))), "invalid_envelope"
            )
            decode_base64(kms.get("iv"), 12)
            decode_base64(kms.get("authTag"), 16)
        key = kms.get("keyId")
        require(isinstance(key, str) and bool(key), "invalid_envelope")
        return (
            "source" if key == SOURCE else "target" if key == TARGET else "unknownKey"
        )
    except (CheckError, ValueError, TypeError, UnicodeError, binascii.Error):
        return "invalid"


def registry_inventory(root):
    counts = dict.fromkeys(COUNTERS, 0)
    failures = []
    require(not root.is_symlink() and root.is_dir(), "runner_root_unavailable")
    directories = list(root.iterdir())
    require(len(directories) <= 1000, "runner_directory_limit")
    # Production promotion names directories v{runner_version}. PR and staging
    # directories have separate names and are intentionally outside this scope.
    for directory in directories:
        if not PRODUCTION_VERSION.fullmatch(directory.name):
            continue
        counts["productionDirectories"] += 1
        path = directory / "proxy-registry.json"
        size = None
        reason = None
        try:
            require(
                not directory.is_symlink() and directory.is_dir(),
                "invalid_runner_directory",
            )
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, "rb") as stream:
                before = os.fstat(stream.fileno())
                size = before.st_size
                require(stat.S_ISREG(before.st_mode), "non_regular_registry")
                require(size <= REGISTRY_LIMIT, "registry_size_limit")
                data = stream.read(REGISTRY_LIMIT + 1)
                require(len(data) <= REGISTRY_LIMIT, "registry_size_limit")
                after = os.fstat(stream.fileno())
            current = path.stat(follow_symlinks=False)

            def identity(s):
                return (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns)

            if identity(before) != identity(after) or identity(before) != identity(
                current
            ):
                counts["changedDuringRead"] += 1
                continue
            registry = decode_json(data)
            require(
                isinstance(registry, dict)
                and isinstance(registry.get("sandboxes"), dict),
                "invalid_registry",
            )
            counts["registriesRead"] += 1
            for entry in registry["sandboxes"].values():
                counts["entries"] += 1
                if not isinstance(entry, dict) or "encryptedSecrets" not in entry:
                    counts["invalid"] += 1
                else:
                    counts[key_category(entry["encryptedSecrets"])] += 1
        except CheckError as error:
            reason = str(error)
        except FileNotFoundError:
            reason = "missing_registry"
        except PermissionError:
            reason = "registry_access_denied"
        except OSError as error:
            reason = (
                "symlink_registry"
                if error.errno == errno.ELOOP
                else "registry_io_error"
            )
        except (ValueError, UnicodeError):
            reason = "invalid_registry_json"
        if reason is not None:
            require(reason in REGISTRY_FAILURE_CODES, "invalid_registry_failure_code")
            counts["unreadable"] += 1
            failures.append(
                {"runnerVersion": directory.name, "reason": reason, "sizeBytes": size}
            )
    return {"counts": counts, "failures": failures}


def runner_fleet():
    hosts = os.environ.get("AWS_METAL_RUNNER_HOSTS", "").split(",")
    hosts = [h.strip() for h in hosts]
    user = os.environ.get("AWS_METAL_RUNNER_USER", "")
    require(bool(re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", user)), "invalid_ssh_user")
    require(
        0 < len(hosts) <= 32 and len(hosts) == len(set(hosts)), "invalid_host_inventory"
    )
    require(
        all(re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9.-]*\.vm3\.ai", h) for h in hosts),
        "invalid_host_inventory",
    )
    script = Path(__file__).read_text()
    results = []
    for index, host in enumerate(hosts, 1):
        result = {"hostOrdinal": index}
        try:
            child = subprocess.run(
                [
                    "ssh",
                    "-T",
                    "-o",
                    "BatchMode=yes",
                    f"{user}@{host}",
                    "sudo -n python3 - runner-local /var/lib/vm0-runner/runners",
                ],
                input=script,
                capture_output=True,
                text=True,
                timeout=130,
            )
            require(
                child.returncode == 0 and len(child.stdout) < 512 * 1024,
                "remote_inventory_failed",
            )
            inventory = decode_json(child.stdout)
            require(
                isinstance(inventory, dict)
                and set(inventory) == {"counts", "failures"},
                "invalid_remote_report",
            )
            counts = inventory["counts"]
            require(
                isinstance(counts, dict) and set(counts) == set(COUNTERS),
                "invalid_remote_report",
            )
            require(
                all(type(v) is int and 0 <= v <= 1_000_000 for v in counts.values()),
                "invalid_remote_report",
            )
            failures = inventory["failures"]
            require(
                isinstance(failures, list)
                and len(failures) == counts["unreadable"]
                and len(failures) <= 1000,
                "invalid_remote_report",
            )
            for failure in failures:
                require(
                    isinstance(failure, dict)
                    and set(failure) == {"runnerVersion", "reason", "sizeBytes"},
                    "invalid_remote_report",
                )
                require(
                    isinstance(failure["runnerVersion"], str)
                    and bool(PRODUCTION_VERSION.fullmatch(failure["runnerVersion"]))
                    and isinstance(failure["reason"], str)
                    and failure["reason"] in REGISTRY_FAILURE_CODES
                    and (
                        failure["sizeBytes"] is None
                        or type(failure["sizeBytes"]) is int
                        and 0 <= failure["sizeBytes"] < 2**63
                    ),
                    "invalid_remote_report",
                )
            result["counts"] = counts
            result["registryFailures"] = failures
        except (CheckError, OSError, ValueError, subprocess.TimeoutExpired):
            result["error"] = "remote_inventory_failed"
        results.append(result)
    totals = dict.fromkeys(COUNTERS, 0)
    for result in results:
        for field, count in result.get("counts", {}).items():
            totals[field] += count
    complete = all(
        "counts" in result and result["counts"]["productionDirectories"] > 0
        for result in results
    )
    complete = complete and not any(
        totals[k] for k in ("unreadable", "changedDuringRead", "invalid", "unknownKey")
    )
    return {
        "hostsExpected": len(hosts),
        "hosts": results,
        "totals": totals,
        "collectionComplete": complete,
        "outerHeadersOnly": True,
        "cryptographicVerification": False,
        "nestedPayloadInspection": False,
        "retainedStateOutsideProductionRegistriesInspected": False,
    }


def neon_read(suffix):
    require(
        suffix == "" or suffix.startswith(("/branches", "/snapshots")),
        "invalid_metadata_endpoint",
    )
    response = subprocess.run(
        [
            "curl",
            "--silent",
            "--show-error",
            "--max-time",
            "30",
            "--max-filesize",
            "8388608",
            "--proto",
            "=https",
            "--header",
            "Authorization: Bearer " + os.environ["NEON_API_KEY"],
            "--write-out",
            "\n%{http_code}",
            f"https://console.neon.tech/api/v2/projects/{PROJECT}" + suffix,
        ],
        capture_output=True,
        text=True,
        timeout=35,
    )
    require(response.returncode == 0, "neon_metadata_request_failed")
    body, code = response.stdout.rsplit("\n", 1)
    require(code == "200", "neon_metadata_request_failed")
    return decode_json(body)


def neon_list(collection):
    items, seen = [], set()
    suffix = "/" + collection
    for _ in range(100):
        result = neon_read(suffix)
        require(
            isinstance(result, dict) and isinstance(result.get(collection), list),
            "invalid_neon_listing",
        )
        items.extend(result[collection])
        require(len(items) <= 10000, "neon_listing_limit")
        pagination = result.get("pagination", {})
        require(isinstance(pagination, dict), "invalid_neon_pagination")
        cursor = pagination.get("cursor")
        if not cursor:
            require(
                not pagination.get("has_more") and not result.get("has_more"),
                "incomplete_neon_listing",
            )
            return items
        require(
            collection == "branches" and isinstance(cursor, str) and cursor not in seen,
            "unsupported_neon_pagination",
        )
        seen.add(cursor)
        suffix = "/branches?" + urllib.parse.urlencode({"cursor": cursor})
    raise CheckError("neon_pagination_limit")


def recovery_history():
    require(os.environ.get("NEON_PROJECT_ID") == PROJECT, "production_project_mismatch")
    cutoff = timestamp(os.environ.get("MIGRATION_VERIFIED_AT"))
    checked = now()
    require(cutoff <= checked, "future_migration_timestamp")
    project = neon_read("")["project"]
    require(project.get("id") == PROJECT, "production_project_mismatch")
    retention = project.get("history_retention_seconds")
    require(type(retention) is int and retention >= 0, "missing_history_retention")
    branches = neon_list("branches")
    require(all(isinstance(b, dict) for b in branches), "invalid_neon_branch")
    production = [b for b in branches if b.get("name") == "production"]
    require(len(production) == 1, "production_branch_not_unique")
    branch_id = production[0].get("id")
    require(
        isinstance(branch_id, str) and bool(re.fullmatch(r"br-[a-z0-9-]+", branch_id)),
        "invalid_branch_id",
    )
    snapshots = neon_list("snapshots")
    require(all(isinstance(s, dict) for s in snapshots), "invalid_neon_snapshot")
    # Snapshot creation time does NOT prove which historical LSN was captured.
    # All retained snapshots need separate recovery/key review, even when new.
    schedule = neon_read(f"/branches/{branch_id}/backup_schedule")
    require(
        isinstance(schedule, dict) and isinstance(schedule.get("schedule"), list),
        "invalid_backup_schedule",
    )
    return {
        "collectionComplete": True,
        "project": PROJECT,
        "migrationVerifiedAt": cutoff.isoformat(),
        "cutoffProvidedByOperator": True,
        "historyRetentionSeconds": retention,
        "configuredHistoryWindowStart": (
            checked - dt.timedelta(seconds=retention)
        ).isoformat(),
        "configuredHistoryWindowOverlapsMigration": checked
        - dt.timedelta(seconds=retention)
        < cutoff,
        "productionBranchFound": True,
        "otherBranchesNotInspected": len(branches) - 1,
        "retainedSnapshotsRequiringKeyReview": len(snapshots),
        "backupScheduleEntries": len(schedule["schedule"]),
        "actualEarliestRestorableTimeVerified": False,
        "backupCiphertextVerified": False,
        "externalBackupsInspected": False,
        "databaseConnected": False,
    }


def main():
    require(len(sys.argv) >= 2, "missing_mode")
    mode = sys.argv[1]
    if mode == "runner-local":
        require(len(sys.argv) == 3, "invalid_runner_arguments")
        print(json.dumps(registry_inventory(Path(sys.argv[2]))))
        return
    require(mode in ("runners", "backups") and len(sys.argv) == 2, "invalid_mode")
    report = {
        "version": 1,
        "scope": mode,
        "runId": os.environ.get("GITHUB_RUN_ID"),
        "commit": os.environ.get("GITHUB_SHA"),
        "startedAt": now().isoformat(),
        "source": SOURCE,
        "target": TARGET,
        "result": "incomplete",
        "retirementCleared": False,
        "productionResourcesChanged": False,
    }
    try:
        require(
            os.environ.get("GITHUB_REPOSITORY") == "vm0-ai/vm0"
            and os.environ.get("GITHUB_REF") == "refs/heads/main"
            and os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch"
            and os.environ.get("GITHUB_WORKFLOW_REF")
            == "vm0-ai/vm0/.github/workflows/kms-production-exit-check.yml@refs/heads/main",
            "protected_workflow_required",
        )
        report["inventory"] = (
            runner_fleet() if mode == "runners" else recovery_history()
        )
        if report["inventory"]["collectionComplete"]:
            report["result"] = "collected"
    except CheckError as error:
        report["failure"] = str(error)
    except Exception:
        # Never emit a provider body, subprocess stdout/stderr or exception text.
        report["failure"] = "metadata_collection_failed"
    report["finishedAt"] = now().isoformat()
    path = Path(os.environ["RUNNER_TEMP"]) / f"kms-exit-{mode}.json"
    path.write_text(json.dumps(report, indent=2) + "\n")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as stream:
            stream.write(
                f"KMS exit dependency inventory ({mode}): **{report['result']}**.\n\n"
            )
            stream.write(
                "This read-only inventory does not clear key or account retirement. Review retained state, recovery history, CloudTrail/Config and rollback requirements.\n\n"
            )
            stream.write("```json\n" + json.dumps(report, indent=2) + "\n```\n")
    print(
        f"KMS exit dependency inventory ({mode}): {report['result']}; retirement is not cleared."
    )
    if report["result"] != "collected":
        raise SystemExit(1)


if __name__ == "__main__":
    try:
        main()
    except CheckError:
        raise SystemExit("kms_exit_check_failed") from None
    except Exception:
        raise SystemExit("kms_exit_check_failed") from None
