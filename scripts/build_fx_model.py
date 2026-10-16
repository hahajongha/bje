#!/usr/bin/env python3
"""Fit a private USDKRW snapshot; input and output must remain outside this repo.

Example:
  python scripts/build_fx_model.py --input /private/usdkrw.csv \
    --source 'data_info / DailyRate / USDKRW' --output /private/usdkrw-model.json

CSV columns: date,spot. JSON: {"dates": [...], "spots": [...]} or
{"history": [{"date": "2026-01-02", "spot": 1450.0}, ...]}.
No interpolating, zero-filling, dropping invalid values, or calendar-day returns.
"""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

from fx_markov import build_payload, validate_series


REPO = Path(__file__).resolve().parents[1]


def private_path(value):
    path = Path(value).expanduser().resolve()
    if path == REPO or REPO in path.parents:
        raise ValueError("Raw data and generated market snapshots must remain outside the public repository")
    return path


def read_input(path):
    if path.suffix.lower() == ".csv":
        with path.open(encoding="utf-8-sig", newline="") as handle:
            rows = list(csv.DictReader(handle))
        return validate_series([row["date"] for row in rows], [row["spot"] for row in rows])
    content = json.loads(path.read_text(encoding="utf-8"))
    if "history" in content:
        rows = content["history"]
        return validate_series([row["date"] for row in rows], [row["spot"] for row in rows])
    return validate_series(content["dates"], content["spots"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--start", default="2015-01-01")
    parser.add_argument("--as-of", help="Exclude later observations explicitly")
    parser.add_argument("--horizon", type=int, default=504)
    parser.add_argument("--paths", type=int, default=40000)
    parser.add_argument("--starts", type=int, default=6)
    parser.add_argument("--max-iter", type=int, default=400)
    parser.add_argument("--seed", type=int, default=20261016)
    parser.add_argument("--holdout", type=int, default=252, help="Trailing one-step holdout observations; 0 disables validation")
    args = parser.parse_args()
    source_path, target = private_path(args.input), private_path(args.output)
    dates, spots = read_input(source_path)
    selected = [j for j, day in enumerate(dates) if day >= args.start and (not args.as_of or day <= args.as_of)]
    if not selected:
        raise ValueError("No observations in the selected date range")
    payload = build_payload(
        [dates[j] for j in selected], [spots[j] for j in selected], source=args.source,
        horizon=args.horizon, paths=args.paths, seed=args.seed, starts=args.starts, max_iter=args.max_iter, holdout=args.holdout,
    )
    if source_path.suffix.lower() != ".csv":
        supplied = json.loads(source_path.read_text(encoding="utf-8"))
        for key in ("provenance", "sourceComparison"):
            if key in supplied:
                payload["meta"][key] = supplied[key]
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(target), "meta": payload["meta"],
                      "regimes": payload["model"]["regimes"],
                      "diagnostics": payload["model"]["diagnostics"],
                      "momentCheck": payload["validation"]["momentCheck"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
