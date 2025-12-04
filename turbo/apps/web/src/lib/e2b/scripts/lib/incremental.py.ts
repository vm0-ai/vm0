/**
 * Incremental upload script for VAS (Versioned Artifact Storage) (Python)
 * Computes manifest diff and uploads only changed files to reduce bandwidth
 */
export const INCREMENTAL_SCRIPT = `#!/usr/bin/env python3
"""
Incremental upload module for VAS (Versioned Artifact Storage).
Computes manifest diff and uploads only changed files to reduce bandwidth.
"""
import os
import json
import hashlib
import tarfile
import tempfile
import shutil
from typing import Optional, Dict, Any, List, Set

from common import RUN_ID, INCREMENTAL_WEBHOOK_URL
from log import log_info, log_warn, log_error, log_debug
from http_client import http_post_form, http_download
from vas_snapshot import create_vas_snapshot


def compute_file_hash(file_path: str) -> str:
    """Compute SHA-256 hash for a file."""
    sha256_hash = hashlib.sha256()
    with open(file_path, "rb") as f:
        for byte_block in iter(lambda: f.read(4096), b""):
            sha256_hash.update(byte_block)
    return sha256_hash.hexdigest()


def compute_local_manifest(dir_path: str) -> Dict[str, Any]:
    """
    Compute local manifest for a directory.

    Args:
        dir_path: Directory to scan

    Returns:
        Dict with files array: [{path, hash, size}, ...]
    """
    files = []
    original_dir = os.getcwd()

    try:
        os.chdir(dir_path)

        for root, dirs, filenames in os.walk("."):
            # Exclude .git and .vas directories
            dirs[:] = [d for d in dirs if d not in (".git", ".vas")]

            for filename in filenames:
                rel_path = os.path.join(root, filename)
                # Remove leading ./
                if rel_path.startswith("./"):
                    rel_path = rel_path[2:]

                full_path = os.path.join(dir_path, rel_path)
                try:
                    file_hash = compute_file_hash(full_path)
                    file_size = os.path.getsize(full_path)
                    files.append({
                        "path": rel_path,
                        "hash": file_hash,
                        "size": file_size
                    })
                except (IOError, OSError) as e:
                    log_warn(f"Could not process file {rel_path}: {e}")

    finally:
        os.chdir(original_dir)

    return {"files": files}


def diff_manifests(
    old_manifest: Dict[str, Any],
    new_manifest: Dict[str, Any]
) -> Dict[str, List[str]]:
    """
    Diff two manifests and output changes.

    Args:
        old_manifest: Base manifest
        new_manifest: Current manifest

    Returns:
        Dict with added, modified, deleted arrays of file paths
    """
    old_files = {f["path"]: f for f in old_manifest.get("files", [])}
    new_files = {f["path"]: f for f in new_manifest.get("files", [])}

    old_paths: Set[str] = set(old_files.keys())
    new_paths: Set[str] = set(new_files.keys())

    added = sorted(list(new_paths - old_paths))
    deleted = sorted(list(old_paths - new_paths))
    modified = []

    for path in sorted(old_paths & new_paths):
        if old_files[path]["hash"] != new_files[path]["hash"]:
            modified.append(path)

    return {
        "added": added,
        "modified": modified,
        "deleted": deleted
    }


def create_incremental_tar(
    mount_path: str,
    tar_path: str,
    changes: Dict[str, List[str]]
) -> bool:
    """
    Create tar.gz of only changed files.

    Args:
        mount_path: Source directory
        tar_path: Destination tar.gz path
        changes: Dict with added and modified file lists

    Returns:
        True on success, False on failure
    """
    original_dir = os.getcwd()

    try:
        os.chdir(mount_path)

        # Get list of files to include
        file_list = changes.get("added", []) + changes.get("modified", [])

        if not file_list:
            # No files to add, create empty tar.gz
            with tarfile.open(tar_path, "w:gz") as tar:
                pass
            return True

        # Create tar.gz from file list
        with tarfile.open(tar_path, "w:gz") as tar:
            for file_path in file_list:
                if os.path.exists(file_path):
                    tar.add(file_path)

        return True

    except Exception as e:
        log_error(f"Failed to create incremental tar: {e}")
        return False

    finally:
        os.chdir(original_dir)


def create_incremental_snapshot(
    mount_path: str,
    storage_name: str,
    vas_storage_name: str,
    base_version_id: str,
    manifest_url: str
) -> Optional[Dict[str, Any]]:
    """
    Main incremental upload function.

    Args:
        mount_path: Path to the storage directory
        storage_name: Display name of the storage
        vas_storage_name: VAS storage name
        base_version_id: Base version ID for diff
        manifest_url: URL to download base manifest

    Returns:
        Dict with versionId on success, None on failure
    """
    log_info(f"Attempting incremental upload for '{storage_name}'")

    # If no base version or manifest URL, fall back to full upload
    if not base_version_id or not manifest_url:
        log_info("No base version, falling back to full upload")
        return create_vas_snapshot(mount_path, storage_name, vas_storage_name)

    temp_dir = tempfile.mkdtemp(prefix=f"incremental-{RUN_ID}-{storage_name}-")

    try:
        # Download base manifest
        log_info("Downloading base manifest...")
        old_manifest_path = os.path.join(temp_dir, "old-manifest.json")

        if not http_download(manifest_url, old_manifest_path):
            log_warn("Failed to download base manifest, falling back to full upload")
            return create_vas_snapshot(mount_path, storage_name, vas_storage_name)

        # Load old manifest
        try:
            with open(old_manifest_path) as f:
                old_manifest = json.load(f)
        except (IOError, json.JSONDecodeError) as e:
            log_warn(f"Failed to parse base manifest: {e}, falling back to full upload")
            return create_vas_snapshot(mount_path, storage_name, vas_storage_name)

        # Compute local manifest
        log_info("Computing local manifest...")
        new_manifest = compute_local_manifest(mount_path)

        # Save new manifest for debugging
        new_manifest_path = os.path.join(temp_dir, "new-manifest.json")
        with open(new_manifest_path, "w") as f:
            json.dump(new_manifest, f)

        # Compute diff
        log_info("Computing diff...")
        changes = diff_manifests(old_manifest, new_manifest)

        added_count = len(changes.get("added", []))
        modified_count = len(changes.get("modified", []))
        deleted_count = len(changes.get("deleted", []))

        log_info(f"Changes: +{added_count} ~{modified_count} -{deleted_count}")

        # If no changes, skip upload
        if added_count == 0 and modified_count == 0 and deleted_count == 0:
            log_info("No changes detected, skipping upload")
            return {"versionId": base_version_id, "unchanged": True}

        # Create tar.gz of changed files
        tar_path = os.path.join(temp_dir, "changes.tar.gz")
        if not create_incremental_tar(mount_path, tar_path, changes):
            log_warn("Failed to create incremental tar, falling back to full upload")
            return create_vas_snapshot(mount_path, storage_name, vas_storage_name)

        # Upload to incremental endpoint
        log_info("Uploading incremental changes...")
        form_fields = {
            "runId": RUN_ID,
            "storageName": vas_storage_name,
            "baseVersion": base_version_id,
            "changes": json.dumps(changes),
            "message": f"Incremental checkpoint from run {RUN_ID}"
        }

        response = http_post_form(
            INCREMENTAL_WEBHOOK_URL,
            form_fields,
            file_path=tar_path,
            file_field="file"
        )

        if response is None:
            log_warn("Incremental upload failed, falling back to full upload")
            return create_vas_snapshot(mount_path, storage_name, vas_storage_name)

        # Check response
        version_id = response.get("versionId")
        if not version_id:
            log_error("Invalid response from incremental upload")
            log_error(f"Response: {response}")
            return None

        # Log incremental stats if available
        stats = response.get("incrementalStats")
        if stats:
            bytes_uploaded = stats.get("bytesUploaded", 0)
            log_info(f"Incremental upload complete: {bytes_uploaded} bytes uploaded")

        log_info(f"Incremental snapshot created: version {version_id}")
        return {"versionId": version_id}

    finally:
        # Cleanup
        shutil.rmtree(temp_dir, ignore_errors=True)
`;
