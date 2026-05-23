"""Tests for mitm addon configuration hooks."""

from pathlib import Path
from unittest.mock import MagicMock, patch

import mitm_addon
import usage


class TestAddonConfiguration:
    def test_load_registers_usage_state_id_without_pending_write(self):
        loader = MagicMock()

        with patch.object(usage, "set_pending_path") as set_pending_path:
            mitm_addon.load(loader)

        option_names = [call.kwargs["name"] for call in loader.add_option.call_args_list]
        assert "vm0_usage_state_id" in option_names
        set_pending_path.assert_not_called()

    def test_configure_initializes_pending_path_with_usage_state_id(self):
        options = MagicMock(vm0_usage_state_id="runner-usage-state-id")
        pending_path = str(Path(mitm_addon.__file__).resolve().parent / "usage-pending")

        with (
            patch.object(mitm_addon.ctx, "options", options, create=True),
            patch.object(usage, "set_pending_path") as set_pending_path,
        ):
            mitm_addon.configure({"vm0_usage_state_id"})

        set_pending_path.assert_called_once_with(
            pending_path, usage_state_id="runner-usage-state-id"
        )

    def test_configure_passes_none_when_usage_state_id_is_empty(self):
        options = MagicMock(vm0_usage_state_id="")
        pending_path = str(Path(mitm_addon.__file__).resolve().parent / "usage-pending")

        with (
            patch.object(mitm_addon.ctx, "options", options, create=True),
            patch.object(usage, "set_pending_path") as set_pending_path,
        ):
            mitm_addon.configure({"vm0_usage_state_id"})

        set_pending_path.assert_called_once_with(pending_path, usage_state_id=None)

    def test_configure_ignores_unrelated_option_updates(self):
        options = MagicMock(vm0_usage_state_id="runner-usage-state-id")

        with (
            patch.object(mitm_addon.ctx, "options", options, create=True),
            patch.object(usage, "set_pending_path") as set_pending_path,
        ):
            mitm_addon.configure({"vm0_api_url"})

        set_pending_path.assert_not_called()
