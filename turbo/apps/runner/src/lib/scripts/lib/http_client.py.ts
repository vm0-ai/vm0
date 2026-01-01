/**
 * Unified HTTP request functions for agent scripts (Python)
 * Provides urllib wrapper with retry logic and Vercel bypass support
 */
export const HTTP_SCRIPT = `#!/usr/bin/env python3
"""
Unified HTTP request functions for VM0 agent scripts.
Uses urllib (standard library) with retry logic.
"""
import json
import time
import subprocess
import os
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from typing import Optional, Dict, Any

from common import (
    API_TOKEN, VERCEL_BYPASS,
    HTTP_CONNECT_TIMEOUT, HTTP_MAX_TIME, HTTP_MAX_TIME_UPLOAD, HTTP_MAX_RETRIES
)
from log import log_debug, log_warn, log_error


def http_post_json(
    url: str,
    data: Dict[str, Any],
    max_retries: int = HTTP_MAX_RETRIES
) -> Optional[Dict[str, Any]]:
    """
    HTTP POST with JSON body and retry logic.

    Args:
        url: Target URL
        data: Dictionary to send as JSON
        max_retries: Maximum retry attempts

    Returns:
        Response JSON as dict on success, None on failure
    """
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {API_TOKEN}",
    }
    if VERCEL_BYPASS:
        headers["x-vercel-protection-bypass"] = VERCEL_BYPASS

    body = json.dumps(data).encode("utf-8")

    for attempt in range(1, max_retries + 1):
        log_debug(f"HTTP POST attempt {attempt}/{max_retries} to {url}")
        try:
            req = Request(url, data=body, headers=headers, method="POST")
            with urlopen(req, timeout=HTTP_MAX_TIME) as resp:
                response_body = resp.read().decode("utf-8")
                if response_body:
                    return json.loads(response_body)
                return {}
        except HTTPError as e:
            log_warn(f"HTTP POST failed (attempt {attempt}/{max_retries}): HTTP {e.code}")
            if attempt < max_retries:
                time.sleep(1)
        except URLError as e:
            log_warn(f"HTTP POST failed (attempt {attempt}/{max_retries}): {e.reason}")
            if attempt < max_retries:
                time.sleep(1)
        except TimeoutError:
            log_warn(f"HTTP POST failed (attempt {attempt}/{max_retries}): Timeout")
            if attempt < max_retries:
                time.sleep(1)
        except Exception as e:
            log_warn(f"HTTP POST failed (attempt {attempt}/{max_retries}): {e}")
            if attempt < max_retries:
                time.sleep(1)

    log_error(f"HTTP POST failed after {max_retries} attempts to {url}")
    return None


def http_post_form(
    url: str,
    form_fields: Dict[str, str],
    file_path: Optional[str] = None,
    file_field: str = "file",
    max_retries: int = HTTP_MAX_RETRIES
) -> Optional[Dict[str, Any]]:
    """
    HTTP POST with multipart form data and retry logic.
    Uses curl for multipart uploads as urllib doesn't support it well.

    Args:
        url: Target URL
        form_fields: Dictionary of form field name -> value
        file_path: Optional path to file to upload
        file_field: Form field name for the file
        max_retries: Maximum retry attempts

    Returns:
        Response JSON as dict on success, None on failure
    """
    for attempt in range(1, max_retries + 1):
        log_debug(f"HTTP POST form attempt {attempt}/{max_retries} to {url}")

        # Build curl command
        # -f flag makes curl return non-zero exit code on HTTP 4xx/5xx errors
        curl_cmd = [
            "curl", "-f", "-X", "POST", url,
            "-H", f"Authorization: Bearer {API_TOKEN}",
            "--connect-timeout", str(HTTP_CONNECT_TIMEOUT),
            "--max-time", str(HTTP_MAX_TIME_UPLOAD),
            "--silent"
        ]

        if VERCEL_BYPASS:
            curl_cmd.extend(["-H", f"x-vercel-protection-bypass: {VERCEL_BYPASS}"])

        # Add form fields
        for key, value in form_fields.items():
            curl_cmd.extend(["-F", f"{key}={value}"])

        # Add file if provided
        if file_path:
            curl_cmd.extend(["-F", f"{file_field}=@{file_path}"])

        result = None  # Initialize for use in except blocks
        try:
            result = subprocess.run(
                curl_cmd,
                capture_output=True,
                text=True,
                timeout=HTTP_MAX_TIME_UPLOAD
            )

            if result.returncode == 0:
                if result.stdout:
                    return json.loads(result.stdout)
                return {}

            # Log curl exit code and stderr for better debugging
            error_msg = f"curl exit {result.returncode}"
            if result.stderr:
                error_msg += f": {result.stderr.strip()}"
            log_warn(f"HTTP POST form failed (attempt {attempt}/{max_retries}): {error_msg}")
            if attempt < max_retries:
                time.sleep(1)

        except subprocess.TimeoutExpired:
            log_warn(f"HTTP POST form failed (attempt {attempt}/{max_retries}): Timeout")
            if attempt < max_retries:
                time.sleep(1)
        except json.JSONDecodeError as e:
            log_warn(f"HTTP POST form failed (attempt {attempt}/{max_retries}): Invalid JSON response: {e}")
            # Log raw response for debugging (truncate to avoid log spam)
            if result and result.stdout:
                log_debug(f"Raw response: {result.stdout[:500]}")
            if attempt < max_retries:
                time.sleep(1)
        except Exception as e:
            log_warn(f"HTTP POST form failed (attempt {attempt}/{max_retries}): {e}")
            if attempt < max_retries:
                time.sleep(1)

    log_error(f"HTTP POST form failed after {max_retries} attempts to {url}")
    return None


def http_put_presigned(
    presigned_url: str,
    file_path: str,
    content_type: str = "application/octet-stream",
    max_retries: int = HTTP_MAX_RETRIES
) -> bool:
    """
    HTTP PUT to a presigned S3 URL with retry logic.
    Used for direct S3 uploads bypassing Vercel's 4.5MB limit.

    Args:
        presigned_url: S3 presigned PUT URL
        file_path: Path to file to upload
        content_type: Content-Type header value
        max_retries: Maximum retry attempts

    Returns:
        True on success, False on failure
    """
    for attempt in range(1, max_retries + 1):
        log_debug(f"HTTP PUT presigned attempt {attempt}/{max_retries}")

        try:
            # Use curl for reliable large file uploads
            curl_cmd = [
                "curl", "-f", "-X", "PUT",
                "-H", f"Content-Type: {content_type}",
                "--data-binary", f"@{file_path}",
                "--connect-timeout", str(HTTP_CONNECT_TIMEOUT),
                "--max-time", str(HTTP_MAX_TIME_UPLOAD),
                "--silent",
                presigned_url
            ]

            result = subprocess.run(
                curl_cmd,
                capture_output=True,
                text=True,
                timeout=HTTP_MAX_TIME_UPLOAD
            )

            if result.returncode == 0:
                return True

            error_msg = f"curl exit {result.returncode}"
            if result.stderr:
                error_msg += f": {result.stderr.strip()}"
            log_warn(f"HTTP PUT presigned failed (attempt {attempt}/{max_retries}): {error_msg}")
            if attempt < max_retries:
                time.sleep(1)

        except subprocess.TimeoutExpired:
            log_warn(f"HTTP PUT presigned failed (attempt {attempt}/{max_retries}): Timeout")
            if attempt < max_retries:
                time.sleep(1)
        except Exception as e:
            log_warn(f"HTTP PUT presigned failed (attempt {attempt}/{max_retries}): {e}")
            if attempt < max_retries:
                time.sleep(1)

    log_error(f"HTTP PUT presigned failed after {max_retries} attempts")
    return False


def http_download(
    url: str,
    dest_path: str,
    max_retries: int = HTTP_MAX_RETRIES
) -> bool:
    """
    Download a file from URL with retry logic.

    Args:
        url: Source URL
        dest_path: Destination file path
        max_retries: Maximum retry attempts

    Returns:
        True on success, False on failure
    """
    for attempt in range(1, max_retries + 1):
        log_debug(f"HTTP download attempt {attempt}/{max_retries} from {url}")

        try:
            curl_cmd = [
                "curl", "-fsSL",
                "-o", dest_path,
                url
            ]

            result = subprocess.run(
                curl_cmd,
                capture_output=True,
                timeout=HTTP_MAX_TIME_UPLOAD
            )

            if result.returncode == 0:
                return True

            log_warn(f"HTTP download failed (attempt {attempt}/{max_retries}): curl exit {result.returncode}")
            if attempt < max_retries:
                time.sleep(1)

        except subprocess.TimeoutExpired:
            log_warn(f"HTTP download failed (attempt {attempt}/{max_retries}): Timeout")
            if attempt < max_retries:
                time.sleep(1)
        except Exception as e:
            log_warn(f"HTTP download failed (attempt {attempt}/{max_retries}): {e}")
            if attempt < max_retries:
                time.sleep(1)

    log_error(f"HTTP download failed after {max_retries} attempts from {url}")
    return False
`;
