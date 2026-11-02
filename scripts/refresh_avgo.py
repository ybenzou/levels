#!/usr/bin/env python3
"""Weekday Levels refresh entrypoint.

Wraps pipeline/build.py so scheduled / agent runs have a stable path:

    python3 scripts/refresh_avgo.py
    python3 scripts/refresh_avgo.py --cache   # reuse pipeline/.cache (<12h)

Rebuilds AVGO + SKHY + CRWV (and the training universe), writes:
  data/<SYMBOL>.json, data/index.json, data.json, fallback-data.js

Descriptive levels / backtests / model cards only — not trading advice.
"""
from __future__ import annotations

import os
import runpy
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "pipeline", "build.py")


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    # Forward flags (--cache) to build.py via sys.argv shape it expects.
    sys.argv = [BUILD, *argv]
    os.chdir(ROOT)
    if ROOT not in sys.path:
        sys.path.insert(0, ROOT)
    runpy.run_path(BUILD, run_name="__main__")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
