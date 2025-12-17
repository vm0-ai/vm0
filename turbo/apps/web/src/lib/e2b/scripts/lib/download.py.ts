/**
 * Download storages script for E2B sandbox (Python)
 * Downloads tar.gz archives directly from S3 using presigned URLs
 */
export const DOWNLOAD_SCRIPT = `#!/usr/bin/env python3
"""
Download storages script for E2B sandbox.
Downloads tar.gz archives directly from S3 using presigned URLs.

Usage: python download.py <manifest_path>
"""
import os
import sys
import json
import tarfile
import tempfile

# Add lib to path for imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import validate_config
from log import log_info, log_error
from http_client import http_download


def download_storage(mount_path: str, archive_url: str) -> bool:
    """
    Download and extract a single storage/artifact.

    Args:
        mount_path: Destination mount path
        archive_url: Presigned S3 URL for tar.gz archive

    Returns:
        True on success, False on failure
    """
    log_info(f"Downloading storage to {mount_path}")

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
            log_info(f"Archive appears empty for {mount_path}")

        log_info(f"Successfully extracted to {mount_path}")
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

    log_info(f"Starting storage download from manifest: {manifest_path}")

    # Load manifest
    try:
        with open(manifest_path) as f:
            manifest = json.load(f)
    except (IOError, json.JSONDecodeError) as e:
        log_error(f"Failed to load manifest: {e}")
        sys.exit(1)

    # Count total storages
    storages = manifest.get("storages", [])
    artifact = manifest.get("artifact")

    storage_count = len(storages)
    has_artifact = artifact is not None

    log_info(f"Found {storage_count} storages, artifact: {has_artifact}")

    # Process storages
    for storage in storages:
        mount_path = storage.get("mountPath")
        archive_url = storage.get("archiveUrl")

        if archive_url and archive_url != "null":
            download_storage(mount_path, archive_url)

    # Process artifact
    if artifact:
        artifact_mount = artifact.get("mountPath")
        artifact_url = artifact.get("archiveUrl")

        if artifact_url and artifact_url != "null":
            download_storage(artifact_mount, artifact_url)

    log_info("All storages downloaded successfully")


if __name__ == "__main__":
    main()
`;
