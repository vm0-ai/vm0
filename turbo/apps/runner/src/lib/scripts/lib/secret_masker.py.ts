/**
 * Secret masking module for sandbox-side event masking (Python)
 *
 * This module masks secrets before events are sent to the server.
 * It reads base64-encoded secret values from VM0_SECRET_VALUES env var.
 */
export const SECRET_MASKER_SCRIPT = `#!/usr/bin/env python3
"""
Secret masking module for VM0 sandbox.

Masks secrets in event data before sending to server.
Similar to GitHub Actions secret masking.
"""
import os
import base64
from urllib.parse import quote as url_encode
from typing import Any, Set, List, Optional

# Placeholder for masked secrets
MASK_PLACEHOLDER = "***"

# Minimum length for secrets (avoid false positives on short strings)
MIN_SECRET_LENGTH = 5

# Global masker instance (initialized lazily)
_masker: Optional["SecretMasker"] = None


class SecretMasker:
    """
    Masks secret values in data structures.
    Pre-computes encoding variants for efficient matching.
    """

    def __init__(self, secret_values: List[str]):
        """
        Initialize masker with secret values.

        Args:
            secret_values: List of secret values to mask
        """
        self.patterns: Set[str] = set()

        for secret in secret_values:
            if not secret or len(secret) < MIN_SECRET_LENGTH:
                continue

            # Original value
            self.patterns.add(secret)

            # Base64 encoded
            try:
                b64 = base64.b64encode(secret.encode()).decode()
                if len(b64) >= MIN_SECRET_LENGTH:
                    self.patterns.add(b64)
            except Exception:
                pass

            # URL encoded (only if different from original)
            try:
                url_enc = url_encode(secret, safe="")
                if url_enc != secret and len(url_enc) >= MIN_SECRET_LENGTH:
                    self.patterns.add(url_enc)
            except Exception:
                pass

    def mask(self, data: Any) -> Any:
        """
        Recursively mask all occurrences of secrets in the data.

        Args:
            data: Data to mask (string, list, dict, or primitive)

        Returns:
            Masked data with the same structure
        """
        return self._deep_mask(data)

    def _deep_mask(self, data: Any) -> Any:
        """Recursively mask data."""
        if isinstance(data, str):
            result = data
            for pattern in self.patterns:
                # Use split/join for global replacement
                result = result.replace(pattern, MASK_PLACEHOLDER)
            return result

        if isinstance(data, list):
            return [self._deep_mask(item) for item in data]

        if isinstance(data, dict):
            return {key: self._deep_mask(value) for key, value in data.items()}

        # Primitives (int, float, bool, None) pass through unchanged
        return data


def get_masker() -> SecretMasker:
    """
    Get the global masker instance.
    Initializes on first call using VM0_SECRET_VALUES env var.

    Returns:
        SecretMasker instance
    """
    global _masker

    if _masker is None:
        _masker = _create_masker()

    return _masker


def _create_masker() -> SecretMasker:
    """
    Create a masker from VM0_SECRET_VALUES env var.

    VM0_SECRET_VALUES contains comma-separated base64-encoded secret values.
    This avoids exposing plaintext secrets in environment variable names.
    """
    secret_values_str = os.environ.get("VM0_SECRET_VALUES", "")

    if not secret_values_str:
        # No secrets to mask
        return SecretMasker([])

    # Parse base64-encoded values
    secret_values = []
    for encoded_value in secret_values_str.split(","):
        encoded_value = encoded_value.strip()
        if encoded_value:
            try:
                decoded = base64.b64decode(encoded_value).decode()
                if decoded:
                    secret_values.append(decoded)
            except Exception:
                # Skip invalid base64 values
                pass

    return SecretMasker(secret_values)


def mask_data(data: Any) -> Any:
    """
    Convenience function to mask data using global masker.

    Args:
        data: Data to mask

    Returns:
        Masked data
    """
    return get_masker().mask(data)
`;
