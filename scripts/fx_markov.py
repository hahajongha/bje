"""Three-state Gaussian Markov switching model for observed FX log returns.

Rows of ``transition`` are origin states; columns are destination states.
The observation dated t is log(spot_t / spot_previous_observation).
Forecast step 1 transitions from the final filtered state before drawing a return.
State labels identify increasing conditional volatility, not currency direction.
No raw market observations are bundled with this module.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
import math

import numpy as np


LABELS = ["저변동", "중변동", "고변동"]


@dataclass
class MarkovFit:
    means: np.ndarray
    variances: np.ndarray
    transition: np.ndarray
    initial: np.ndarray
    filtered: np.ndarray
    smoothed: np.ndarray
    log_likelihood: float
    diagnostics: dict


def _check_parameters(means, variances, transition, probabilities):
    means, variances, transition, probabilities = [
        np.asarray(a, dtype=float) for a in (means, variances, transition, probabilities)
    ]
    if means.shape != (3,) or variances.shape != (3,) or transition.shape != (3, 3) or probabilities.shape != (3,):
        raise ValueError("Exactly three regime means, variances, and probabilities are required")
    if not all(np.isfinite(a).all() for a in (means, variances, transition, probabilities)):
        raise ValueError("Model parameters must be finite")
    if (variances <= 0).any() or (transition < 0).any() or (probabilities < 0).any():
        raise ValueError("Variances must be positive; probabilities nonnegative")
    if not np.allclose(transition.sum(axis=1), 1, atol=1e-10) or not np.isclose(probabilities.sum(), 1, atol=1e-10):
        raise ValueError("Transition rows and state probabilities must sum to one")
    return means, variances, transition, probabilities


def forward_backward(observations, means, variances, transition, initial):
    """Scaled Hamilton filter and full-sample smoother; return log likelihood.

    Per-observation common log-density offsets prevent underflow without changing
    the filtering probabilities. Forecasting uses filtered, never smoothed, data.
    """
    observations = np.asarray(observations, dtype=float)
    means, variances, transition, initial = _check_parameters(means, variances, transition, initial)
    if observations.ndim != 1 or not len(observations) or not np.isfinite(observations).all():
        raise ValueError("Observations must be a nonempty finite vector")
    log_density = -0.5 * (np.log(2 * np.pi * variances) + (observations[:, None] - means) ** 2 / variances)
    offsets = np.max(log_density, axis=1)
    density = np.exp(log_density - offsets[:, None])
    n = len(observations)
    filtered, scales = np.empty((n, 3)), np.empty(n)
    predicted = initial
    for t in range(n):
        weighted = predicted * density[t]
        scales[t] = weighted.sum()
        if scales[t] <= 0 or not np.isfinite(scales[t]):
            raise FloatingPointError("Degenerate filtering probabilities")
        filtered[t] = weighted / scales[t]
        predicted = filtered[t] @ transition
    backward = np.ones((n, 3))
    for t in range(n - 2, -1, -1):
        backward[t] = transition @ (density[t + 1] * backward[t + 1]) / scales[t + 1]
    smoothed = filtered * backward
    smoothed /= smoothed.sum(axis=1, keepdims=True)
    transitions = (
        filtered[:-1, :, None]
        * transition[None, :, :]
        * (density[1:] * backward[1:])[:, None, :]
        / scales[1:, None, None]
    ).sum(axis=0)
    log_likelihood = float(np.sum(np.log(scales) + offsets))
    return log_likelihood, filtered, smoothed, transitions


def fit_markov(log_returns, *, seed=20261016, starts=6, max_iter=400, tolerance=1e-6, min_observations=250):
    """Constrained-variance maximum likelihood by multi-start EM.

    A disclosed floor of 0.5% of unconditional sample variance avoids the
    unbounded Gaussian-mixture likelihood at an isolated observation. Candidate
    fits with <0.5% expected observations in a state are retained in diagnostics
    but excluded from selection. This is regularization, not an economic claim.
    """
    y = np.asarray(log_returns, dtype=float)
    if y.ndim != 1 or len(y) < min_observations or not np.isfinite(y).all():
        raise ValueError(f"At least {min_observations} finite log returns are required")
    if not isinstance(starts, int) or starts < 1 or max_iter < 2:
        raise ValueError("starts must be positive and max_iter at least 2")
    sample_variance = float(np.var(y))
    if sample_variance < 1e-12:
        raise ValueError("Constant or nearly constant FX history cannot identify three regimes")
    floor = sample_variance * 0.005
    rng = np.random.default_rng(seed)
    candidates, diagnostics = [], []
    for start in range(starts):
        means = np.full(3, float(y.mean()))
        variances = sample_variance * np.array([0.22, 0.8, 2.8])
        persistence = [0.96, 0.90, 0.985][start % 3]
        if start:
            means += rng.normal(0, math.sqrt(sample_variance) * 0.10, 3)
            variances *= np.exp(rng.normal(0, 0.35, 3))
        transition = np.full((3, 3), (1 - persistence) / 2)
        np.fill_diagonal(transition, persistence)
        initial = np.full(3, 1 / 3)
        previous = None
        path, converged, failure = [], False, None
        for iteration in range(max_iter):
            likelihood, filtered, smoothed, counts = forward_backward(y, means, variances, transition, initial)
            path.append(likelihood)
            if previous is not None:
                improvement = likelihood - previous
                if improvement < -max(1e-7, abs(previous) * 1e-10):
                    failure = "EM log likelihood decreased"
                    break
                if abs(improvement) < tolerance:
                    converged = True
                    break
            if iteration == max_iter - 1:
                break
            occupancy = smoothed.sum(axis=0)
            if np.any(occupancy < 1e-9) or np.any(counts.sum(axis=1) < 1e-9):
                failure = "Empty state"
                break
            means = smoothed.T @ y / occupancy
            variances = np.maximum((smoothed * (y[:, None] - means) ** 2).sum(axis=0) / occupancy, floor)
            transition = counts / counts.sum(axis=1, keepdims=True)
            initial = smoothed[0] / smoothed[0].sum()
            previous = likelihood
        order = np.argsort(variances)
        occupancy = smoothed.mean(axis=0)[order]
        admissible = failure is None and bool(np.all(occupancy >= 0.005))
        record = {
            "start": start, "iterations": len(path), "converged": converged,
            "logLikelihood": likelihood, "occupancy": occupancy.tolist(),
            "monotoneLikelihood": bool(np.all(np.diff(path) >= -1e-7)),
            "lastImprovement": float(path[-1] - path[-2]) if len(path) > 1 else None,
            "admissible": admissible, "failure": failure,
        }
        diagnostics.append(record)
        if admissible:
            candidates.append((converged, likelihood, MarkovFit(
                means=means[order].copy(), variances=variances[order].copy(),
                transition=transition[np.ix_(order, order)].copy(), initial=initial[order].copy(),
                filtered=filtered[:, order].copy(), smoothed=smoothed[:, order].copy(),
                log_likelihood=likelihood, diagnostics={"selectedStart": start},
            )))
    if not candidates:
        raise ValueError("No admissible three-regime fit; inspect history or increase sample size")
    # Prefer an actual converged optimum, falling back explicitly if none converged.
    candidates.sort(key=lambda item: (item[0], item[1]), reverse=True)
    fit = candidates[0][2]
    fit.diagnostics.update({
        "converged": candidates[0][0], "starts": diagnostics, "seed": seed,
        "varianceFloor": floor, "minimumStateOccupancy": 0.005,
        "transitionRowSums": fit.transition.sum(axis=1).tolist(),
        "logLikelihood": fit.log_likelihood,
        "parameterCount": 14,
        "aic": -2 * fit.log_likelihood + 28,
        "bic": -2 * fit.log_likelihood + 14 * math.log(len(y)),
        "candidateLikelihoodRange": float(max(item[1] for item in candidates) - min(item[1] for item in candidates)),
        "nearBestStarts": sum(abs(item[1] - fit.log_likelihood) < 1e-3 for item in candidates),
        "globalOptimumCertified": False,
    })
    return fit


def forecast_moments(means, variances, transition, current_probs, horizon):
    """Exact state-weighted first/second log-return moments and price MGF.

    The within-state component is E[sum sigma(state)^2]. The residual is the
    variance of the path-dependent sum of state drifts, including all transition
    uncertainty; it is not parameter uncertainty or a causal risk attribution.
    """
    means, variances, transition, probability = _check_parameters(means, variances, transition, current_probs)
    if not isinstance(horizon, int) or horizon < 1:
        raise ValueError("horizon must be a positive integer")
    probability = probability.copy()
    first, second, within = np.zeros(3), np.zeros(3), np.zeros(3)
    mgf = probability.copy()
    result = []
    for _ in range(horizon):
        probability = probability @ transition
        previous_first = first @ transition
        first = previous_first + probability * means
        second = second @ transition + 2 * means * previous_first + probability * (variances + means**2)
        within = within @ transition + probability * variances
        mgf = (mgf @ transition) * np.exp(means + 0.5 * variances)
        mean = float(first.sum())
        variance = max(0.0, float(second.sum() - mean**2))
        within_variance = float(within.sum())
        result.append({
            "probs": probability.copy(), "logMean": mean, "logVariance": variance,
            "innovationVariance": within_variance,
            "regimePathVariance": max(0.0, variance - within_variance),
            "meanMultiplier": float(mgf.sum()),
        })
    return result


def weekday_dates(last_date, horizon):
    """Weekday-only projection; this is not a Korean exchange holiday calendar."""
    day = date.fromisoformat(str(last_date))
    dates = []
    while len(dates) < horizon:
        day += timedelta(days=1)
        if day.weekday() < 5:
            dates.append(day.isoformat())
    return dates


def forecast_markov(fit, last_spot, last_date, *, horizon=504, paths=40000, seed=20261017):
    if not math.isfinite(float(last_spot)) or last_spot <= 0:
        raise ValueError("last_spot must be positive and finite")
    if not isinstance(paths, int) or paths < 1000:
        raise ValueError("At least 1000 simulation paths are required")
    current = fit.filtered[-1]
    moments = forecast_moments(fit.means, fit.variances, fit.transition, current, horizon)
    dates = weekday_dates(last_date, horizon)
    rng = np.random.default_rng(seed)
    states = rng.choice(3, size=paths, p=current)
    cumulative = np.zeros(paths)
    transition_cdf = np.cumsum(fit.transition, axis=1)
    transition_cdf[:, -1] = 1
    forecast = []
    for t, moment in enumerate(moments):
        draws = rng.random(paths)
        states = (draws[:, None] > transition_cdf[states]).sum(axis=1)
        cumulative += fit.means[states] + np.sqrt(fit.variances[states]) * rng.standard_normal(paths)
        quantiles = last_spot * np.exp(np.quantile(cumulative, [0.025, 0.05, 0.16, 0.5, 0.84, 0.95, 0.975]))
        forecast.append({
            "date": dates[t], "step": t + 1, "mean": last_spot * moment["meanMultiplier"],
            "median": float(quantiles[3]), "lower68": float(quantiles[2]), "upper68": float(quantiles[4]),
            "lower90": float(quantiles[1]), "upper90": float(quantiles[5]),
            "lower95": float(quantiles[0]), "upper95": float(quantiles[6]),
            "sigmaLog": math.sqrt(moment["logVariance"]), "probs": moment["probs"].tolist(),
        })
    final = moments[-1]
    empirical_mean, empirical_variance = float(cumulative.mean()), float(cumulative.var())
    mean_se = math.sqrt(final["logVariance"] / paths)
    variance_se = math.sqrt(max(0.0, float(np.mean((cumulative - empirical_mean) ** 4) - empirical_variance**2)) / paths)
    diagnostics = {
        "paths": paths, "seed": seed, "horizon": horizon,
        "analyticLogMean": final["logMean"], "simulatedLogMean": empirical_mean,
        "meanMonteCarloSE": mean_se,
        "analyticLogVariance": final["logVariance"], "simulatedLogVariance": empirical_variance,
        "varianceMonteCarloSE": variance_se,
        "meanAgreementSE": abs(empirical_mean - final["logMean"]) / mean_se if mean_se else 0,
        "varianceAgreementSE": abs(empirical_variance - final["logVariance"]) / variance_se if variance_se else 0,
        "meanPriceExact": True,
    }
    return forecast, diagnostics, moments[0]


def validate_series(dates, spots):
    if len(dates) != len(spots) or len(dates) < 2:
        raise ValueError("Dates and spots must have equal length, at least two")
    parsed = [date.fromisoformat(str(value)) for value in dates]
    if any(right <= left for left, right in zip(parsed, parsed[1:])):
        raise ValueError("Dates must be unique and strictly increasing; no silent deduplication")
    values = np.asarray(spots, dtype=float)
    if values.ndim != 1 or not np.isfinite(values).all() or (values <= 0).any():
        raise ValueError("FX observations must be positive and finite")
    return [day.isoformat() for day in parsed], values


def mixture_quantile(means, variances, probabilities, quantile):
    """Gaussian-mixture log-return quantile by bisection, independent of MC."""
    means, variances, _, probabilities = _check_parameters(means, variances, np.eye(3), probabilities)
    if not 0 < quantile < 1:
        raise ValueError("quantile must be strictly between zero and one")
    deviations = np.sqrt(variances)
    low, high = float(np.min(means - 12 * deviations)), float(np.max(means + 12 * deviations))
    for _ in range(70):
        middle = (low + high) / 2
        cdf = sum(float(probabilities[j]) * 0.5 * (1 + math.erf((middle - means[j]) / (math.sqrt(2) * deviations[j]))) for j in range(3))
        if cdf < quantile:
            low = middle
        else:
            high = middle
    return (low + high) / 2


def evaluate_holdout(dates, spots, *, holdout=252, seed=20261016, starts=6, max_iter=400):
    """Single chronological holdout; frozen fit, causal daily probability updates.

    Neither state count nor estimator options are selected using this sample.
    This test compares 1-observation-ahead price means with a driftless spot
    random walk; it does not establish 504-step forecast calibration.
    """
    dates, spots = validate_series(dates, spots)
    returns = np.diff(np.log(spots))
    if not isinstance(holdout, int) or holdout < 20 or len(returns) - holdout < 250:
        raise ValueError("Holdout requires at least 20 test and 250 training returns")
    split = len(returns) - holdout
    fit = fit_markov(returns[:split], seed=seed, starts=starts, max_iter=max_iter)
    filtered = fit.filtered[-1].copy()
    errors, walk_errors, covered = [], [], {68: [], 90: [], 95: []}
    for index in range(split, len(returns)):
        probability = filtered @ fit.transition
        expected_spot = spots[index] * float(np.sum(probability * np.exp(fit.means + 0.5 * fit.variances)))
        errors.append(expected_spot - spots[index + 1])
        walk_errors.append(float(spots[index] - spots[index + 1]))
        for level in covered:
            tail = (1 - level / 100) / 2
            lower = mixture_quantile(fit.means, fit.variances, probability, tail)
            upper = mixture_quantile(fit.means, fit.variances, probability, 1 - tail)
            covered[level].append(bool(lower <= returns[index] <= upper))
        density = -0.5 * (np.log(2 * np.pi * fit.variances) + (returns[index] - fit.means) ** 2 / fit.variances)
        weighted = probability * np.exp(density - density.max())
        filtered = weighted / weighted.sum()
    model_rmse, walk_rmse = math.sqrt(float(np.mean(np.square(errors)))), math.sqrt(float(np.mean(np.square(walk_errors))))
    return {
        "method": "Fixed-parameter one-step chronological holdout; recursive filtered-state update",
        "observations": holdout, "trainingStart": dates[0], "trainingEnd": dates[split],
        "testStart": dates[split + 1], "testEnd": dates[-1], "unit": "KRW per USD",
        "modelRMSE": model_rmse, "randomWalkRMSE": walk_rmse,
        "rmseImprovementPct": (1 - model_rmse / walk_rmse) * 100 if walk_rmse > 0 else None,
        "coverage68": float(np.mean(covered[68])), "coverage90": float(np.mean(covered[90])), "coverage95": float(np.mean(covered[95])),
        "modelMAE": float(np.mean(np.abs(errors))), "randomWalkMAE": float(np.mean(np.abs(walk_errors))),
        "trainingConverged": fit.diagnostics["converged"], "trainingDiagnostics": fit.diagnostics,
        "selection": "3 states and estimator settings fixed before holdout; no hyperparameter selection on test data",
        "limitations": "단일 252관측 holdout의 1기간 검증. 다기간 구간 커버리지, 구조변화 및 모수불확실성은 검증하지 않음.",
    }


def build_payload(dates, spots, *, source, horizon=504, paths=40000, seed=20261016, starts=6, max_iter=400, holdout=252):
    dates, spots = validate_series(dates, spots)
    returns = np.diff(np.log(spots))
    fit = fit_markov(returns, seed=seed, starts=starts, max_iter=max_iter)
    forecast, simulation, next_day = forecast_markov(fit, float(spots[-1]), dates[-1], horizon=horizon, paths=paths, seed=seed + 1)
    probs = np.vstack([fit.initial, fit.filtered])
    payload = {
        "schemaVersion": 1, "pair": "USDKRW",
        "meta": {
            "asOf": dates[-1], "source": source, "start": dates[0], "end": dates[-1], "n": len(spots),
            "returnObservations": len(returns), "horizon": horizon, "paths": paths, "seed": seed,
            "unchangedReturnCount": int(np.sum(np.diff(spots) == 0)),
            "unit": "KRW per USD", "frequency": "consecutive supplied weekday log returns; unchanged prices are retained",
            "calendar": "주말 제외 평일 기준. 한국·미국 공휴일은 별도로 제외하지 않음.",
            "uncertaintyScope": "추정된 국면별 충격분산과 확률적 국면전이를 반영한 조건부 예측구간. 모수추정 불확실성은 미포함.",
            "historyProbability": "전체 표본 추정 모수를 고정하고 각 관측일까지 필터링한 확률. 실시간 재귀추정 결과 아님. 첫 수준 관측일에는 첫 수익률 국면의 추정 초기확률을 표시.",
            "model": "3-state Gaussian Markov-switching daily log returns; state-specific mean and variance",
            "warnings": ([] if fit.diagnostics["converged"] else ["EM 반복횟수 상한 도달: 추정 미수렴"]),
        },
        "history": [{"date": day, "spot": float(spot), "probs": probability.tolist()} for day, spot, probability in zip(dates, spots, probs)],
        "forecast": forecast,
        "model": {
            "regimes": [{
                "label": LABELS[j], "meanDailyPct": float(fit.means[j] * 100),
                "volDailyPct": float(math.sqrt(fit.variances[j]) * 100),
                "persistence": float(fit.transition[j, j]),
            } for j in range(3)],
            "transition": fit.transition.tolist(), "currentProbs": fit.filtered[-1].tolist(),
            "diagnostics": fit.diagnostics,
            "nextDayVariance": {
                "total": next_day["logVariance"], "innovation": next_day["innovationVariance"],
                "regimePath": next_day["regimePathVariance"], "unit": "squared log return",
            },
        },
        "validation": {"momentCheck": simulation,
                       "outOfSample": evaluate_holdout(dates, spots, holdout=holdout, seed=seed, starts=starts, max_iter=max_iter) if holdout else None,
                       "note": "예측구간은 모형 조건부 분포. 1기간 holdout은 다기간 예측력·구간 커버리지를 보장하지 않음."},
    }
    return payload
