import test from 'node:test';
import assert from 'node:assert/strict';
import { covariance, stats, optimize, validateInputs } from '../dist/portfolio.mjs';

const close = (actual, expected, tolerance = 1e-8) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `actual ${actual}, expected ${expected}, tolerance ${tolerance}`);
const total = (values) => values.reduce((acc, value) => acc + value, 0);
const identity = (n) => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => +(i === j)));
const assets = [
  { id: 'A', name: 'A', mu: 4, vol: 5, weight: 0.5 },
  { id: 'B', name: 'B', mu: 8, vol: 15, weight: 0.5 },
];
const correlation = [[1, 0.2], [0.2, 1]];
const cov = covariance(assets, correlation);

test('covariance and stats preserve annual percentage-point units', () => {
  assert.deepEqual(cov, [[25, 15], [15, 225]]);
  const actual = stats([0.5, 0.5], assets, cov, 2);
  close(actual.mu, 6);
  close(actual.vol, Math.sqrt(70));
  close(actual.sharpe, 4 / Math.sqrt(70));
  close(actual.riskShares[0], 1 / 7);
  close(actual.riskShares[1], 6 / 7);
  close(total(actual.riskContributions), actual.vol);
  close(total(actual.riskShares), 1);
  close(actual.mu - 1.959963984540054 * actual.vol, -10.39823519311114);
  close(actual.mu + 1.959963984540054 * actual.vol, 22.39823519311114);
});

test('two-asset minimum variance matches the independent scalar formula', () => {
  const result = optimize(assets, cov, 2, 6);
  const weightA = (225 - 15) / (25 + 225 - 2 * 15);
  close(result.minVol.weights[0], weightA);
  close(result.minVol.weights[1], 1 - weightA);
  close(result.minVol.mu, 4.181818181818182);
  close(result.minVol.vol, 4.954336943068624);
});

test('two-asset tangency portfolio and target match analytical solutions', () => {
  const result = optimize(assets, cov, 2, 6);
  close(result.maxSharpe.weights[0], 0.75);
  close(result.maxSharpe.weights[1], 0.25);
  close(result.maxSharpe.mu, 5);
  close(result.maxSharpe.vol, Math.sqrt(33.75));
  close(result.maxSharpe.sharpe, 0.5163977794943223);
  close(result.maxSharpe.riskShares[0], 0.5);
  close(result.maxSharpe.riskShares[1], 0.5);
  close(result.target.weights[0], (8 - 6) / (8 - 4));
  close(result.target.weights[1], 0.5);
});

test('frontier covers only the upper efficient arm and has correct endpoints', () => {
  const result = optimize(assets, cov, 2, 6);
  assert.equal(result.frontier.length, 65);
  assert.deepEqual(result.frontier[0], result.minVol);
  const last = result.frontier.at(-1);
  close(last.mu, 8);
  close(last.weights[1], 1);
  for (let i = 0; i < result.frontier.length; i += 1) {
    const point = result.frontier[i];
    close(total(point.weights), 1);
    assert.ok(point.weights.every((value) => value >= 0));
    if (i) {
      assert.ok(point.mu >= result.frontier[i - 1].mu - 1e-9);
      assert.ok(point.vol >= result.frontier[i - 1].vol - 1e-9);
    }
  }
});

test('infeasible and omitted targets return null without replacing the target', () => {
  assert.equal(optimize(assets, cov, 2, 9).target, null);
  assert.equal(optimize(assets, cov, 2, 3).target, null);
  assert.equal(optimize(assets, cov, 2).target, null);
  close(optimize(assets, cov, 2, 4).target.weights[0], 1);
  close(optimize(assets, cov, 2, 8).target.weights[1], 1);
});

test('long-only boundary excludes negative unconstrained tangency weights', () => {
  const boundaryAssets = [{ mu: 2, vol: 5 }, { mu: 8, vol: 15 }];
  const boundaryCov = covariance(boundaryAssets, [[1, 0.8], [0.8, 1]]);
  const result = optimize(boundaryAssets, boundaryCov, 2, 5);
  assert.deepEqual(result.minVol.weights, [1, 0]);
  assert.deepEqual(result.maxSharpe.weights, [0, 1]);
  close(result.target.weights[0], 0.5);
});

test('all nonpositive excess returns choose the best single-asset Sharpe', () => {
  const result = optimize(assets, cov, 10, 6);
  assert.deepEqual(result.maxSharpe.weights, [0, 1]);
  close(result.maxSharpe.sharpe, -2 / 15);
  const zero = optimize(assets, cov, 8);
  close(zero.maxSharpe.sharpe, 0);
  assert.deepEqual(zero.maxSharpe.weights, [0, 1]);
});

test('six equal-mean independent assets have inverse-variance minimum weights', () => {
  const six = [5, 7, 10, 12, 15, 20].map((vol, i) => ({ id: String(i), mu: 6, vol }));
  const sixCov = covariance(six, identity(6));
  const expected = six.map((asset) => 1 / asset.vol ** 2);
  const normalizer = total(expected);
  const result = optimize(six, sixCov, 2, 6);
  expected.forEach((value, i) => close(result.minVol.weights[i], value / normalizer));
  close(result.minVol.vol, Math.sqrt(1 / normalizer));
  close(result.target.vol, result.minVol.vol);
  close(result.maxSharpe.vol, result.minVol.vol);
  assert.equal(result.frontier.length, 1);
  assert.equal(optimize(six, sixCov, 2, 6.1).target, null);
});

test('multiple highest-return assets share the frontier endpoint by minimum variance', () => {
  const three = [{ mu: 4, vol: 10 }, { mu: 8, vol: 10 }, { mu: 8, vol: 20 }];
  const result = optimize(three, covariance(three, identity(3)), 2, 8);
  close(result.target.weights[0], 0);
  close(result.target.weights[1], 0.8);
  close(result.target.weights[2], 0.2);
  close(result.frontier.at(-1).vol, Math.sqrt(80));
});

test('risk contributions retain negative diversification contributions', () => {
  const two = [{ mu: 4, vol: 10 }, { mu: 8, vol: 20 }];
  const actual = stats([0.9, 0.1], two, covariance(two, [[1, -0.9], [-0.9, 1]]), 2);
  assert.ok(actual.riskContributions[1] < 0);
  close(actual.riskShares[1], -12.2 / 52.6);
  close(total(actual.riskShares), 1);
  close(total(actual.riskContributions), actual.vol);
});

test('three-asset optimum dominates independent coarse simplex enumeration', () => {
  const three = [{ mu: 3, vol: 7 }, { mu: 7, vol: 12 }, { mu: 10, vol: 20 }];
  const threeCov = covariance(three, [[1, 0.15, -0.1], [0.15, 1, 0.4], [-0.1, 0.4, 1]]);
  const result = optimize(three, threeCov, 2, 7);
  for (let a = 0; a <= 50; a += 1) {
    for (let b = 0; b <= 50 - a; b += 1) {
      const w = [a / 50, b / 50, (50 - a - b) / 50];
      const mu = total(w.map((value, i) => value * three[i].mu));
      let variance = 0;
      for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) variance += w[i] * w[j] * threeCov[i][j];
      const vol = Math.sqrt(variance);
      assert.ok(result.minVol.vol <= vol + 1e-8);
      assert.ok(result.maxSharpe.sharpe >= (mu - 2) / vol - 1e-8);
      if (Math.abs(mu - 7) < 1e-9) assert.ok(result.target.vol <= vol + 1e-8);
    }
  }
});

test('return centering protects closely spaced, high-level expected returns', () => {
  const two = [{ mu: 100, vol: 5 }, { mu: 100.001, vol: 15 }];
  const result = optimize(two, covariance(two, correlation), 99, 100.0005);
  close(result.target.weights[0], 0.5, 1e-7);
  close(result.target.mu, 100.0005);
});

test('singular and indefinite correlation matrices are rejected without repair', () => {
  assert.throws(() => covariance(assets, [[1, 1], [1, 1]]), /양의 정부호|특이/);
  const three = [...assets, { mu: 6, vol: 10 }];
  assert.throws(() => covariance(three, [[1, 0.9, 0.9], [0.9, 1, -0.9], [0.9, -0.9, 1]]), /양의 정부호|특이/);
  assert.throws(() => covariance(assets, [[1, 0.2], [0.3, 1]]), /대칭/);
  assert.throws(() => covariance(assets, [[1, 1.1], [1.1, 1]]), /-1부터 1/);
});

test('malformed inputs, invalid portfolio sums, and covariance unit errors fail explicitly', () => {
  assert.equal(validateInputs(assets, correlation), true);
  assert.throws(() => stats([0.4, 0.4], assets, cov, 2), /100%/);
  assert.throws(() => stats([-0.1, 1.1], assets, cov, 2), /0부터 1/);
  assert.throws(() => stats([0.5, 0.5], assets, [[0.0025, 0.0015], [0.0015, 0.0225]], 2), /단위/);
  assert.throws(() => covariance([{ mu: 4, vol: 0 }, assets[1]], correlation), /0보다/);
  assert.throws(() => optimize(assets, cov, NaN), /유한한/);
  assert.throws(() => optimize(assets, cov, 2, Infinity), /유한한/);
  assert.throws(() => covariance([assets[0]], [[1]]), /2개 이상/);
  assert.throws(() => covariance(Array(9).fill(assets[0]), identity(9)), /8개 이하/);
});

test('eight assets are supported and repeated calls are deterministic without mutation', () => {
  const eight = Array.from({ length: 8 }, (_, i) => ({ id: String(i), mu: 3 + i, vol: 5 + 2 * i }));
  const eightCov = covariance(eight, identity(8));
  const original = JSON.stringify({ eight, eightCov });
  const first = optimize(eight, eightCov, 2, 6);
  const second = optimize(eight, eightCov, 2, 6);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify({ eight, eightCov }), original);
  close(first.target.mu, 6);
  close(total(first.target.weights), 1);
  assert.ok(first.target.weights.every((value) => value >= 0));
});
