from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType

import pytest


def _load_script() -> ModuleType:
    addon_root = Path(__file__).resolve().parents[1]
    script = addon_root / "scripts" / "update-x-tlds.py"
    spec = importlib.util.spec_from_file_location("update_x_tlds", script)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_parse_source_normalizes_sorts_and_deduplicates_tlds():
    module = _load_script()

    version, tlds = module.parse_source(
        "# Version 2026010100, Last Updated Wed Jan  1 00:00:00 2026 UTC\nORG\nCOM\ncom\nNET\n"
    )

    assert version == "2026010100"
    assert tlds == ("com", "net", "org")


def test_parse_source_rejects_empty_source():
    module = _load_script()

    with pytest.raises(ValueError, match="empty"):
        module.parse_source("")


def test_parse_source_rejects_missing_version_header():
    module = _load_script()

    with pytest.raises(ValueError, match="version header"):
        module.parse_source("COM\nORG\n")


def test_parse_source_rejects_non_ascii_tld():
    module = _load_script()

    with pytest.raises(ValueError, match="not ASCII"):
        module.parse_source("# Version 1, Last Updated x\nCAFÉ\n")


@pytest.mark.parametrize("bad_tld", ["foo bar", "-foo", "foo-", "foo.bar"])
def test_parse_source_rejects_invalid_tld_syntax(bad_tld):
    module = _load_script()

    with pytest.raises(ValueError, match="invalid syntax"):
        module.parse_source(f"# Version 1, Last Updated x\n{bad_tld}\n")


def test_parse_source_rejects_source_without_tld_entries():
    module = _load_script()

    with pytest.raises(ValueError, match="no TLD entries"):
        module.parse_source("# Version 1, Last Updated x\n# only comments\n   \n")


def test_update_generated_reads_source_file_and_writes_rendered_module(tmp_path, monkeypatch):
    module = _load_script()
    source = tmp_path / "tlds.txt"
    source.write_text(
        "# Version 1, Last Updated x\nCOM\nORG\n",
        encoding="utf-8",
    )
    output = tmp_path / "x_tlds.py"
    monkeypatch.setattr(module, "OUTPUT_PATH", output)

    assert module.update_generated(source) == 0

    rendered = output.read_text(encoding="utf-8")
    assert 'IANA_TLD_VERSION = "1"' in rendered
    assert '        "com",' in rendered
    assert '        "org",' in rendered


def test_update_generated_rejects_malformed_source_without_replacing_output(tmp_path, monkeypatch):
    module = _load_script()
    source = tmp_path / "tlds.txt"
    source.write_text("COM\nORG\n", encoding="utf-8")
    output = tmp_path / "x_tlds.py"
    original = "# existing generated snapshot\n"
    output.write_text(original, encoding="utf-8")
    monkeypatch.setattr(module, "OUTPUT_PATH", output)

    with pytest.raises(ValueError, match="version header"):
        module.update_generated(source)

    assert output.read_text(encoding="utf-8") == original
