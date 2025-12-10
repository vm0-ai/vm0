/**
 * VAS (Versioned Artifact Storage) snapshot script (Python)
 * Creates snapshots by uploading storage contents to the storage webhook API
 */
export const VAS_SNAPSHOT_SCRIPT = `#!/usr/bin/env python3
"""
VAS (Versioned Artifact Storage) snapshot module.
Creates snapshots by uploading storage contents to the storage webhook API.
"""
import os
import tarfile
import tempfile
import shutil
from typing import Optional, Dict, Any

from common import RUN_ID, STORAGE_WEBHOOK_URL
from log import log_info, log_error, log_debug
from http_client import http_post_form


def create_vas_snapshot(
    mount_path: str,
    storage_name: str,
    vas_storage_name: str,
    storage_type: str = "artifact"
) -> Optional[Dict[str, Any]]:
    """
    Create VAS snapshot for a storage.
    Creates a tar.gz of the storage contents and uploads to the storage webhook API.

    Args:
        mount_path: Path to the storage directory
        storage_name: Display name of the storage
        vas_storage_name: VAS storage name
        storage_type: Storage type ("volume" or "artifact"), defaults to "artifact"

    Returns:
        Dict with versionId on success, None on failure
    """
    log_info(f"Creating VAS snapshot for storage '{storage_name}' ({vas_storage_name}, type: {storage_type}) at {mount_path}")
    log_debug(f"STORAGE_WEBHOOK_URL: {STORAGE_WEBHOOK_URL}")
    log_debug(f"RUN_ID: {RUN_ID}")

    # Create temp directory for tar.gz
    tar_dir = tempfile.mkdtemp(prefix=f"vas-snapshot-{RUN_ID}-{storage_name}-")
    tar_path = os.path.join(tar_dir, "storage.tar.gz")

    try:
        # Change to mount path
        original_dir = os.getcwd()
        try:
            os.chdir(mount_path)
        except OSError as e:
            log_error(f"Failed to cd to {mount_path}: {e}")
            return None

        # Create tar.gz file (exclude .git and .vas directories)
        try:
            with tarfile.open(tar_path, "w:gz") as tar:
                for item in os.listdir("."):
                    if item in (".git", ".vas"):
                        continue
                    tar.add(item)
            log_info(f"Created tar.gz file for storage '{storage_name}'")
        except Exception as e:
            log_error(f"Failed to create tar.gz for storage '{storage_name}': {e}")
            os.chdir(original_dir)
            return None
        finally:
            os.chdir(original_dir)

        # Upload to storage webhook API
        form_fields = {
            "runId": RUN_ID,
            "storageName": vas_storage_name,
            "storageType": storage_type,
            "message": f"Checkpoint from run {RUN_ID}"
        }

        response = http_post_form(
            STORAGE_WEBHOOK_URL,
            form_fields,
            file_path=tar_path,
            file_field="file"
        )

        if response is None:
            log_error(f"Failed to upload snapshot for storage '{storage_name}'")
            return None

        # Check if response contains versionId
        version_id = response.get("versionId")
        if not version_id:
            log_error(f"Failed to create VAS snapshot for '{storage_name}'")
            log_error(f"Webhook URL: {STORAGE_WEBHOOK_URL}")
            log_error(f"Response: {response}")
            return None

        log_info(f"VAS snapshot created for '{storage_name}': version {version_id}")
        return {"versionId": version_id}

    finally:
        # Cleanup temp files
        shutil.rmtree(tar_dir, ignore_errors=True)
`;
