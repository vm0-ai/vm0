#!/usr/bin/env python3
"""Update the generated IANA TLD data used by X billing URL detection."""

from __future__ import annotations

import sys

from update_x_tlds import main

if __name__ == "__main__":
    sys.exit(main())
