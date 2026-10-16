"""Numerical and input-contract checks; all observations are synthetic."""

import itertools
import math
from pathlib import Path
import sys
import unittest

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from fx_markov import (MarkovFit, fit_markov, forecast_markov, forecast_moments,
                       forward_backward, mixture_quantile, validate_series, weekday_dates)


class TestMarkovModel(unittest.TestCase):
    def setUp(self):
        self.mu = np.array([-0.002, 0.001, 0.006])
        self.var = np.array([0.001, 0.003, 0.009]) ** 2
        self.p = np.array([[0.90, 0.09, 0.01], [0.05, 0.90, 0.05], [0.02, 0.12, 0.86]])
        self.initial = np.array([0.2, 0.5, 0.3])

    def enumerate_moments(self, horizon):
        mean, second, multiplier, innovation = 0.0, 0.0, 0.0, 0.0
        probabilities = np.zeros(3)
        for chain in itertools.product(range(3), repeat=horizon + 1):
            weight = self.initial[chain[0]]
            for left, right in zip(chain, chain[1:]):
                weight *= self.p[left, right]
            mean_path = sum(self.mu[j] for j in chain[1:])
            variance_path = sum(self.var[j] for j in chain[1:])
            mean += weight * mean_path
            second += weight * (variance_path + mean_path**2)
            multiplier += weight * math.exp(mean_path + variance_path / 2)
            innovation += weight * variance_path
            probabilities[chain[-1]] += weight
        return mean, second - mean**2, multiplier, innovation, probabilities

    def test_exact_moments_against_all_state_paths(self):
        result = forecast_moments(self.mu, self.var, self.p, self.initial, 4)
        for horizon, moment in enumerate(result, start=1):
            mean, variance, multiplier, innovation, probabilities = self.enumerate_moments(horizon)
            self.assertAlmostEqual(mean, moment["logMean"], places=13)
            self.assertAlmostEqual(variance, moment["logVariance"], places=13)
            self.assertAlmostEqual(multiplier, moment["meanMultiplier"], places=13)
            self.assertAlmostEqual(innovation, moment["innovationVariance"], places=13)
            np.testing.assert_allclose(moment["probs"], probabilities, atol=1e-13)
            self.assertAlmostEqual(moment["logVariance"], moment["innovationVariance"] + moment["regimePathVariance"], places=13)

    def test_filter_likelihood_and_smoother_against_bruteforce(self):
        y = np.array([0.001, -0.003, 0.009])
        ll, filtered, smoothed, counts = forward_backward(y, self.mu, self.var, self.p, self.initial)
        density = np.exp(-0.5 * (y[:, None] - self.mu) ** 2 / self.var) / np.sqrt(2 * np.pi * self.var)
        weighted = []
        for chain in itertools.product(range(3), repeat=len(y)):
            weight = self.initial[chain[0]] * density[0, chain[0]]
            for t in range(1, len(y)):
                weight *= self.p[chain[t - 1], chain[t]] * density[t, chain[t]]
            weighted.append((chain, weight))
        total = sum(weight for _, weight in weighted)
        expected_smoothing, expected_counts = np.zeros((3, 3)), np.zeros((3, 3))
        for chain, weight in weighted:
            for t, state in enumerate(chain):
                expected_smoothing[t, state] += weight / total
            for left, right in zip(chain, chain[1:]):
                expected_counts[left, right] += weight / total
        self.assertAlmostEqual(ll, math.log(total), places=12)
        np.testing.assert_allclose(smoothed, expected_smoothing, atol=1e-13)
        np.testing.assert_allclose(counts, expected_counts, atol=1e-13)
        np.testing.assert_allclose(filtered[-1], smoothed[-1], atol=1e-13)

    def test_equal_states_reduce_to_gaussian_random_walk(self):
        mean, variance = 0.0001, 0.00003
        result = forecast_moments(np.full(3, mean), np.full(3, variance), self.p, self.initial, 30)[-1]
        self.assertAlmostEqual(result["logMean"], mean * 30, places=12)
        self.assertAlmostEqual(result["logVariance"], variance * 30, places=12)
        self.assertAlmostEqual(result["meanMultiplier"], math.exp(30 * (mean + variance / 2)), places=12)
        self.assertAlmostEqual(result["regimePathVariance"], 0, places=13)

    def test_quantile_solves_mixture_cdf(self):
        probability = self.initial @ self.p
        for q in (0.025, 0.16, 0.5, 0.84, 0.975):
            quantile = mixture_quantile(self.mu, self.var, probability, q)
            cdf = sum(probability[j] * 0.5 * (1 + math.erf((quantile - self.mu[j]) / math.sqrt(2 * self.var[j]))) for j in range(3))
            self.assertAlmostEqual(q, cdf, places=12)

    def test_monte_carlo_bands_and_exact_moments(self):
        fit = MarkovFit(self.mu, self.var, self.p, self.initial, self.initial[None, :], self.initial[None, :], 0, {})
        forecast, diagnostics, _ = forecast_markov(fit, 1300, "2026-10-15", horizon=20, paths=60000, seed=31)
        self.assertLess(diagnostics["meanAgreementSE"], 5)
        self.assertLess(diagnostics["varianceAgreementSE"], 5)
        for row in forecast:
            values = [row[key] for key in ["lower95", "lower90", "lower68", "median", "upper68", "upper90", "upper95"]]
            self.assertEqual(sorted(values), values)
            self.assertAlmostEqual(sum(row["probs"]), 1, places=12)

    def test_em_is_monotone_and_states_are_sorted(self):
        rng = np.random.default_rng(73)
        p = np.array([[0.96, 0.03, 0.01], [0.03, 0.94, 0.03], [0.02, 0.05, 0.93]])
        deviations = [0.001, 0.004, 0.014]
        state, values = 0, []
        for _ in range(1100):
            state = rng.choice(3, p=p[state])
            values.append(rng.normal(0, deviations[state]))
        fit = fit_markov(values, starts=2, max_iter=180, tolerance=1e-5, seed=17)
        self.assertTrue(np.all(np.diff(fit.variances) >= 0))
        self.assertTrue(all(row["monotoneLikelihood"] for row in fit.diagnostics["starts"]))
        np.testing.assert_allclose(fit.transition.sum(axis=1), 1, atol=1e-12)
        np.testing.assert_allclose(fit.filtered.sum(axis=1), 1, atol=1e-12)
        self.assertTrue(np.all(fit.smoothed.mean(axis=0) > 0.005))
        np.testing.assert_allclose(np.sqrt(fit.variances), deviations, rtol=0.30)

    def test_invalid_inputs_and_weekday_calendar(self):
        for dates, spots in [(["2020-01-01", "2020-01-01"], [1, 2]),
                             (["2020-01-02", "2020-01-01"], [1, 2]),
                             (["2020-01-01", "2020-01-02"], [1, 0]),
                             (["2020-01-01", "2020-01-02"], [1, float("nan")])]:
            with self.assertRaises(ValueError):
                validate_series(dates, spots)
        with self.assertRaises(ValueError):
            fit_markov(np.zeros(300))
        self.assertEqual(weekday_dates("2026-10-16", 2), ["2026-10-19", "2026-10-20"])


if __name__ == "__main__":
    unittest.main()
