/**
 * Direct S3 upload module for VAS (Versioned Artifact Storage) (Python)
 * Bypasses Vercel's 4.5MB request body limit by uploading directly to S3
 * using presigned URLs from the /api/storages/prepare endpoint
 */
export const DIRECT_UPLOAD_SCRIPT = `#!/usr/bin/env python3
"""
Direct S3 upload module for VAS (Versioned Artifact Storage).
Bypasses Vercel's 4.5MB request body limit by uploading directly to S3.

Flow:
1. Compute file hashes locally
2. Call /api/storages/prepare to get presigned URLs
3. Upload archive and manifest directly to S3
4. Call /api/storages/commit to finalize
"""
import os
import json
import hashlib
import tarfile
import tempfile
import shutil
import time
from typing import Optional, Dict, Any, List
from datetime import datetime

from common import RUN_ID, STORAGE_PREPARE_URL, STORAGE_COMMIT_URL, record_sandbox_op
from log import log_info, log_warn, log_error, log_debug
from http_client import http_post_json, http_put_presigned


def compute_file_hash(file_path: str) -> str:
    """Compute SHA-256 hash for a file."""
    sha256_hash = hashlib.sha256()
    with open(file_path, "rb") as f:
        for byte_block in iter(lambda: f.read(4096), b""):
            sha256_hash.update(byte_block)
    return sha256_hash.hexdigest()


def collect_file_metadata(dir_path: str) -> List[Dict[str, Any]]:
    """
    Collect file metadata with hashes for a directory.

    Args:
        dir_path: Directory to scan

    Returns:
        List of file entries: [{path, hash, size}, ...]
    """
    files = []
    original_dir = os.getcwd()

    try:
        os.chdir(dir_path)

        for root, dirs, filenames in os.walk("."):
            # Exclude .git and .vm0 directories
            dirs[:] = [d for d in dirs if d not in (".git", ".vm0")]

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

    return files


def create_archive(dir_path: str, tar_path: str) -> bool:
    """
    Create tar.gz archive of directory contents.

    Args:
        dir_path: Source directory
        tar_path: Destination tar.gz path

    Returns:
        True on success, False on failure
    """
    original_dir = os.getcwd()

    try:
        os.chdir(dir_path)

        # Get files to archive (exclude .git and .vm0)
        items = [item for item in os.listdir(".") if item not in (".git", ".vm0")]

        with tarfile.open(tar_path, "w:gz") as tar:
            for item in items:
                tar.add(item)

        return True

    except Exception as e:
        log_error(f"Failed to create archive: {e}")
        return False

    finally:
        os.chdir(original_dir)


def create_manifest(files: List[Dict[str, Any]], manifest_path: str) -> bool:
    """
    Create manifest JSON file.

    Args:
        files: List of file entries
        manifest_path: Destination path for manifest

    Returns:
        True on success, False on failure
    """
    try:
        manifest = {
            "version": 1,
            "files": files,
            "createdAt": datetime.utcnow().isoformat() + "Z"
        }
        with open(manifest_path, "w") as f:
            json.dump(manifest, f, indent=2)
        return True
    except Exception as e:
        log_error(f"Failed to create manifest: {e}")
        return False


def create_direct_upload_snapshot(
    mount_path: str,
    storage_name: str,
    storage_type: str = "artifact",
    run_id: str = None,
    message: str = None
) -> Optional[Dict[str, Any]]:
    """
    Create VAS snapshot using direct S3 upload.
    Bypasses Vercel's 4.5MB request body limit.

    Args:
        mount_path: Path to the storage directory
        storage_name: VAS storage name
        storage_type: Storage type ("volume" or "artifact")
        run_id: Optional run ID for sandbox auth
        message: Optional commit message

    Returns:
        Dict with versionId on success, None on failure
    """
    log_info(f"Creating direct upload snapshot for '{storage_name}' (type: {storage_type})")

    # Step 1: Collect file metadata
    log_info("Computing file hashes...")
    hash_start = time.time()
    files = collect_file_metadata(mount_path)
    record_sandbox_op("artifact_hash_compute", int((time.time() - hash_start) * 1000), True)
    log_info(f"Found {len(files)} files")

    if not files:
        log_info("No files to upload, creating empty version")

    # Step 2: Call prepare endpoint
    log_info("Calling prepare endpoint...")
    prepare_start = time.time()
    prepare_payload = {
        "storageName": storage_name,
        "storageType": storage_type,
        "files": files
    }
    if run_id:
        prepare_payload["runId"] = run_id

    prepare_response = http_post_json(STORAGE_PREPARE_URL, prepare_payload)
    if not prepare_response:
        log_error("Failed to call prepare endpoint")
        record_sandbox_op("artifact_prepare_api", int((time.time() - prepare_start) * 1000), False)
        return None

    version_id = prepare_response.get("versionId")
    if not version_id:
        log_error(f"Invalid prepare response: {prepare_response}")
        record_sandbox_op("artifact_prepare_api", int((time.time() - prepare_start) * 1000), False)
        return None
    record_sandbox_op("artifact_prepare_api", int((time.time() - prepare_start) * 1000), True)

    # Step 3: Check if version already exists (deduplication)
    # Still call commit to update HEAD pointer (fixes #649)
    if prepare_response.get("existing"):
        log_info(f"Version already exists (deduplicated): {version_id[:8]}")
        log_info("Updating HEAD pointer...")

        commit_payload = {
            "storageName": storage_name,
            "storageType": storage_type,
            "versionId": version_id,
            "files": files
        }
        if run_id:
            commit_payload["runId"] = run_id

        commit_response = http_post_json(STORAGE_COMMIT_URL, commit_payload)
        if not commit_response or not commit_response.get("success"):
            log_error(f"Failed to update HEAD: {commit_response}")
            return None

        return {"versionId": version_id, "deduplicated": True}

    # Step 4: Get presigned URLs
    uploads = prepare_response.get("uploads")
    if not uploads:
        log_error("No upload URLs in prepare response")
        return None

    archive_info = uploads.get("archive")
    manifest_info = uploads.get("manifest")

    if not archive_info or not manifest_info:
        log_error("Missing archive or manifest upload info")
        return None

    # Step 5: Create and upload files
    temp_dir = tempfile.mkdtemp(prefix=f"direct-upload-{storage_name}-")

    try:
        # Create archive
        log_info("Creating archive...")
        archive_start = time.time()
        archive_path = os.path.join(temp_dir, "archive.tar.gz")
        if not create_archive(mount_path, archive_path):
            log_error("Failed to create archive")
            record_sandbox_op("artifact_archive_create", int((time.time() - archive_start) * 1000), False)
            return None
        record_sandbox_op("artifact_archive_create", int((time.time() - archive_start) * 1000), True)

        # Create manifest
        log_info("Creating manifest...")
        manifest_path = os.path.join(temp_dir, "manifest.json")
        if not create_manifest(files, manifest_path):
            log_error("Failed to create manifest")
            return None

        # Upload archive to S3
        log_info("Uploading archive to S3...")
        s3_upload_start = time.time()
        if not http_put_presigned(
            archive_info["presignedUrl"],
            archive_path,
            "application/gzip"
        ):
            log_error("Failed to upload archive to S3")
            record_sandbox_op("artifact_s3_upload", int((time.time() - s3_upload_start) * 1000), False)
            return None

        # Upload manifest to S3
        log_info("Uploading manifest to S3...")
        if not http_put_presigned(
            manifest_info["presignedUrl"],
            manifest_path,
            "application/json"
        ):
            log_error("Failed to upload manifest to S3")
            record_sandbox_op("artifact_s3_upload", int((time.time() - s3_upload_start) * 1000), False)
            return None
        record_sandbox_op("artifact_s3_upload", int((time.time() - s3_upload_start) * 1000), True)

        # Step 6: Call commit endpoint
        log_info("Calling commit endpoint...")
        commit_start = time.time()
        commit_payload = {
            "storageName": storage_name,
            "storageType": storage_type,
            "versionId": version_id,
            "files": files
        }
        if run_id:
            commit_payload["runId"] = run_id
        if message:
            commit_payload["message"] = message

        commit_response = http_post_json(STORAGE_COMMIT_URL, commit_payload)
        if not commit_response:
            log_error("Failed to call commit endpoint")
            record_sandbox_op("artifact_commit_api", int((time.time() - commit_start) * 1000), False)
            return None

        if not commit_response.get("success"):
            log_error(f"Commit failed: {commit_response}")
            record_sandbox_op("artifact_commit_api", int((time.time() - commit_start) * 1000), False)
            return None
        record_sandbox_op("artifact_commit_api", int((time.time() - commit_start) * 1000), True)

        log_info(f"Direct upload snapshot created: {version_id[:8]}")
        return {"versionId": version_id}

    finally:
        # Cleanup temp files
        shutil.rmtree(temp_dir, ignore_errors=True)
`;
