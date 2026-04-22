"""Runtime guard: vendored packages must resolve to *this* addon tree.

Call :func:`verify` from ``mitm_addon.py`` top-level.

mitmdump's ``load_script`` (``mitmproxy/addons/script.py:load_script``)
prepends the addon's directory to ``sys.path`` before ``exec_module`` and
restores it after, so any ``import <pkg>`` reached while the addon is
being loaded resolves against our tree first.  :func:`verify` runs during
that window and freezes the verdict in ``sys.modules``.

What we guard against: a future mitmdump release starts bundling a
package we also vendor (today: ``ijson``).  At the moment we ship
mitmdump 12.2.1 which does not, but transitive-dep drift between
releases is silent — if upstream adds one, this assertion is the only
thing that turns it from "silently wrong version billing images" into
"mitmdump refuses to start with a loud error in stderr".

If this ever fires, the fix is one of:
  * If the upstream copy is compatible: delete ``src/ijson/`` and let
    the bundled version win — the point of vendoring is gone.
  * If we need to stay on our pin: explicitly reorder ``sys.path`` to
    keep ``addon_dir`` ahead of site-packages, or rename our vendored
    package (``_vendored_ijson/``) with import rewriting.  At that
    point the simplicity argument is lost; revisit the trade-off.
"""

from pathlib import Path
from types import ModuleType

import ijson

_ADDON_DIR = Path(__file__).resolve().parent


def _verify(module: ModuleType, expected_parent: Path) -> None:
    loaded_dir = Path(module.__file__).resolve().parent
    if loaded_dir.parent != expected_parent:
        raise RuntimeError(
            f"vendored {module.__name__} shadowed: expected to load from "
            f"{expected_parent}/{module.__name__}/, got {loaded_dir}. "
            f"Something on sys.path is ahead of the addon directory — see "
            f"{__file__} for the recovery playbook."
        )


def verify() -> None:
    """Assert every vendored package loaded above this call resolves to the
    addon source tree.  Raises :class:`RuntimeError` on mismatch — intended
    to run during ``mitm_addon.py``'s top-level import phase so mitmdump
    aborts loudly instead of silently using a shadowing copy.
    """
    _verify(ijson, _ADDON_DIR)
