import test from 'node:test';
import assert from 'node:assert/strict';
import { covariance, stats } from '../dist/portfolio.mjs';
import { defaultPolicy, optimizeAllocation, satisfiesPolicy } from '../dist/allocation.mjs';
import { frontierTarget } from '../dist/frontier-target.mjs';

const close = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const sum = (values) => values.reduce((total, value) => total + value, 0);
const assets = [{ mu: 4, vol: 5, group: 'bond' }, { mu: 8, vol: 15, group: 'equity' }];
const cov = covariance(assets, [[1, 0.2], [0.2, 1]]);
const policy = defaultPolicy(assets);
const optimized = optimizeAllocation(assets, cov, 2, null, policy);
const run = (weights, options = {}) => frontierTarget({ selected: stats(weights, assets, cov, 2), assets, cov, rf: 2, policy, optimized, ...options });

function identities(result, selected, fixture = { assets, cov, policy }) {
  assert.ok(result.target, result.condition);
  const { target, deltas } = result;
  close(sum(target.weights), 1);
  close(sum(deltas), 0);
  target.weights.forEach((weight, i) => close(weight, selected.weights[i] + deltas[i]));
  assert.ok(satisfiesPolicy(target.weights, fixture.assets, fixture.policy));
  const recomputed = stats(target.weights, fixture.assets, fixture.cov, 2);
  close(target.mu, recomputed.mu);
  close(target.vol, recomputed.vol);
  assert.ok(target.mu >= selected.mu - 1e-7);
  assert.ok(target.vol <= selected.vol + 1e-7);
}

test('same-risk solves the upper root analytically, not a nearby frontier sample', () => {
  const selected = stats([1, 0], assets, cov, 2);
  const result = run(selected.weights);
  identities(result, selected);
  // For equity weight x, variance is 25 - 20x + 220x². At 5% vol,
  // the upper-return root is x=1/11, rather than the selected lower root x=0.
  close(result.target.weights[1], 1 / 11);
  close(result.target.mu, 4 + 4 / 11);
  close(result.target.vol, 5);
  assert.equal(result.status, 'matched');
  assert.ok(optimized.frontier.every((point) => Math.abs(point.mu - result.target.mu) > 1e-5));
});

test('same-return below GMV selects the efficient GMV, not the lower arm', () => {
  const selected = stats([1, 0], assets, cov, 2);
  const result = run(selected.weights, { mode: 'same-return' });
  identities(result, selected);
  close(result.target.weights[0], 21 / 22);
  assert.equal(result.status, 'gmv-floor');
  assert.ok(result.condition.length);
});

test('same-risk remains accurate close to the flat GMV boundary', () => {
  const distance = 1e-6;
  const lowerEquityWeight = 1 / 22 - distance;
  const selected = stats([1 - lowerEquityWeight, lowerEquityWeight], assets, cov, 2);
  const result = run(selected.weights);
  identities(result, selected);
  close(result.target.weights[1], 1 / 22 + distance, 1e-8);
});

test('efficient choices, fixed portfolios and repeated frontier points are stable', () => {
  const result = run([0.5, 0.5]);
  assert.equal(result.status, 'already-efficient');
  result.deltas.forEach((value) => close(value, 0));
  const duplicated = { ...optimized, frontier: optimized.frontier.flatMap((point) => [point, point]) };
  close(run([1, 0], { optimized: duplicated }).target.weights[1], 1 / 11);
  const fixed = defaultPolicy(assets);
  fixed.bounds = [{ min: 0.3, max: 0.3 }, { min: 0.7, max: 0.7 }];
  const fixedResult = run([0.3, 0.7], { policy: fixed, optimized: null });
  assert.equal(fixedResult.status, 'already-efficient');
  fixedResult.deltas.forEach((value) => close(value, 0));
});

test('SAA risk floor and return ceiling expose unavailable comparisons', () => {
  const tight = defaultPolicy(assets);
  tight.bounds[0] = { min: 0.5, max: 0.5 };
  const riskFloor = run([1, 0], { policy: tight, optimized: null });
  assert.equal(riskFloor.target, null);
  assert.equal(riskFloor.deltas, null);
  assert.equal(riskFloor.status, 'infeasible');
  assert.match(riskFloor.condition, /최소 변동성/);
  const returnCeiling = run([0, 1], { policy: tight, optimized: null, mode: 'same-return' });
  assert.equal(returnCeiling.target, null);
  assert.match(returnCeiling.condition, /최대 기대수익/);
});

test('a source outside SAA never receives a non-dominating destination', () => {
  const tight = defaultPolicy(assets);
  tight.bounds[0] = { min: 0.5, max: 0.5 };
  const result = run([1, 0], { policy: tight, optimized: null, mode: 'same-return' });
  assert.equal(result.status, 'non-dominating');
  assert.equal(result.target, null);
  assert.match(result.condition, /SAA/);
});

test('equal expected returns use minimum variance at the maximum-return boundary', () => {
  const equal = [{ mu: 5, vol: 5, group: 'bond' }, { mu: 5, vol: 10, group: 'equity' }];
  const matrix = covariance(equal, [[1, 0], [0, 1]]);
  const selected = stats([0, 1], equal, matrix, 2);
  const fixture = { assets: equal, cov: matrix, policy: defaultPolicy(equal) };
  const result = frontierTarget({ ...fixture, selected, rf: 2 });
  identities(result, selected, fixture);
  close(result.target.weights[0], 0.8);
  assert.equal(result.status, 'return-ceiling');
});

test('three-asset exact destinations dominate independent feasible-grid competitors', () => {
  const a = [{ mu: 3, vol: 7, group: 'bond' }, { mu: 7, vol: 12, group: 'bond' }, { mu: 10, vol: 20, group: 'equity' }];
  const c = covariance(a, [[1, 0.15, -0.1], [0.15, 1, 0.4], [-0.1, 0.4, 1]]);
  const p = defaultPolicy(a);
  p.groups.bond = { min: 0.6, max: 0.85 };
  p.bounds[1] = { min: 0.1, max: 0.5 };
  const selected = stats([0.2, 0.4, 0.4], a, c, 2);
  const fixture = { assets: a, cov: c, policy: p };
  const baseline = optimizeAllocation(a, c, 2, null, p);
  const risk = frontierTarget({ ...fixture, selected, optimized: baseline, rf: 2 });
  const returns = frontierTarget({ ...fixture, selected, optimized: baseline, rf: 2, mode: 'same-return' });
  identities(risk, selected, fixture);
  identities(returns, selected, fixture);
  close(risk.target.vol, selected.vol, 1e-6);
  close(returns.target.mu, selected.mu);
  for (let i = 0; i <= 200; i += 1) for (let j = 20; j <= 100; j += 1) {
    const x = i / 200, y = j / 200, z = 1 - x - y;
    if (z < -1e-12 || x + y < 0.6 - 1e-12 || x + y > 0.85 + 1e-12) continue;
    const variance = 49 * x * x + 144 * y * y + 400 * z * z + 25.2 * x * y - 28 * x * z + 192 * y * z;
    const mu = 3 * x + 7 * y + 10 * z;
    if (variance <= selected.vol ** 2 + 1e-10) assert.ok(mu <= risk.target.mu + 1e-6);
    if (mu >= selected.mu - 1e-10) assert.ok(Math.sqrt(variance) >= returns.target.vol - 1e-7);
  }
});

test('cached results are reused but CMA/SAA changes invalidate stale optimizer context', () => {
  const first = run([1, 0]);
  assert.equal(run([1, 0]), first);
  const isolated = { ...optimized };
  run([1, 0], { optimized: isolated });
  const changed = defaultPolicy(assets);
  changed.bounds[0] = { min: 0.5, max: 0.5 };
  assert.equal(run([1, 0], { policy: changed, optimized: isolated }).target, null);
});

test('selected weights are authoritative and invalid inputs are rejected', () => {
  const selected = { ...stats([1, 0], assets, cov, 2), mu: 1000, vol: 1000 };
  close(run([1, 0], { selected }).target.weights[1], 1 / 11);
  assert.throws(() => run([1, 0], { mode: 'nearest' }), RangeError);
  assert.throws(() => run([1, 0], { selected: { weights: [0.1, 0.1] } }), RangeError);
});
