#!/usr/bin/env python3
"""Read cached Excel USDKRW observations into a private model input.

Bloomberg PX_LAST and Infomax midpoint are distinct definitions. Only the former
is fitted; the latter is retained as a same-date diagnostic, never spliced.
"""
import argparse
from datetime import date
import json
from pathlib import Path
import numpy as np
from build_data import read_series, file_hash

REPO = Path(__file__).resolve().parents[1]


def extract(info, bb, start, as_of):
    info, bb = Path(info).resolve(), Path(bb).resolve()
    if any(p.is_relative_to(REPO) for p in (info, bb)):
        raise ValueError('Actual source workbooks must be outside the public repository.')
    b, bh = read_series(bb, 'D', ['BB'], as_of)
    i, ih = read_series(info, 'DailyRate', ['V'], as_of)
    if bh['BB'][2].upper() != 'USDKRW CURNCY' or bh['BB'][3] != 'PX_LAST':
        raise ValueError('Expected data_bb D!BB8=USDKRW CURNCY, BB9=PX_LAST.')
    if ih['V'][1] != 'USDKRW' or ih['V'][3] != '중간값':
        raise ValueError('Expected data_info DailyRate!V7=USDKRW, V9=중간값.')
    primary = {d: v for d, v in b['BB'].items() if start <= d <= as_of and d.weekday() < 5}
    cross = {d: v for d, v in i['V'].items() if start <= d <= as_of and d.weekday() < 5}
    dates = sorted(primary)
    if len(dates) < 500:
        raise ValueError('At least 500 positive weekday observations are required.')
    common = sorted(set(primary) & set(cross))
    gaps = [(dates[k] - dates[k - 1]).days for k in range(1, len(dates))]
    if max(gaps) > 10:
        raise ValueError('Primary FX series has an observation gap longer than 10 calendar days.')
    diffs = np.array([primary[d] - cross[d] for d in common])
    last_common = common[-1] if common else None
    return {
        'dates': [d.isoformat() for d in dates],
        'spots': [primary[d] for d in dates],
        'source': 'data_bb.xlsx · D!A/BB · USDKRW CURNCY · PX_LAST',
        'provenance': {
            'requestedAsOf': as_of.isoformat(), 'sampleStart': start.isoformat(),
            'primary': {'file': bb.name, 'sheet': 'D', 'dateColumn': 'A', 'valueColumn': 'BB',
                        'header': bh['BB'], 'sha256': file_hash(bb)},
            'crosscheck': {'file': info.name, 'sheet': 'DailyRate', 'dateColumn': 'A',
                           'valueColumn': 'V', 'header': ih['V'], 'sha256': file_hash(info)},
            'transform': 'Positive cached numeric weekday levels; sorted dates; no filling, interpolation, or source splicing.',
            'maxCalendarGap': max(gaps), 'cachedValuesOnly': True,
        },
        'sourceComparison': {
            'commonObservations': len(common),
            'lastCommonDate': last_common.isoformat() if last_common else None,
            'primaryLastCommon': primary.get(last_common), 'midpointLastCommon': cross.get(last_common),
            'medianAbsoluteDifference': float(np.median(np.abs(diffs))) if len(diffs) else None,
            'maxAbsoluteDifference': float(np.max(np.abs(diffs))) if len(diffs) else None,
            'note': 'PX_LAST and midpoint use different quote definitions/timestamps; this is a diagnostic, not independent confirmation of the same fixing.',
        },
    }


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--info', type=Path, required=True)
    p.add_argument('--bb', type=Path, required=True)
    p.add_argument('--start', type=date.fromisoformat, default=date(2015, 1, 1))
    p.add_argument('--as-of', type=date.fromisoformat, required=True)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    output = a.output.resolve()
    if output.is_relative_to(REPO):
        p.error('Private model input must be outside the public repository.')
    result = extract(a.info, a.bb, a.start, a.as_of)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, allow_nan=False), encoding='utf-8')
    print(json.dumps({'observations': len(result['dates']), 'start': result['dates'][0],
                      'end': result['dates'][-1], 'sourceComparison': result['sourceComparison']}, ensure_ascii=False))
