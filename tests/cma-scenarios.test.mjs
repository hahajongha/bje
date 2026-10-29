import test from 'node:test';
import assert from 'node:assert/strict';
import { covariance, stats, optimize } from '../dist/portfolio.mjs';
import { SCENARIOS, createScenarios, aggregateScenarios, remapScenarios } from '../dist/cma-scenarios.mjs';

const base = [{ id: 'A', name: 'A', mu: 5, vol: 10, weight: .6 }, { id: 'B', name: 'B', mu: 3, vol: 5, weight: .4 }];
const correlation = [[1, .25], [.25, 1]];
const close = (actual, expected, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const fixture = () => [
  { id: 'optimistic', probability: .2, assets: [{ mu: 10, vol: 8 }, { mu: 6, vol: 4 }] },
  { id: 'neutral', probability: .5, assets: [{ mu: 5, vol: 10 }, { mu: 3, vol: 5 }] },
  { id: 'pessimistic', probability: .3, assets: [{ mu: -5, vol: 15 }, { mu: 1, vol: 7 }] },
];

test('initial scenarios preserve existing moments and allocate 100% to neutral', () => {
  const scenarios = createScenarios(base);
  assert.deepEqual(scenarios.map(s => s.id), SCENARIOS.map(s => s.id));
  assert.deepEqual(scenarios.map(s => s.probability), [0, 1, 0]);
  for (const scenario of scenarios) assert.deepEqual(scenario.assets, base.map(({ mu, vol }) => ({ mu, vol })));
  assert.deepEqual(aggregateScenarios(base, correlation, scenarios), { assets: base, covariance: covariance(base, correlation) });
  scenarios[0].assets[0].mu = 40;
  assert.equal(scenarios[1].assets[0].mu, 5);
  assert.equal(base[0].mu, 5);
});

test('total covariance matches independently calculated two-asset example', () => {
  const source = fixture(), original = structuredClone(source);
  const result = aggregateScenarios(base, correlation, source);
  close(result.assets[0].mu, 3);
  close(result.assets[1].mu, 3);
  close(result.covariance[0][0], 161.3);
  close(result.covariance[0][1], 24.725);
  close(result.covariance[1][1], 33.4);
  assert.equal(result.covariance[0][1], result.covariance[1][0]);
  const portfolio = stats([.6, .4], result.assets, result.covariance, 0);
  close(portfolio.mu, 3);
  close(portfolio.vol, Math.sqrt(75.28));
  const incorrectlyReusedCorrelation = covariance(result.assets, correlation);
  assert.ok(Math.abs(incorrectlyReusedCorrelation[0][1] - result.covariance[0][1]) > 1);
  assert.deepEqual(source, original);
  assert.equal(result.assets[0].weight, .6);
  assert.ok(optimize(result.assets, result.covariance, 0).minVol);
});

test('100% probability recovers each conditional distribution exactly', () => {
  for (let s = 0; s < 3; s += 1) {
    const scenarios = fixture();
    scenarios.forEach((scenario, i) => { scenario.probability = +(s === i); });
    const result = aggregateScenarios(base, correlation, scenarios);
    assert.deepEqual(result.assets.map(({ mu, vol }) => ({ mu, vol })), scenarios[s].assets);
    assert.deepEqual(result.covariance, covariance(scenarios[s].assets, correlation));
  }
});

test('identical scenarios have no between-scenario risk regardless of probabilities', () => {
  const scenarios = createScenarios(base);
  scenarios.forEach((scenario, s) => { scenario.probability = [.2, .5, .3][s]; });
  assert.deepEqual(aggregateScenarios(base, correlation, scenarios), { assets: base, covariance: covariance(base, correlation) });
});

test('opposite scenario mean movements contribute negative cross-asset covariance', () => {
  const scenarios = createScenarios(base);
  scenarios[0].probability = scenarios[2].probability = .5;
  scenarios[1].probability = 0;
  scenarios[0].assets = [{ mu: 10, vol: 1 }, { mu: -10, vol: 1 }];
  scenarios[2].assets = [{ mu: -10, vol: 1 }, { mu: 10, vol: 1 }];
  const result = aggregateScenarios(base, [[1, 0], [0, 1]], scenarios);
  assert.deepEqual(result.covariance, [[101, -100], [-100, 101]]);
  close(stats([.5, .5], result.assets, result.covariance).vol, Math.sqrt(.5));
});

test('invalid probabilities and totals are rejected without implicit normalization', () => {
  for (const value of [-.1, 1.1, NaN, Infinity, '0.2', null]) {
    const scenarios = fixture(); scenarios[0].probability = value;
    assert.throws(() => aggregateScenarios(base, correlation, scenarios), /확률/);
  }
  for (const probabilities of [[0, 0, 0], [.1, .5, .3], [.3, .5, .3]]) {
    const scenarios = fixture(); scenarios.forEach((s, i) => { s.probability = probabilities[i]; });
    assert.throws(() => aggregateScenarios(base, correlation, scenarios), /합계/);
  }
});

test('scenario IDs, order, number and asset dimensions must match', () => {
  for (const edit of [
    s => s.pop(), s => s.reverse(), s => { s[0].id = 'unexpected'; },
    s => { s[0].assets.pop(); }, s => { s[1] = null; },
  ]) {
    const scenarios = fixture(); edit(scenarios);
    assert.throws(() => aggregateScenarios(base, correlation, scenarios), /시나리오/);
  }
});

test('invalid moments are rejected even in zero-probability scenarios', () => {
  for (const [key, value] of [['mu', NaN], ['mu', Infinity], ['mu', '5'], ['vol', 0], ['vol', -1], ['vol', Infinity]]) {
    const scenarios = createScenarios(base); scenarios[0].assets[0][key] = value;
    assert.throws(() => aggregateScenarios(base, correlation, scenarios));
  }
  assert.throws(() => aggregateScenarios(base, [[1, 1], [1, 1]], fixture()), /정부호/);
  const overflow = fixture(); overflow[0].assets[0].vol = 1e200;
  assert.throws(() => aggregateScenarios(base, correlation, overflow));
});

test('affine remapping matches TAA target moments and transforms covariance consistently', () => {
  const scenarios = fixture(), original = structuredClone(scenarios);
  const current = aggregateScenarios(base, correlation, scenarios);
  const target = current.assets.map((asset, i) => ({ ...asset, mu: i === 0 ? -4 : 9, vol: asset.vol * (i === 0 ? 2 : .5) }));
  const remapped = remapScenarios(scenarios, current.assets, target);
  const result = aggregateScenarios(base, correlation, remapped);
  result.assets.forEach((asset, i) => { close(asset.mu, target[i].mu); close(asset.vol, target[i].vol); });
  close(result.covariance[0][0], current.covariance[0][0] * 4);
  close(result.covariance[1][1], current.covariance[1][1] * .25);
  close(result.covariance[0][1], current.covariance[0][1]);
  assert.deepEqual(remapped.map(s => s.probability), scenarios.map(s => s.probability));
  assert.deepEqual(scenarios, original);
});

test('unchanged TAA moments preserve exact scenario numbers and reject invalid targets', () => {
  const scenarios = fixture();
  scenarios[0].assets[0].mu = 10.1234567890123;
  const current = aggregateScenarios(base, correlation, scenarios);
  assert.deepEqual(remapScenarios(scenarios, current.assets, current.assets), scenarios);
  const target = structuredClone(current.assets); target[0].vol = 0;
  assert.throws(() => remapScenarios(scenarios, current.assets, target));
  assert.throws(() => remapScenarios(scenarios, current.assets, current.assets.slice(0, 1)));
});
