#!/usr/bin/env python3
"""Run the mitm-addon flow metadata key linter."""

from __future__ import annotations

import sys

from flow_metadata_key_linter import main

if __name__ == "__main__":
    sys.exit(main())
