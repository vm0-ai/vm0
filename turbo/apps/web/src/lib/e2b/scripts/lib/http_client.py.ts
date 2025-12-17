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
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from typing import Optional, Dict, Any

from common import (
    API_TOKEN, VERCEL_BYPASS,
    HTTP_CONNECT_TIMEOUT, HTTP_MAX_TIME, HTTP_MAX_TIME_UPLOAD, HTTP_MAX_RETRIES
)


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
        try:
            req = Request(url, data=body, headers=headers, method="POST")
            with urlopen(req, timeout=HTTP_MAX_TIME) as resp:
                response_body = resp.read().decode("utf-8")
                if response_body:
                    return json.loads(response_body)
                return {}
        except (HTTPError, URLError, TimeoutError, Exception):
            if attempt < max_retries:
                time.sleep(1)

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
        # Build curl command
        curl_cmd = [
            "curl", "-X", "POST", url,
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

            if attempt < max_retries:
                time.sleep(1)

        except (subprocess.TimeoutExpired, json.JSONDecodeError, Exception):
            if attempt < max_retries:
                time.sleep(1)

    return None


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

            if attempt < max_retries:
                time.sleep(1)

        except (subprocess.TimeoutExpired, Exception):
            if attempt < max_retries:
                time.sleep(1)

    return False
`;
