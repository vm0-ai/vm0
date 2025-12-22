/**
 * Download storages script for E2B sandbox (Python)
 * Downloads tar.gz archives directly from S3 using presigned URLs
 * Includes mount verification with ls -la output
 */
export const DOWNLOAD_SCRIPT = `#!/usr/bin/env python3
"""
Download storages script for E2B sandbox.
Downloads tar.gz archives directly from S3 using presigned URLs.
Includes lifecycle logging and mount verification.

Usage: python download.py <manifest_path>
"""
import os
import sys
import json
import tarfile
import tempfile
import time
import subprocess

# Add lib to path for imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from log import log_info, log_error


def format_size(size_bytes: int) -> str:
    """Format bytes as human-readable size."""
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    elif size_bytes < 1024 * 1024 * 1024:
        return f"{size_bytes / (1024 * 1024):.1f} MB"
    else:
        return f"{size_bytes / (1024 * 1024 * 1024):.1f} GB"


def verify_mount(mount_path: str, name: str, max_lines: int = 20) -> None:
    """
    Verify mount by listing directory contents.

    Args:
        mount_path: Path to verify
        name: Display name (volume name or 'artifact')
        max_lines: Maximum lines to display from ls -la
    """
    log_info(f"  {name}: {mount_path}")

    if not os.path.exists(mount_path):
        log_info(f"    (directory does not exist)")
        return

    try:
        result = subprocess.run(
            ['ls', '-la', mount_path],
            capture_output=True,
            text=True,
            timeout=10
        )

        lines = result.stdout.strip().split('\\n') if result.stdout.strip() else []

        if not lines:
            log_info(f"    (empty directory)")
            return

        # Show lines up to max_lines
        for line in lines[:max_lines]:
            log_info(f"    {line}")

        if len(lines) > max_lines:
            log_info(f"    ... and {len(lines) - max_lines} more entries")

    except subprocess.TimeoutExpired:
        log_info(f"    (ls timed out)")
    except Exception as e:
        log_info(f"    (error: {e})")


def download_storage(mount_path: str, archive_url: str) -> bool:
    """
    Download and extract a single storage/artifact.

    Args:
        mount_path: Destination mount path
        archive_url: Presigned S3 URL for tar.gz archive

    Returns:
        True on success, False on failure
    """
    # Import http_download here to avoid circular import at module load
    from http_client import http_download

    # Create temp file for download
    temp_tar = tempfile.mktemp(suffix=".tar.gz", prefix="storage-")

    try:
        # Download tar.gz with retry
        if not http_download(archive_url, temp_tar):
            log_error(f"Failed to download archive for {mount_path}")
            return False

        # Create mount path directory
        os.makedirs(mount_path, exist_ok=True)

        # Extract to mount path (handle empty archive gracefully)
        try:
            with tarfile.open(temp_tar, "r:gz") as tar:
                tar.extractall(path=mount_path)
        except tarfile.ReadError:
            # Empty or invalid archive - not a fatal error
            log_info(f"  (archive empty for {mount_path})")

        return True

    finally:
        # Cleanup temp file
        try:
            os.remove(temp_tar)
        except OSError:
            pass


def main():
    """Main entry point for download storages script."""
    if len(sys.argv) < 2:
        log_error("Usage: python download.py <manifest_path>")
        sys.exit(1)

    manifest_path = sys.argv[1]

    if not os.path.exists(manifest_path):
        log_error(f"Manifest file not found: {manifest_path}")
        sys.exit(1)

    # Lifecycle: Storage phase start
    log_info("▷ Storage")
    start_time = time.time()

    # Load manifest
    try:
        with open(manifest_path) as f:
            manifest = json.load(f)
    except (IOError, json.JSONDecodeError) as e:
        log_error(f"Failed to load manifest: {e}")
        duration = int(time.time() - start_time)
        log_info(f"✗ Storage failed ({duration}s)")
        sys.exit(1)

    # Count total storages
    storages = manifest.get("storages", [])
    artifact = manifest.get("artifact")

    storage_count = len(storages)
    has_artifact = artifact is not None

    if storage_count == 0 and not has_artifact:
        log_info("No storages configured")
        duration = int(time.time() - start_time)
        log_info(f"✓ Storage complete ({duration}s)")
        return

    log_info(f"Found {storage_count} volume(s), artifact: {has_artifact}")

    # Download phase
    download_failed = False

    for storage in storages:
        name = storage.get("name", "unnamed")
        mount_path = storage.get("mountPath")
        archive_url = storage.get("archiveUrl")
        archive_size = storage.get("archiveSize", 0)

        size_str = format_size(archive_size) if archive_size else "unknown size"

        if archive_url and archive_url != "null":
            log_info(f"Downloading volume '{name}' to {mount_path} ({size_str})")
            if not download_storage(mount_path, archive_url):
                download_failed = True

    if artifact:
        artifact_mount = artifact.get("mountPath")
        artifact_url = artifact.get("archiveUrl")
        artifact_size = artifact.get("archiveSize", 0)

        size_str = format_size(artifact_size) if artifact_size else "unknown size"

        if artifact_url and artifact_url != "null":
            log_info(f"Downloading artifact to {artifact_mount} ({size_str})")
            if not download_storage(artifact_mount, artifact_url):
                download_failed = True

    if download_failed:
        duration = int(time.time() - start_time)
        log_info(f"✗ Storage failed ({duration}s)")
        sys.exit(1)

    # Verification phase
    log_info("Verifying mounts...")

    for storage in storages:
        name = storage.get("name", "unnamed")
        mount_path = storage.get("mountPath")
        if mount_path:
            verify_mount(mount_path, name)

    if artifact:
        artifact_mount = artifact.get("mountPath")
        if artifact_mount:
            verify_mount(artifact_mount, "artifact")

    # Lifecycle: Storage phase complete
    duration = int(time.time() - start_time)
    log_info(f"✓ Storage complete ({duration}s)")


if __name__ == "__main__":
    main()
`;
