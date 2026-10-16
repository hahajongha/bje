#!/usr/bin/env python3
"""Read-only independent verification of a private data_info snapshot.

Usage: python scripts/verify_info_snapshot.py --info /private/data_info.xlsx \
    --snapshot /private/info-snapshot.json

Reads cached XLSX XML with the standard library. It deliberately does not
import the snapshot builder, openpyxl, NumPy, or any repository calculation.
This checks extraction and arithmetic against the same workbook; it is not
independent confirmation of the provider's underlying observations.
"""
from __future__ import annotations

import argparse
from datetime import date, timedelta
import hashlib
import json
import math
from pathlib import Path, PurePosixPath
import re
import xml.etree.ElementTree as ET
from zipfile import ZipFile

REPO = Path(__file__).resolve().parents[1]
NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
REL_NS = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
# Independent column contract. No mapping or helper is imported from the builder.
MARKET = {
    'rates': [('kr_policy', 'Q', '%'), ('kr_3y', 'I', '%'), ('kr_10y', 'M', '%'),
              ('us_policy', 'AT', '%'), ('us_2y', 'AH', '%'), ('us_10y', 'AL', '%'),
              ('jp_policy', 'AU', '%'), ('jp_10y', 'BB', '%'), ('ecb_mro', 'BP', '%'),
              ('de_10y', 'BV', '%'), ('au_10y', 'BM', '%'), ('gb_10y', 'CE', '%')],
    'risk': [('vix', 'IJ', '지수'), ('move', 'IK', '지수'), ('vkospi', 'II', '지수')],
    'fx': [('usdkrw', 'V', '원/달러'), ('jpykrw', 'Y', '원/100엔'),
           ('eurkrw', 'AB', '원/유로'), ('audkrw', 'AC', '원/호주달러'), ('dxy', 'W', '지수')],
}
HEDGE = [('USDKRW', ('HW', 'HX', 'HY'), 'V'), ('JPYKRW', ('HZ', 'IA', 'IB'), 'Y'),
         ('EURKRW', ('IC', 'ID', 'IE'), 'AB'), ('AUDKRW', ('IF', 'IG', 'IH'), 'AC')]
COLUMNS = {col for specs in MARKET.values() for _, col, _ in specs} | {'JO', 'JP', 'JQ'}
COLUMNS |= {col for _, columns, _ in HEDGE for col in columns}
COLUMNS |= {'B', 'E', 'G', 'AE', 'AG', 'AI'}


def private_path(value):
    path = Path(value).resolve()
    if path.is_relative_to(REPO):
        raise ValueError('Input workbook and snapshot must both be outside hahajongha/bje.')
    if not path.is_file():
        raise ValueError('A required private input file does not exist.')
    return path


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def positive(value):
    return finite(value) and value > 0


def sample_variance(values):
    # Two-pass, compensated summation; independent of statistics.stdev.
    center = math.fsum(values) / len(values)
    return math.fsum((value - center) ** 2 for value in values) / (len(values) - 1)


def sha256(path):
    result = hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def read_xml(info, cutoff):
    """Resolve DailyRate through workbook relationships, then read cached cells."""
    records, headers = {}, {}
    with ZipFile(info) as archive:
        strings = []
        if 'xl/sharedStrings.xml' in archive.namelist():
            strings = [''.join(node.itertext()) for node in ET.fromstring(archive.read('xl/sharedStrings.xml'))]
        workbook = ET.fromstring(archive.read('xl/workbook.xml'))
        properties = workbook.find(NS + 'workbookPr')
        epoch_1904 = properties is not None and properties.attrib.get('date1904') in ('1', 'true')
        relationships = {node.attrib['Id']: node.attrib['Target']
                         for node in ET.fromstring(archive.read('xl/_rels/workbook.xml.rels'))}
        sheet = next((node for node in workbook.find(NS + 'sheets') if node.attrib['name'] == 'DailyRate'), None)
        if sheet is None:
            raise ValueError('DailyRate worksheet is absent.')
        target = relationships[sheet.attrib[REL_NS + 'id']]
        xml_path = target.lstrip('/') if target.startswith('/') else str(PurePosixPath('xl') / target)
        for _, row in ET.iterparse(archive.open(xml_path), events=['end']):
            if row.tag != NS + 'row':
                continue
            row_number = int(row.attrib['r'])
            values = {}
            for cell in row:
                column = re.sub(r'\d', '', cell.attrib.get('r', ''))
                if column not in COLUMNS and column != 'A':
                    continue
                kind = cell.attrib.get('t', 'n')
                raw = cell.find(NS + 'v')
                value = None
                if kind == 'inlineStr':
                    inline = cell.find(NS + 'is')
                    value = ''.join(inline.itertext()) if inline is not None else None
                elif raw is not None and raw.text is not None:
                    if kind == 's':
                        value = strings[int(raw.text)]
                    elif kind == 'str':
                        value = raw.text
                    elif kind == 'd':
                        value = date.fromisoformat(raw.text[:10])
                    elif kind == 'n':
                        try:
                            value = float(raw.text)
                        except ValueError:
                            pass
                values[column] = value
            if row_number in (8, 9):
                headers[row_number] = values
            elif row_number >= 10:
                serial = values.get('A')
                if isinstance(serial, date):
                    observed = serial
                elif finite(serial):
                    # The 1900 date system includes Excel's fictitious leap day.
                    epoch = date(1904, 1, 1) if epoch_1904 else date(1899, 12, 30 if serial >= 60 else 31)
                    observed = epoch + timedelta(days=int(serial))
                else:
                    row.clear()
                    continue
                if observed <= cutoff:
                    selected = {column: values.get(column) if finite(values.get(column)) else None for column in COLUMNS}
                    if observed in records and records[observed] != selected:
                        raise ValueError('Conflicting dated rows in independent XML reader.')
                    records[observed] = selected
            row.clear()
    if headers.get(8, {}).get('A') != 'DATES' or headers.get(9, {}).get('A') != '일자':
        raise ValueError('Date headers do not match the independently verified source contract.')
    for _, columns, _ in HEDGE:
        if any(headers[9].get(column) != '프리미엄' for column in columns):
            raise ValueError('Hedge source headers do not identify raw premiums.')
    expected_bond = {'JO': '총수익지수(산출일)', 'JP': '평균 수정 듀레이션(산출일)', 'JQ': '평균 CONVEXITY(산출일)'}
    if any(headers[9].get(column) != label for column, label in expected_bond.items()):
        raise ValueError('KIS source fields do not match the independent column contract.')
    if not records or not any(any(finite(value) for value in row.values()) for row in records.values()):
        raise ValueError('No finite dated source observations before cutoff.')
    return dict(sorted(records.items()))


def expected_market(records):
    result = {}
    for group, specifications in MARKET.items():
        result[group] = []
        for identifier, column, unit in specifications:
            observations = [(day, row[column]) for day, row in records.items() if finite(row[column])]
            if not observations:
                continue
            current_day, current = observations[-1]
            prior_day, prior = observations[-2] if len(observations) > 1 else (None, None)
            result[group].append({'id': identifier, 'value': current, 'previous': prior,
                                  'change': current - prior if prior is not None else None,
                                  'unit': unit, 'asOf': current_day.isoformat(),
                                  'previousDate': prior_day.isoformat() if prior_day else None})
    return result


def expected_hedge(records):
    weekdays = [day for day in records if day.weekday() < 5]
    pairs, scaling_errors = [], []
    for currency, columns, fx_column in HEDGE:
        observed = [day for day, row in records.items() if any(finite(row[column]) for column in columns)]
        if not observed:
            continue
        latest = observed[-1]
        pair = {'currency': currency, 'asOf': latest.isoformat(), 'aggregation': 'snapshot',
                **{key: records[latest][column] for key, column in zip(('hedge3m', 'hedge6m', 'hedge12m'), columns)}}
        pair['history'] = [{'date': day.isoformat(), 'value': math.fsum(row[column] for column in columns) / 3}
                           for day, row in records.items() if day >= date(2015, 1, 1)
                           and all(finite(row[column]) for column in columns)]
        pair['fxVol'], pair['volAsOf'], pair['volPeriod'] = None, None, None
        if len(weekdays) >= 253:
            window = weekdays[-253:]
            pair['volPeriod'] = f'{window[0].isoformat()} ~ {window[-1].isoformat()} · 252 수익률'
            if all(positive(records[day][fx_column]) for day in window):
                levels = [records[day][fx_column] for day in window]
                returns = [math.log(levels[i] / levels[i-1]) for i in range(1, len(levels))]
                pair['fxVol'] = math.sqrt(sample_variance(returns) * 252) * 100
                pair['volAsOf'] = window[-1].isoformat()
                scaled = [math.log((levels[i] / 100) / (levels[i-1] / 100)) for i in range(1, len(levels))]
                scaling_errors.append(abs(pair['fxVol'] - math.sqrt(sample_variance(scaled) * 252) * 100))
        pairs.append(pair)
    return {'unit': 'source_value', 'pairs': pairs}, max(scaling_errors, default=0)


def expected_fx_analytics(records, cutoff):
    """Independently reconcile exact-date rate cases and raw FX histories."""
    eligible = [(day, row) for day, row in records.items() if day >= date(2015, 1, 1)]
    rates = []
    for tenor, kr, us in [('PR', 'Q', 'AT'), ('3M', 'B', 'AE'), ('1Y', 'E', 'AG'),
                         ('2Y', 'G', 'AH'), ('3Y', 'I', 'AI')]:
        rates.append({'tenor': tenor, 'history': [
            {'date': day.isoformat(), 'kr': row[kr], 'us': row[us],
             'hedge': math.fsum([row['HW'], row['HX'], row['HY']]) / 3}
            for day, row in eligible if all(finite(row[col]) for col in [kr, us, 'HW', 'HX', 'HY'])]})
    spots = [{'id': identifier, 'unit': unit,
              'history': [{'date': day.isoformat(), 'value': row[column]}
                          for day, row in eligible if positive(row[column])]}
             for identifier, column, unit in MARKET['fx']]
    return {'schemaVersion': 1, 'asOf': cutoff.isoformat(), 'source': 'data_info.xlsx · DailyRate',
            'hedgeUnit': 'source_value', 'ratePairs': rates, 'spots': spots}


def expected_model_input(records, actual, cutoff, source_hash):
    """Verify fitted observations without sharing production XLSX extraction."""
    provenance = actual['meta']['provenance']
    start = date.fromisoformat(provenance['requestedStart'])
    rows = [(day, row['V']) for day, row in records.items()
            if start <= day <= cutoff and day.weekday() < 5 and positive(row['V'])]
    if not rows:
        raise ValueError('No independently recovered midpoint model history.')
    return {'schemaVersion': 1, 'pair': 'USDKRW',
            'meta': {'asOf': rows[-1][0].isoformat(), 'start': rows[0][0].isoformat(),
                     'end': rows[-1][0].isoformat(), 'n': len(rows), 'returnObservations': len(rows) - 1,
                     'source': 'data_info.xlsx · DailyRate!A/V · USDKRW · 중간값',
                     'provenance': {'primary': {'sheet': 'DailyRate', 'dateColumn': 'A', 'valueColumn': 'V',
                                                'header': ['USDKRW', '중간값'], 'sha256': source_hash},
                                    'gapFilling': False, 'sourceSplicing': False}},
            'history': [{'date': day.isoformat(), 'spot': value} for day, value in rows]}


def expected_bond(records, cutoff):
    common = [day for day, row in records.items() if all(positive(row[column]) for column in ('JO', 'JP', 'JQ'))]
    if not common:
        return None, None
    latest = common[-1]
    result = {'asOf': latest.isoformat(), 'index': records[latest]['JO'], 'duration': records[latest]['JP'],
              'convexity': records[latest]['JQ'], 'totalReturnYtd': None, 'totalReturn1y': None,
              'annualMean': None, 'annualVol': None, 'annualGeometricReturn': None,
              'maxDrawdown': None, 'periodStart': None, 'periodEnd': None, 'observations': 0, 'monthly': []}
    indices = [day for day, row in records.items() if positive(row['JO'])]
    try:
        anniversary = date(latest.year - 1, latest.month, latest.day)
    except ValueError:
        anniversary = date(latest.year - 1, 2, 28)
    for key, reference in [('totalReturnYtd', date(latest.year - 1, 12, 31)), ('totalReturn1y', anniversary)]:
        eligible = [day for day in indices if timedelta(0) <= reference - day <= timedelta(days=7)]
        if eligible:
            result[key] = (records[latest]['JO'] / records[max(eligible)]['JO'] - 1) * 100
    # Walk backward over calendar month ends, independently of month-index helpers.
    end = date(cutoff.year, cutoff.month, 1) - timedelta(days=1)
    calendar_ends = []
    for _ in range(61):
        calendar_ends.append(end)
        end = date(end.year, end.month, 1) - timedelta(days=1)
    endpoints = []
    for end in reversed(calendar_ends):
        candidates = [day for day in common if (day.year, day.month) == (end.year, end.month)]
        if not candidates or (end - max(candidates)).days > 7:
            return result, None
        endpoints.append(max(candidates))
    levels = [records[day]['JO'] for day in endpoints]
    returns = [levels[i] / levels[i-1] - 1 for i in range(1, len(levels))]
    peak, worst = -math.inf, 0
    for level in levels:
        peak = max(peak, level)
        worst = min(worst, level / peak - 1)
    result.update(annualMean=math.fsum(returns) / len(returns) * 1200,
                  annualVol=math.sqrt(sample_variance(returns) * 12) * 100,
                  annualGeometricReturn=math.expm1(math.log(levels[-1] / levels[0]) * 12 / len(returns)) * 100,
                  maxDrawdown=worst * 100, periodStart=endpoints[0].isoformat(),
                  periodEnd=endpoints[-1].isoformat(), observations=len(returns),
                  monthly=[{'date': day.isoformat(), 'index': records[day]['JO']} for day in endpoints])
    identity_error = abs(math.prod(1 + value for value in returns) - levels[-1] / levels[0])
    if identity_error > 1e-10:
        raise ValueError('Independent monthly compounding identity failed.')
    return result, identity_error


def compare(actual, expected, absolute, relative, counts, location='snapshot'):
    """Compare expected fields; metadata prose is deliberately not reimplemented."""
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            raise ValueError(f'{location}: expected an object.')
        for key, value in expected.items():
            if key not in actual:
                raise ValueError(f'{location}.{key}: missing field.')
            compare(actual[key], value, absolute, relative, counts, f'{location}.{key}')
    elif isinstance(expected, list):
        if not isinstance(actual, list) or len(actual) != len(expected):
            raise ValueError(f'{location}: observation count mismatch.')
        for index, (left, right) in enumerate(zip(actual, expected)):
            compare(left, right, absolute, relative, counts, f'{location}[{index}]')
    elif finite(expected):
        if not finite(actual) or not math.isclose(actual, expected, abs_tol=absolute, rel_tol=relative):
            raise ValueError(f'{location}: independent numerical comparison failed.')
        counts['numericFields'] += 1
        counts['maxAbsoluteError'] = max(counts['maxAbsoluteError'], abs(actual - expected))
    else:
        if actual != expected:
            raise ValueError(f'{location}: date, unit, identity, or missing-value mismatch.')
        counts['exactFields'] += 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--info', type=Path, required=True)
    parser.add_argument('--snapshot', type=Path, required=True)
    parser.add_argument('--atol', type=float, default=1e-9)
    parser.add_argument('--rtol', type=float, default=1e-11)
    args = parser.parse_args()
    try:
        if not all(math.isfinite(value) and value >= 0 for value in (args.atol, args.rtol)):
            raise ValueError('Tolerances must be finite and nonnegative.')
        info, snapshot_path = private_path(args.info), private_path(args.snapshot)
        actual = json.loads(snapshot_path.read_text(encoding='utf-8'))
        cutoff = date.fromisoformat(actual['meta']['asOf'])
        records = read_xml(info, cutoff)
        hedge, scaling_error = expected_hedge(records)
        bond, identity_error = expected_bond(records, cutoff)
        latest = max(day for day, row in records.items() if any(finite(value) for value in row.values()))
        expected = {'kind': 'bje_data_info', 'schemaVersion': 1,
                    'meta': {'asOf': cutoff.isoformat(), 'latestObservation': latest.isoformat(),
                             'sha256': sha256(info), 'units': {'hedge': 'source_value', 'rates': 'percent',
                             'bondReturns': 'percent', 'fxVolatility': 'annual_percent'}},
                    'market': expected_market(records), 'bond': bond, 'fxHedge': hedge}
        if 'fxAnalytics' in actual:
            expected['fxAnalytics'] = expected_fx_analytics(records, cutoff)
        if 'fxModel' in actual:
            expected['fxModel'] = expected_model_input(records, actual['fxModel'], cutoff, sha256(info))
        counts = {'numericFields': 0, 'exactFields': 0, 'maxAbsoluteError': 0}
        compare(actual, expected, args.atol, args.rtol, counts)
        print(json.dumps({'verified': True, 'reader': 'XLSX XML / standard-library math', **counts,
                          'marketMetrics': sum(len(group) for group in expected['market'].values()),
                          'bondMonthlyEndpoints': len(bond['monthly']) if bond else 0,
                          'hedgeHistoryRows': sum(len(pair['history']) for pair in hedge['pairs']),
                          'ratePairHistoryRows': sum(len(pair['history']) for pair in expected.get('fxAnalytics', {}).get('ratePairs', [])),
                          'fxModelObservations': len(expected.get('fxModel', {}).get('history', [])),
                          'monthlyCompoundingIdentityError': identity_error,
                          'logVolScalingIdentityError': scaling_error,
                          'atol': args.atol, 'rtol': args.rtol}, ensure_ascii=False))
    except (ValueError, KeyError, TypeError, OSError, ET.ParseError) as error:
        parser.error(str(error))


if __name__ == '__main__':
    main()
