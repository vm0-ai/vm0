#!/usr/bin/env python3
"""
VAS Benchmark Script
Tests full snapshot vs VAS approach with realistic workspace scenarios
"""

import os
import json
import time
import shutil
import subprocess
import random
import string
from pathlib import Path
from dataclasses import dataclass
from typing import List, Dict

@dataclass
class BenchmarkResult:
    scenario: str
    approach: str
    operation: str
    size_mb: float
    time_seconds: float
    change_percent: int = 0

class WorkspaceGenerator:
    """Generate realistic test workspaces"""

    @staticmethod
    def generate_python_project(path: Path, size_mb: int = 50):
        """Generate a typical Python project with dependencies"""
        path.mkdir(parents=True, exist_ok=True)

        # Create source files
        src_dir = path / "src"
        src_dir.mkdir(exist_ok=True)

        # Generate Python files with realistic content
        for i in range(200):
            file_path = src_dir / f"module_{i}.py"
            lines = []
            lines.append("import os")
            lines.append("import sys")
            lines.append(f"def function_{i}(x, y):")
            lines.append("    return x + y")
            lines.append("")
            lines.append(f"class Class{i}:")
            lines.append("    def __init__(self):")
            lines.append("        self.value = 0")

            # Add padding to reach target size
            padding_size = (size_mb * 1024 * 1024) // 200
            padding = "# " + "x" * (padding_size - 200)
            lines.append(padding)

            file_path.write_text("\n".join(lines))

        # Create requirements.txt
        (path / "requirements.txt").write_text("numpy==1.24.0\npandas==1.5.0\n")

        # Create README
        (path / "README.md").write_text("# Test Project\n\nThis is a test project.")

    @staticmethod
    def generate_ml_artifacts(path: Path, size_mb: int = 200):
        """Generate ML model artifacts (few large files)"""
        path.mkdir(parents=True, exist_ok=True)

        # Generate large binary files simulating model weights
        for i in range(10):
            file_path = path / f"model_weights_{i}.bin"
            size_bytes = (size_mb * 1024 * 1024) // 10
            with open(file_path, "wb") as f:
                f.write(os.urandom(size_bytes))

        # Create model metadata
        metadata = {
            "model_type": "transformer",
            "layers": 24,
            "hidden_size": 768,
            "trained_steps": 100000
        }
        (path / "model_config.json").write_text(json.dumps(metadata, indent=2))

    @staticmethod
    def generate_mixed_workspace(path: Path, size_mb: int = 150):
        """Generate mixed workspace with code, data, and assets"""
        path.mkdir(parents=True, exist_ok=True)

        # Code files (30%)
        code_dir = path / "code"
        code_dir.mkdir(exist_ok=True)
        for i in range(50):
            (code_dir / f"script_{i}.py").write_text(f"# Script {i}\nprint('hello')\n" * 1000)

        # Data files (50%)
        data_dir = path / "data"
        data_dir.mkdir(exist_ok=True)
        for i in range(5):
            size_bytes = (size_mb * 1024 * 1024) // 10
            with open(data_dir / f"data_{i}.csv", "wb") as f:
                f.write(os.urandom(size_bytes))

        # Asset files (20%)
        assets_dir = path / "assets"
        assets_dir.mkdir(exist_ok=True)
        for i in range(3):
            size_bytes = (size_mb * 1024 * 1024) // 15
            with open(assets_dir / f"image_{i}.png", "wb") as f:
                f.write(os.urandom(size_bytes))

class BenchmarkRunner:
    """Run benchmarks comparing full snapshot vs VAS"""

    def __init__(self, base_dir: Path):
        self.base_dir = base_dir
        self.results: List[BenchmarkResult] = []

    def get_dir_size(self, path: Path) -> float:
        """Get directory size in MB"""
        total = sum(f.stat().st_size for f in path.rglob('*') if f.is_file())
        return total / (1024 * 1024)

    def run_command(self, cmd: List[str], env: Dict = None) -> float:
        """Run command and return execution time"""
        start = time.time()
        result = subprocess.run(cmd, env=env, capture_output=True)
        end = time.time()
        if result.returncode != 0:
            print(f"Command failed: {' '.join(cmd)}")
            print(f"Error: {result.stderr.decode()}")
        return end - start

    def benchmark_full_snapshot(self, workspace: Path, scenario: str):
        """Benchmark full snapshot approach (tar.gz)"""
        snapshot_dir = self.base_dir / "snapshots"
        snapshot_dir.mkdir(exist_ok=True)

        # Initial snapshot
        snapshot_v1 = snapshot_dir / f"{scenario}_v1.tar.gz"
        time_v1 = self.run_command([
            "tar", "-czf", str(snapshot_v1), "-C", str(workspace.parent), workspace.name
        ])
        size_v1 = snapshot_v1.stat().st_size / (1024 * 1024)

        self.results.append(BenchmarkResult(
            scenario=scenario,
            approach="full_snapshot",
            operation="initial_checkpoint",
            size_mb=size_v1,
            time_seconds=time_v1
        ))

        # Simulate 5% change
        files = list(workspace.rglob('*'))
        files_to_change = random.sample([f for f in files if f.is_file()],
                                        max(1, len([f for f in files if f.is_file()]) // 20))
        for f in files_to_change:
            with open(f, 'ab') as fp:
                fp.write(b"changed content\n")

        # Incremental snapshot (still full snapshot)
        snapshot_v2 = snapshot_dir / f"{scenario}_v2.tar.gz"
        time_v2 = self.run_command([
            "tar", "-czf", str(snapshot_v2), "-C", str(workspace.parent), workspace.name
        ])
        size_v2 = snapshot_v2.stat().st_size / (1024 * 1024)

        self.results.append(BenchmarkResult(
            scenario=scenario,
            approach="full_snapshot",
            operation="incremental_checkpoint",
            size_mb=size_v2,
            time_seconds=time_v2,
            change_percent=5
        ))

        # Restore
        restore_dir = self.base_dir / f"{scenario}_restore_snapshot"
        if restore_dir.exists():
            shutil.rmtree(restore_dir)
        restore_dir.mkdir()

        time_restore = self.run_command([
            "tar", "-xzf", str(snapshot_v2), "-C", str(restore_dir)
        ])

        self.results.append(BenchmarkResult(
            scenario=scenario,
            approach="full_snapshot",
            operation="restore",
            size_mb=self.get_dir_size(restore_dir),
            time_seconds=time_restore
        ))

    def benchmark_restic(self, workspace: Path, scenario: str):
        """Benchmark Restic VAS approach"""
        repo_dir = self.base_dir / "restic_repos" / scenario
        repo_dir.mkdir(parents=True, exist_ok=True)

        env = os.environ.copy()
        env["RESTIC_PASSWORD"] = "test123"
        env["RESTIC_REPOSITORY"] = str(repo_dir)

        # Initialize repo
        self.run_command(["restic", "init"], env=env)

        # Initial backup
        time_v1 = self.run_command(["restic", "backup", str(workspace)], env=env)
        size_v1 = self.get_dir_size(repo_dir)

        self.results.append(BenchmarkResult(
            scenario=scenario,
            approach="restic_vas",
            operation="initial_checkpoint",
            size_mb=size_v1,
            time_seconds=time_v1
        ))

        # Simulate 5% change
        files = list(workspace.rglob('*'))
        files_to_change = random.sample([f for f in files if f.is_file()],
                                        max(1, len([f for f in files if f.is_file()]) // 20))
        for f in files_to_change:
            with open(f, 'ab') as fp:
                fp.write(b"changed content\n")

        # Incremental backup
        time_v2 = self.run_command(["restic", "backup", str(workspace)], env=env)
        size_v2 = self.get_dir_size(repo_dir)
        size_delta = size_v2 - size_v1

        self.results.append(BenchmarkResult(
            scenario=scenario,
            approach="restic_vas",
            operation="incremental_checkpoint",
            size_mb=size_delta,
            time_seconds=time_v2,
            change_percent=5
        ))

        # Restore
        restore_dir = self.base_dir / f"{scenario}_restore_restic"
        if restore_dir.exists():
            shutil.rmtree(restore_dir)
        restore_dir.mkdir()

        time_restore = self.run_command([
            "restic", "restore", "latest", "--target", str(restore_dir)
        ], env=env)

        self.results.append(BenchmarkResult(
            scenario=scenario,
            approach="restic_vas",
            operation="restore",
            size_mb=self.get_dir_size(restore_dir),
            time_seconds=time_restore
        ))

    def generate_report(self):
        """Generate markdown report from results"""
        report = []
        report.append("# VAS Benchmark Results\n")
        report.append("## Summary Table\n")
        report.append("| Scenario | Approach | Operation | Size (MB) | Time (s) | Change % |")
        report.append("|----------|----------|-----------|-----------|----------|----------|")

        for r in self.results:
            report.append(f"| {r.scenario} | {r.approach} | {r.operation} | "
                         f"{r.size_mb:.2f} | {r.time_seconds:.2f} | {r.change_percent}% |")

        report.append("\n## Analysis\n")

        # Calculate savings
        scenarios = set(r.scenario for r in self.results)
        for scenario in scenarios:
            report.append(f"\n### {scenario}\n")

            snapshot_results = [r for r in self.results
                               if r.scenario == scenario and r.approach == "full_snapshot"]
            vas_results = [r for r in self.results
                          if r.scenario == scenario and r.approach == "restic_vas"]

            if snapshot_results and vas_results:
                snap_incr = next((r for r in snapshot_results
                                 if r.operation == "incremental_checkpoint"), None)
                vas_incr = next((r for r in vas_results
                                if r.operation == "incremental_checkpoint"), None)

                if snap_incr and vas_incr:
                    size_savings = ((snap_incr.size_mb - vas_incr.size_mb) /
                                   snap_incr.size_mb * 100)
                    time_savings = ((snap_incr.time_seconds - vas_incr.time_seconds) /
                                   snap_incr.time_seconds * 100)

                    report.append(f"- **Incremental size savings**: {size_savings:.1f}%")
                    report.append(f"- **Incremental time savings**: {time_savings:.1f}%")

        return "\n".join(report)

def main():
    base_dir = Path("/workspaces/vm0-4/spikes/vas-checkpoint/test-scenarios")
    base_dir.mkdir(parents=True, exist_ok=True)

    generator = WorkspaceGenerator()
    runner = BenchmarkRunner(base_dir)

    # Scenario 1: Python project
    print("Generating Python project workspace...")
    python_workspace = base_dir / "python_project"
    if python_workspace.exists():
        shutil.rmtree(python_workspace)
    generator.generate_python_project(python_workspace, size_mb=50)

    print("Benchmarking Python project with full snapshot...")
    runner.benchmark_full_snapshot(python_workspace, "python_project")

    print("Regenerating Python project for Restic test...")
    shutil.rmtree(python_workspace)
    generator.generate_python_project(python_workspace, size_mb=50)

    print("Benchmarking Python project with Restic VAS...")
    runner.benchmark_restic(python_workspace, "python_project")

    # Scenario 2: ML artifacts
    print("\nGenerating ML artifacts workspace...")
    ml_workspace = base_dir / "ml_artifacts"
    if ml_workspace.exists():
        shutil.rmtree(ml_workspace)
    generator.generate_ml_artifacts(ml_workspace, size_mb=200)

    print("Benchmarking ML artifacts with full snapshot...")
    runner.benchmark_full_snapshot(ml_workspace, "ml_artifacts")

    print("Regenerating ML artifacts for Restic test...")
    shutil.rmtree(ml_workspace)
    generator.generate_ml_artifacts(ml_workspace, size_mb=200)

    print("Benchmarking ML artifacts with Restic VAS...")
    runner.benchmark_restic(ml_workspace, "ml_artifacts")

    # Scenario 3: Mixed workspace
    print("\nGenerating mixed workspace...")
    mixed_workspace = base_dir / "mixed_workspace"
    if mixed_workspace.exists():
        shutil.rmtree(mixed_workspace)
    generator.generate_mixed_workspace(mixed_workspace, size_mb=150)

    print("Benchmarking mixed workspace with full snapshot...")
    runner.benchmark_full_snapshot(mixed_workspace, "mixed_workspace")

    print("Regenerating mixed workspace for Restic test...")
    shutil.rmtree(mixed_workspace)
    generator.generate_mixed_workspace(mixed_workspace, size_mb=150)

    print("Benchmarking mixed workspace with Restic VAS...")
    runner.benchmark_restic(mixed_workspace, "mixed_workspace")

    # Generate report
    report = runner.generate_report()
    report_path = base_dir.parent / "BENCHMARK_RESULTS.md"
    report_path.write_text(report)

    print(f"\nBenchmark complete! Results saved to: {report_path}")
    print("\n" + report)

if __name__ == "__main__":
    main()
