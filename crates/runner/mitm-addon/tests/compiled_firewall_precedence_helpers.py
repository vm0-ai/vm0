"""Shared fixtures for compiled firewall precedence tests."""

from tests.firewall_helpers import firewall_api, firewall_entry, firewall_permission

BROAD_BASE = "https://api.example.com"
ADMIN_BASE = "https://api.example.com/admin"
ADMIN_DELETE_URL = "https://api.example.com/admin/delete"


def broad_firewall(*, base=BROAD_BASE):
    return firewall_entry(
        "broad",
        firewall_api(
            base,
            [firewall_permission("broad", "ANY /{path+}")],
            auth_label="broad",
        ),
    )
