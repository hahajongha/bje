"""Synthetic boundary checks for raw-unit Hedge/FX integration."""
from datetime import date, timedelta
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from build_info_snapshot import HEADERS, build_fx_analytics, build_hedge
from build_hedge_fx_snapshot import model_input


def values(**updates):
    return {**dict.fromkeys(HEADERS), **updates}


class TestHedgeFxAnalytics(unittest.TestCase):
    def test_individual_tenors_preserve_partial_rows_without_changing_complete_average(self):
        rows = [(date(2014, 12, 31), values(HW=-1, HX=-2, HY=-3)),
                (date(2026, 10, 12), values(HW=-1, HX=0, HY=1)),
                (date(2026, 10, 13), values(HW=None, HX=None, HY=None)),
                (date(2026, 10, 14), values(HW=-2, HX=None, HY=0))]
        pair = build_hedge(rows)['pairs'][0]
        self.assertEqual(pair['asOf'], '2026-10-14')
        self.assertEqual(pair['history'], [{'date': '2026-10-12', 'value': 0}])
        self.assertEqual(pair['tenorHistory'], [
            {'date': '2026-10-12', 'hedge3m': -1, 'hedge6m': 0, 'hedge12m': 1},
            {'date': '2026-10-14', 'hedge3m': -2, 'hedge6m': None, 'hedge12m': 0}])

    def test_rates_keep_signs_exact_dates_complete_average_and_no_unit_assumption(self):
        common = {'Q': 2.5, 'AT': 4, 'B': 2.4, 'AE': 3.9, 'E': 2.3, 'AG': 3.8,
                  'G': 2.2, 'AH': 3.7, 'I': 2.1, 'AI': 3.6, 'HW': -3, 'HX': 0, 'HY': 3}
        rows = [(date(2014, 12, 31), values(**common)),
                (date(2015, 1, 2), values(**common)),
                (date(2015, 1, 5), values(**{**common, 'HX': None})),
                (date(2015, 1, 6), values(**{**common, 'Q': None, 'AT': None, 'B': -0.1}))]
        result = build_fx_analytics(rows, date(2015, 1, 6))
        self.assertEqual(result['hedgeUnit'], 'source_value')
        self.assertEqual([pair['tenor'] for pair in result['ratePairs']], ['PR', '3M', '1Y', '2Y', '3Y'])
        pr, three = result['ratePairs'][:2]
        self.assertEqual(pr['history'], [{'date': '2015-01-02', 'kr': 2.5, 'us': 4, 'hedge': 0}])
        self.assertEqual(three['history'][-1], {'date': '2015-01-06', 'kr': -0.1, 'us': 3.9, 'hedge': 0})
        self.assertIn('!B', three['krSource'])
        self.assertIn('!AE', three['usSource'])
        self.assertNotIn('gap', three['history'][-1])
        self.assertNotIn('annual_percent', result.values())

    def test_spots_preserve_quote_units_and_do_not_fill_cross_market_dates(self):
        rows = [(date(2014, 12, 31), values(V=999)),
                (date(2015, 1, 2), values(V=1400, Y=900, AB=1500, AC=950, W=100)),
                (date(2015, 1, 5), values(V=None, Y=0, AB=-1, AC=951, W=101))]
        spots = {s['id']: s for s in build_fx_analytics(rows, date(2015, 1, 5))['spots']}
        self.assertEqual(spots['jpykrw']['unit'], '원/100엔')
        self.assertEqual(spots['jpykrw']['history'], [{'date': '2015-01-02', 'value': 900}])
        self.assertEqual(spots['usdkrw']['history'], [{'date': '2015-01-02', 'value': 1400}])
        self.assertEqual(len(spots['audkrw']['history']), 2)
        self.assertEqual(len(spots['eurkrw']['history']), 1)
        self.assertIn('중간값', spots['usdkrw']['source'])


class TestMidpointModelInput(unittest.TestCase):
    def setUp(self):
        self.rows = []
        day = date(2025, 1, 1)
        while len(self.rows) < 270:
            self.rows.append((day, values(V=1300 + len(self.rows) / 10)))
            day += timedelta(days=1 if day.weekday() != 4 else 3)
        self.start, self.end = self.rows[0][0], self.rows[-1][0]

    def test_midpoint_only_missing_counts_weekends_and_cutoff(self):
        self.rows[30][1]['V'] = None
        self.rows[35][1]['V'] = 0
        self.rows[40][1]['V'] = -1
        self.rows[45][1]['V'] = self.rows[44][1]['V']
        weekend = (date(2025, 1, 4), values(V=999999))
        rows = sorted(self.rows + [weekend, (self.end + timedelta(days=30), values(V=888888))])
        result = model_input(rows, self.start, self.end)
        self.assertEqual(len(result['spots']), 267)
        self.assertEqual(result['quality']['missingOrNonpositiveWeekdayRowsExcluded'], 3)
        self.assertFalse(result['quality']['gapFilling'])
        self.assertFalse(result['quality']['sourceSplicing'])
        self.assertNotIn(999999, result['spots'])
        self.assertNotIn(888888, result['spots'])
        self.assertEqual(result['dates'][-1], self.end.isoformat())
        self.assertEqual(len(result['spots']) - len(set(result['spots'])), 1)

    def test_insufficient_observations_and_long_gap_are_refused(self):
        with self.assertRaisesRegex(ValueError, '251'):
            model_input(self.rows[:250], self.start, self.end)
        with self.assertRaisesRegex(ValueError, 'start'):
            model_input(self.rows, self.end, self.start)
        for _, row in self.rows[90:100]:
            row['V'] = None
        with self.assertRaisesRegex(ValueError, '10 calendar'):
            model_input(self.rows, self.start, self.end)


if __name__ == '__main__':
    unittest.main()
