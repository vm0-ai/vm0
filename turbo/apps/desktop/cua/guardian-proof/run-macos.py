"""Dedicated macOS CI only. kqueue observes exits independently of the owner."""

import json
import os
from pathlib import Path
import platform
import select
import subprocess
import sys
import time


def read_when_present(path, child):
    until = time.monotonic() + 8
    while time.monotonic() < until:
        if path.exists():
            return path.read_text()
        if child.poll() is not None:
            raise RuntimeError(f"main exited before {path.name}")
        time.sleep(0.01)
    raise RuntimeError(f"no marker {path.name}")


def run_case(electron, build, sdk, output, mode, iteration):
    directory = output / f"{mode}-{iteration}"
    directory.mkdir(mode=0o700)
    socket = directory / "d.sock"
    environment = {
        "HOME": str(directory),
        "TMPDIR": str(directory),
        "PATH": "/usr/bin:/bin",
    }
    with (directory / "electron.log").open("w") as log:
        child = subprocess.Popen(
            [str(electron), str(Path(__file__).with_name("main.mjs")),
             str(build), str(sdk), str(socket), mode],
            env=environment, stdout=log, stderr=log,
        )
        info = json.loads(read_when_present(Path(f"{socket}.main"), child))
        assert info["electron"] == "42.5.1", info
        if mode == "spawn-stop":
            child.wait(timeout=10)
            result = json.loads(Path(f"{socket}.result").read_text())
            assert result["confirmed"], result
            return {"identity": info, "result": result}
        helper = json.loads(read_when_present(Path(f"{socket}.helper"), child))
        daemon, parent, group = map(
            int, Path(f"{socket}.daemon").read_text().split())
        assert parent == helper["pid"] and group == info["guardian"]
        assert helper["parent"] == info["guardian"]
        assert helper["stateStarting"] and helper["connectionAbsent"]
        assert not helper["settled"]
        assert os.getpgid(child.pid) != group
        assert os.getpgid(os.getpid()) != group
        observed_pids = {child.pid, info["guardian"], helper["pid"], daemon}
        queue = select.kqueue()
        registrations = [select.kevent(
            pid, filter=select.KQ_FILTER_PROC,
            flags=select.KQ_EV_ADD | select.KQ_EV_ONESHOT,
            fflags=select.KQ_NOTE_EXIT) for pid in observed_pids]
        queue.control(registrations, 0, 0)
        started = time.monotonic()
        Path(f"{socket}.fault").touch()
        exits = {}
        while time.monotonic() - started < 12 and len(exits) < len(observed_pids):
            for event in queue.control(None, 8, 0.05):
                if event.flags & select.KQ_EV_ERROR:
                    raise RuntimeError(f"kqueue error: {event}")
                if event.fflags & select.KQ_NOTE_EXIT:
                    exits[event.ident] = (time.monotonic() - started) * 1000
        queue.close()
        child.wait(timeout=10)
        assert set(exits) == observed_pids, (mode, exits, observed_pids)
        if mode == "main-dies":
            assert max(exits.values()) < 5000, exits
            result = {"mode": mode, "parentDeathExitObserved": True}
        else:
            result = json.loads(Path(f"{socket}.result").read_text())
            negative = mode in {"failed-kill", "identity-mismatch", "lost-observation"}
            assert result["confirmed"] is not negative, result
            assert result["beats"] >= 200, result
            if negative:
                assert result["fenceRetained"], result
                assert 4990 <= result["elapsedMs"] < 5200, result
            else:
                assert result["elapsedMs"] < 5000, result
                # Actual kernel exit events must also fit the original budget.
                assert max(exits.values()) < 5000, exits
            if mode == "guardian-dies":
                assert result["crashSample"]["exited"] == 1, result
                assert result["crashSample"]["waitError"] == 0, result
                assert result["crashSample"]["remaining"] >= 2, result
        return {
            "identity": info, "helper": helper, "daemon": daemon, "group": group,
            "kernelExitObservedMs": exits, "result": result,
        }


def main():
    if sys.platform != "darwin":
        raise RuntimeError("This proof requires macOS; Linux is not equivalent")
    electron, build, sdk, output = map(Path, sys.argv[1:])
    output.mkdir(parents=True, exist_ok=True)
    results = {
        "platform": platform.platform(), "architecture": platform.machine(),
        "source": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
        "signing": "ad-hoc proof executables; Developer ID/TCC untested",
        "cases": [],
    }
    cases = [("blocked-before-ready", i) for i in range(3)]
    cases += [(mode, 0) for mode in [
        "guardian-dies", "helper-dies", "main-dies", "failed-kill",
        "identity-mismatch", "lost-observation",
    ]]
    cases += [("spawn-stop", i) for i in range(10)]
    try:
        for mode, iteration in cases:
            result = run_case(electron, build, sdk, output, mode, iteration)
            results["cases"].append(result)
            print(json.dumps(result), flush=True)
    except Exception as error:
        results["failure"] = str(error)
        raise
    finally:
        (output / "results.json").write_text(json.dumps(results, indent=2) + "\n")


if __name__ == "__main__":
    main()
