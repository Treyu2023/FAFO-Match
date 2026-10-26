"""When the toolbox servers are allowed to stay up.

S1 (toolbox Python) runs only while the toolbox is actually open.
S2 (tagger) runs while Chrome is open or the toolbox is open.
Both stop once Chrome is closed and the toolbox is closed.
A failed Chrome check does not kill the tagger.
"""

from __future__ import annotations

S1_TTL_SEC = 180.0
S2_TTL_SEC = 180.0


def decide(
    *,
    chrome: bool | None,
    toolbox_active: bool,
    s1_sleeping: bool,
    s2_sleeping: bool,
    s1_demand_age: float | None,
    s2_demand_age: float | None,
) -> tuple[bool, bool]:
    toolbox_live = bool(toolbox_active) or (
        s1_demand_age is not None and s1_demand_age <= S1_TTL_SEC
    )
    recent_tag = s2_demand_age is not None and s2_demand_age <= S2_TTL_SEC
    if chrome is None:
        tagger_live = True
    else:
        tagger_live = bool(chrome) or toolbox_live or recent_tag
    want_s1 = (not s1_sleeping) and toolbox_live
    want_s2 = (not s2_sleeping) and tagger_live
    return want_s1, want_s2
