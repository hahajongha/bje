import test from 'node:test';
import assert from 'node:assert/strict';
import { covariance, optimize, stats } from '../dist/portfolio.mjs';
import { defaultPolicy, validatePolicy, satisfiesPolicy, optimizeAllocation, samplePortfolios } from '../dist/allocation.mjs';

const close = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const identity = (n) => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => +(i === j)));
const two = [{ mu: 4, vol: 5, group: 'bond' }, { mu: 8, vol: 15, group: 'equity' }];
const twoCov = covariance(two, [[1, 0.2], [0.2, 1]]);

test('unrestricted allocation preserves the original analytic optimizer', () => {
  const expected = optimize(two, twoCov, 2, 6);
  const actual = optimizeAllocation(two, twoCov, 2, 6, defaultPolicy(two));
  assert.deepEqual(actual, { ...expected, returnRange: [4, 8] });
});

test('two-asset boxes clamp analytic minimum and tangency portfolios', () => {
  const policy = defaultPolicy(two);
  policy.bounds[0] = { min: 0.1, max: 0.6 };
  const actual = optimizeAllocation(two, twoCov, 2, 6, policy);
  close(actual.minVol.weights[0], 0.6);
  close(actual.maxSharpe.weights[0], 0.6);
  close(actual.target.weights[0], 0.5);
  actual.returnRange.forEach((value, i) => close(value, [5.6, 7.6][i]));
  assert.equal(optimizeAllocation(two, twoCov, 2, 5, policy).target, null);
  actual.frontier.forEach((point) => assert.ok(satisfiesPolicy(point.weights, two, policy)));
});

test('positive Sharpe finds the interior tangency under nonbinding group bounds', () => {
  const policy = defaultPolicy(two);
  policy.groups.bond.min = 0.2;
  policy.groups.equity.max = 0.8;
  const actual = optimizeAllocation(two, twoCov, 2, 6, policy);
  close(actual.minVol.weights[0], 210 / 220);
  close(actual.maxSharpe.weights[0], 0.75, 2e-7);
  close(actual.maxSharpe.sharpe, 0.5163977794943223);
  close(actual.target.weights[0], 0.5);
});

test('joint group and asset infeasibility is rejected before optimization', () => {
  const policy = defaultPolicy(two);
  policy.groups.bond.min = 0.7;
  policy.groups.equity.min = 0.4;
  assert.throws(() => validatePolicy(two, policy), RangeError);
  policy.groups.equity.min = 0;
  policy.bounds[0].max = 0.6;
  assert.throws(() => validatePolicy(two, policy), RangeError);
  policy.bounds[0].max = 1;
  policy.groups.alternative.min = 0.1;
  assert.throws(() => validatePolicy(two, policy), RangeError);
});

test('fixed group allocation recovers inverse-variance solution within groups', () => {
  const assets = [{ mu: 5, vol: 5, group: 'bond' }, { mu: 5, vol: 10, group: 'bond' }, { mu: 8, vol: 20, group: 'equity' }];
  const cov = covariance(assets, identity(3));
  const policy = defaultPolicy(assets);
  policy.groups.bond = { min: 0.6, max: 0.6 };
  const actual = optimizeAllocation(assets, cov, 2, 6.2, policy);
  [0.48, 0.12, 0.4].forEach((value, i) => close(actual.minVol.weights[i], value));
  close(actual.maxSharpe.vol, actual.minVol.vol);
  close(actual.target.mu, 6.2);
  assert.equal(actual.frontier.length, 1);
  assert.equal(optimizeAllocation(assets, cov, 2, 6.21, policy).target, null);
});

test('fully fixed portfolios and their deterministic cloud remain feasible', () => {
  const policy = defaultPolicy(two);
  policy.bounds = [{ min: 0.3, max: 0.3 }, { min: 0.7, max: 0.7 }];
  const actual = optimizeAllocation(two, twoCov, 10, 6.8, policy);
  actual.minVol.weights.forEach((value, i) => close(value, [0.3, 0.7][i]));
  assert.equal(actual.frontier.length, 1);
  const cloud = samplePortfolios(two, twoCov, 2, policy, { count: 40 });
  assert.equal(cloud.length, 1);
  cloud.forEach((point) => assert.ok(satisfiesPolicy(point.weights, two, policy)));
});

test('nonpositive Sharpe compares constrained vertices, including mixed vertices', () => {
  const policy = defaultPolicy(two);
  policy.bounds[0] = { min: 0.2, max: 0.8 };
  const actual = optimizeAllocation(two, twoCov, 10, 6, policy);
  const endpoints = [stats([0.2, 0.8], two, twoCov, 10), stats([0.8, 0.2], two, twoCov, 10)];
  close(actual.maxSharpe.sharpe, Math.max(...endpoints.map((point) => point.sharpe)));
  close(actual.maxSharpe.weights[0], 0.2);
});

test('three-asset constrained optima dominate an independent dense simplex grid', () => {
  const assets = [{ mu: 3, vol: 7, group: 'bond' }, { mu: 7, vol: 12, group: 'bond' }, { mu: 10, vol: 20, group: 'equity' }];
  const cov = covariance(assets, [[1, 0.15, -0.1], [0.15, 1, 0.4], [-0.1, 0.4, 1]]);
  const policy = defaultPolicy(assets);
  policy.groups.bond = { min: 0.6, max: 0.85 };
  policy.bounds[1] = { min: 0.1, max: 0.5 };
  const actual = optimizeAllocation(assets, cov, 2, 6, policy);
  let minVariance = Infinity;
  let bestSharpe = -Infinity;
  let targetVariance = Infinity;
  // Independent loops, direct formulas and explicit restrictions, not the solver's helpers.
  for (let a = 0; a <= 200; a += 1) for (let b = 20; b <= 100; b += 1) {
    const x = a / 200, y = b / 200, z = 1 - x - y;
    if (z < -1e-12 || x + y < 0.6 - 1e-12 || x + y > 0.85 + 1e-12) continue;
    const variance = 49 * x * x + 144 * y * y + 400 * z * z + 25.2 * x * y - 28 * x * z + 192 * y * z;
    const mu = 3 * x + 7 * y + 10 * z;
    minVariance = Math.min(minVariance, variance);
    bestSharpe = Math.max(bestSharpe, (mu - 2) / Math.sqrt(variance));
    if (Math.abs(mu - 6) < 1e-10) targetVariance = Math.min(targetVariance, variance);
  }
  assert.ok(actual.minVol.vol ** 2 <= minVariance + 1e-8);
  assert.ok(actual.maxSharpe.sharpe >= bestSharpe - 1e-8);
  assert.ok(actual.target.vol ** 2 <= targetVariance + 1e-8);
  assert.ok(minVariance - actual.minVol.vol ** 2 < 0.1);
  assert.ok(actual.maxSharpe.sharpe - bestSharpe < 0.001);
  close(actual.target.mu, 6);
});

test('seven-asset clouds are deterministic, diversified, and obey tight SAA bands', () => {
  const assets = Array.from({ length: 7 }, (_, i) => ({ mu: 3 + i, vol: 5 + i * 2, group: i < 4 ? 'bond' : i < 6 ? 'equity' : 'alternative' }));
  const cov = covariance(assets, identity(7));
  const policy = defaultPolicy(assets);
  policy.groups.bond = { min: 0.7, max: 0.85 };
  policy.groups.equity.max = 0.2;
  policy.groups.alternative.max = 0.1;
  policy.bounds[0] = { min: 0.15, max: 0.4 };
  const cloud = samplePortfolios(assets, cov, 2, policy, { count: 2400, seed: 42 });
  assert.deepEqual(cloud, samplePortfolios(assets, cov, 2, policy, { count: 2400, seed: 42 }));
  assert.equal(cloud.length, 2400);
  cloud.forEach((point) => assert.ok(satisfiesPolicy(point.weights, assets, policy)));
  assert.ok(new Set(cloud.map((point) => point.weights.map((x) => x.toFixed(5)).join(','))).size > 2000);
  assert.ok(cloud.some((point) => point.weights.filter((x) => x < 1e-10).length >= 3));
  const actual = optimizeAllocation(assets, cov, 2, 4.5, policy);
  [...actual.frontier, actual.minVol, actual.maxSharpe, actual.target].filter(Boolean)
    .forEach((point) => assert.ok(satisfiesPolicy(point.weights, assets, policy)));
  cloud.forEach((point) => assert.ok(point.sharpe <= actual.maxSharpe.sharpe + 1e-7));
});

test('unclassified assets receive box constraints but no named group allocation', () => {
  const assets = [{ mu: 4, vol: 5, group: 'bond' }, { mu: 8, vol: 15 }];
  const policy = defaultPolicy(assets);
  policy.groups.bond.min = 0.6;
  assert.ok(validatePolicy(assets, policy));
  const actual = optimizeAllocation(assets, twoCov, 2, 6, policy);
  assert.ok(satisfiesPolicy(actual.maxSharpe.weights, assets, policy));
  assert.equal(actual.target, null);
  close(actual.returnRange[1], 5.6);
});
