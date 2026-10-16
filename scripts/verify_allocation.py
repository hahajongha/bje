#!/usr/bin/env python3
"""Optional independent numerical check of allocation.mjs against SciPy SLSQP.

Requires Python with NumPy and SciPy, plus Node.js. Run from any directory:
    python scripts/verify_allocation.py

Seed 4313 generates 40 seven-asset fixtures with positive-definite covariance,
asset bounds, and group bands; five fixtures have a fixed bond allocation.
All fixtures have positive excess returns. Minimum variance, maximum Sharpe,
and target-return variance are compared with independently specified SLSQP
problems. This is a numerical cross-check, not a proof for every possible input.
"""

import json
from pathlib import Path
import subprocess

import numpy as np
from scipy.optimize import minimize


REPO_ROOT = Path(__file__).resolve().parents[1]
OBJECTIVE_TOLERANCE = 2e-6
FEASIBILITY_TOLERANCE = 1e-7


def make_fixtures():
    rng = np.random.default_rng(4313)
    fixtures = []
    for index in range(40):
        size = 7
        raw = rng.normal(size=(size, size))
        covariance = raw @ raw.T + np.eye(size) * 2
        vols = rng.uniform(3, 25, size)
        covariance = (
            covariance
            / np.sqrt(np.diag(covariance)[:, None] * np.diag(covariance)[None, :])
            * vols[:, None]
            * vols[None, :]
        )
        means = rng.uniform(2, 12, size)
        anchor = rng.dirichlet(np.ones(size) * 2)
        groups = ["bond"] * 4 + ["equity"] * 2 + ["alternative"]
        bounds = [
            {
                "min": float(max(0, value - rng.uniform(0.03, 0.2))),
                "max": float(min(1, value + rng.uniform(0.03, 0.2))),
            }
            for value in anchor
        ]
        group_policy = {}
        for group in ["bond", "equity", "alternative"]:
            value = sum(anchor[i] for i in range(size) if groups[i] == group)
            spread = rng.uniform(0.03, 0.15)
            group_policy[group] = {
                "min": float(max(0, value - spread)),
                "max": float(min(1, value + spread)),
            }
        if index % 8 == 0:
            group_policy["bond"] = {
                "min": float(sum(anchor[:4])),
                "max": float(sum(anchor[:4])),
            }
        fixtures.append(
            {
                "assets": [
                    {"mu": float(means[i]), "vol": float(vols[i]), "group": groups[i]}
                    for i in range(size)
                ],
                "cov": covariance.tolist(),
                "rf": 1.5,
                "target": float(means @ anchor),
                "policy": {"bounds": bounds, "groups": group_policy},
                "start": anchor.tolist(),
            }
        )
    return fixtures


def read_node_results(fixtures):
    script = """
        import fs from 'node:fs';
        import { optimizeAllocation } from './dist/allocation.mjs';
        const fixtures = JSON.parse(fs.readFileSync(0, 'utf8'));
        const results = fixtures.map((fixture, index) => {
          try {
            return optimizeAllocation(fixture.assets, fixture.cov, fixture.rf,
              fixture.target, fixture.policy);
          } catch (error) {
            return { error: error.message, index };
          }
        });
        process.stdout.write(JSON.stringify(results));
    """
    completed = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        input=json.dumps(fixtures),
        text=True,
        capture_output=True,
        check=True,
        cwd=REPO_ROOT,
    )
    return json.loads(completed.stdout)


def check_feasibility(weights, matrix, lower, upper, bounds, label):
    assert np.all(np.isfinite(weights)), (label, "nonfinite weights")
    values = matrix @ weights
    assert np.all(values >= lower - FEASIBILITY_TOLERANCE), (label, "lower group bound")
    assert np.all(values <= upper + FEASIBILITY_TOLERANCE), (label, "upper group bound")
    assert np.all(weights >= bounds[:, 0] - FEASIBILITY_TOLERANCE), (label, "lower asset bound")
    assert np.all(weights <= bounds[:, 1] + FEASIBILITY_TOLERANCE), (label, "upper asset bound")


def main():
    fixtures = make_fixtures()
    results = read_node_results(fixtures)
    assert len(results) == len(fixtures), "Missing Node.js fixture results"
    maximum = {"minVol_variance": 0, "maxSharpe": 0, "target_variance": 0}
    checked = 0

    for index, (fixture, actual) in enumerate(zip(fixtures, results)):
        if "error" in actual:
            raise RuntimeError((index, actual))
        covariance = np.array(fixture["cov"])
        scale = np.max(np.diag(covariance))
        means = np.array([asset["mu"] for asset in fixture["assets"]])
        start = np.array(fixture["start"])
        matrix = [np.ones(len(start))]
        lower, upper = [1], [1]
        for group, band in fixture["policy"]["groups"].items():
            matrix.append(np.array([float(asset["group"] == group) for asset in fixture["assets"]]))
            lower.append(band["min"])
            upper.append(band["max"])
        matrix, lower, upper = np.array(matrix), np.array(lower), np.array(upper)
        bounds = np.array([(band["min"], band["max"]) for band in fixture["policy"]["bounds"]])
        equalities = [
            {"type": "eq", "fun": lambda w, a=a, b=b: a @ w - b, "jac": lambda w, a=a: a}
            for a, b, z in zip(matrix, lower, upper) if b == z
        ]
        inequalities = [
            {"type": "ineq", "fun": lambda w, a=a, b=b: a @ w - b, "jac": lambda w, a=a: a}
            for a, b, z in zip(matrix, lower, upper) if b != z
        ] + [
            {"type": "ineq", "fun": lambda w, a=a, z=z: z - a @ w, "jac": lambda w, a=a: -a}
            for a, b, z in zip(matrix, lower, upper) if b != z
        ]

        for kind in ["minVol", "maxSharpe", "target"]:
            if kind == "maxSharpe":
                objective = lambda w: -float((means @ w - fixture["rf"]) / np.sqrt(w @ covariance @ w))
                jacobian = lambda w: (
                    -means / np.sqrt(w @ covariance @ w)
                    + (means @ w - fixture["rf"]) * (covariance @ w) / (w @ covariance @ w) ** 1.5
                )
            else:
                objective = lambda w: float(w @ covariance @ w) / scale
                jacobian = lambda w: 2 * covariance @ w / scale
            constraints = equalities + inequalities
            if kind == "target":
                constraints += [{
                    "type": "eq",
                    "fun": lambda w: means @ w - fixture["target"],
                    "jac": lambda w: means,
                }]
            fit = minimize(
                objective, start, jac=jacobian, method="SLSQP", bounds=bounds,
                constraints=constraints, options={"ftol": 1e-13, "maxiter": 1000},
            )
            if not fit.success:
                raise RuntimeError((index, kind, fit.message))
            weights = np.array(actual[kind]["weights"])
            check_feasibility(weights, matrix, lower, upper, bounds, (index, kind, "Node.js"))
            check_feasibility(fit.x, matrix, lower, upper, bounds, (index, kind, "SciPy"))
            if kind == "target":
                assert abs(means @ weights - fixture["target"]) <= FEASIBILITY_TOLERANCE, (index, "Node.js target")
                assert abs(means @ fit.x - fixture["target"]) <= FEASIBILITY_TOLERANCE, (index, "SciPy target")
            delta = abs(objective(weights) - fit.fun) * (scale if kind != "maxSharpe" else 1)
            key = kind + ("_variance" if kind != "maxSharpe" else "")
            maximum[key] = max(maximum[key], delta)
            assert delta <= OBJECTIVE_TOLERANCE, (index, kind, delta)

        for point in actual["frontier"]:
            check_feasibility(np.array(point["weights"]), matrix, lower, upper, bounds, (index, "frontier"))
        checked += 1

    print(json.dumps({
        "fixtures": checked,
        "independent_scipy_comparisons": checked * 3,
        "max_objective_abs_error": maximum,
    }, indent=2))


if __name__ == "__main__":
    main()
