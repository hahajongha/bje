#!/usr/bin/env python3
"""Build a private BJE market/Hedge/FX snapshot from data_info alone.

USDKRW model observations are DailyRate!V midpoint values. No data_bb quote is
read, spliced, or used as a fallback. Actual inputs and output stay outside the
repository. Estimator settings are fixed before the trailing holdout evaluation.
"""
from __future__ import annotations

import argparse
from datetime import date
import json
from pathlib import Path

from build_info_snapshot import build_from_rows, file_hash, outside_repo, read_info
from fx_markov import build_payload


FX_SOURCE = 'data_info.xlsx · DailyRate!A/V · USDKRW · 중간값'


def model_input(rows, start, as_of):
    """Use observed weekday midpoints and disclose absent observation dates.

    A missing row is not zero-filled or treated as a one-day zero return.
    Returns span consecutive supplied observations; unchanged levels remain.
    A gap over 10 calendar days is refused, matching the existing model policy.
    """
    if start > as_of:
        raise ValueError('Model start must be on or before the requested cutoff.')
    sample = [(day, values['V']) for day, values in rows
              if start <= day <= as_of and day.weekday() < 5]
    observations = [(day, value) for day, value in sample if value is not None and value > 0]
    if len(observations) < 251:
        raise ValueError('At least 251 positive weekday midpoint observations are required.')
    gaps = [(right[0] - left[0]).days for left, right in zip(observations, observations[1:])]
    if max(gaps) > 10:
        raise ValueError('Midpoint FX series has an observation gap longer than 10 calendar days.')
    return {
        'dates': [day.isoformat() for day, _ in observations],
        'spots': [value for _, value in observations],
        'quality': {'requestedStart': start.isoformat(), 'requestedAsOf': as_of.isoformat(),
                    'worksheetWeekdayRows': len(sample), 'positiveWeekdayObservations': len(observations),
                    'missingOrNonpositiveWeekdayRowsExcluded': len(sample) - len(observations),
                    'maxCalendarGap': max(gaps), 'gapFilling': False, 'sourceSplicing': False},
    }


def build(info, as_of, *, start=date(2015, 1, 1), horizon=504, paths=40000,
          seed=20261016, starts=6, max_iter=400, holdout=252):
    info = outside_repo(info)
    rows, quality = read_info(info, as_of)
    snapshot = build_from_rows(info, as_of, rows, quality)
    observed = model_input(rows, start, as_of)
    model = build_payload(observed['dates'], observed['spots'], source=FX_SOURCE,
                          horizon=horizon, paths=paths, seed=seed, starts=starts,
                          max_iter=max_iter, holdout=holdout)
    model['meta']['provenance'] = {
        'primary': {'file': info.name, 'sheet': 'DailyRate', 'dateColumn': 'A',
                    'valueColumn': 'V', 'header': ['USDKRW', '중간값'], 'sha256': file_hash(info)},
        'transform': 'Cached positive weekday midpoint levels; observed dates retained; no filling, interpolation, or source splicing.',
        **observed['quality'],
    }
    snapshot['fxModel'] = model
    json.dumps(snapshot, ensure_ascii=False, allow_nan=False)
    return snapshot


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--info', type=Path, required=True)
    parser.add_argument('--as-of', type=date.fromisoformat, required=True)
    parser.add_argument('--start', type=date.fromisoformat, default=date(2015, 1, 1))
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--horizon', type=int, default=504)
    parser.add_argument('--paths', type=int, default=40000)
    parser.add_argument('--starts', type=int, default=6)
    parser.add_argument('--max-iter', type=int, default=400)
    parser.add_argument('--seed', type=int, default=20261016)
    parser.add_argument('--holdout', type=int, default=252)
    args = parser.parse_args()
    try:
        info, output = outside_repo(args.info), outside_repo(args.output)
        if info == output:
            raise ValueError('Output must not overwrite the source workbook.')
        snapshot = build(info, args.as_of, start=args.start, horizon=args.horizon,
                         paths=args.paths, starts=args.starts, max_iter=args.max_iter,
                         seed=args.seed, holdout=args.holdout)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(snapshot, ensure_ascii=False, allow_nan=False,
                                     separators=(',', ':')), encoding='utf-8')
    except (ValueError, OSError) as error:
        parser.error(str(error))
    model = snapshot['fxModel']
    print(json.dumps({'kind': snapshot['kind'], 'asOf': snapshot['meta']['asOf'],
                      'latestObservation': snapshot['meta']['latestObservation'],
                      'ratePairObservations': {p['tenor']: len(p['history']) for p in snapshot['fxAnalytics']['ratePairs']},
                      'fxModel': {'asOf': model['meta']['asOf'], 'observations': model['meta']['n'],
                                  'converged': model['model']['diagnostics']['converged'],
                                  'momentCheck': model['validation']['momentCheck'],
                                  'holdout': model['validation']['outOfSample']}}, ensure_ascii=False))


if __name__ == '__main__':
    main()
