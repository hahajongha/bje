/**
 * SAA-constrained allocation and a reproducible illustrative portfolio cloud.
 * Returns, volatilities and rf are annual percentage points; bounds are fractions.
 * The cloud is not a probability distribution or an optimizer.
 */
import { optimize, stats } from './portfolio.mjs';

const GROUPS = ['bond', 'equity', 'alternative'];
const TOL = 1e-9;
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const total = (a) => a.reduce((s, x) => s + x, 0);
const row = (n, i) => Array.from({ length: n }, (_, j) => +(i === j));

export function defaultPolicy(assets) {
  return {
    groups: Object.fromEntries(GROUPS.map((name) => [name, { min: 0, max: 1 }])),
    bounds: assets.map(() => ({ min: 0, max: 1 })),
  };
}

function band(value, label) {
  if (!value || !Number.isFinite(value.min) || !Number.isFinite(value.max) ||
      value.min < 0 || value.max > 1 || value.min > value.max) {
    throw new RangeError(`${label}: 최소·최대 비중은 0~100%이며 최소가 최대보다 클 수 없습니다.`);
  }
}

function buckets(assets, policy) {
  return [...GROUPS, 'unclassified'].map((name) => {
    const indices = assets.map((asset, i) => ({ asset, i }))
      .filter(({ asset }) => name === 'unclassified' ? !GROUPS.includes(asset.group) : asset.group === name)
      .map(({ i }) => i);
    const range = policy.groups[name] || { min: 0, max: 1 };
    return {
      name, indices,
      min: Math.max(range.min, total(indices.map((i) => policy.bounds[i].min))),
      max: Math.min(range.max, total(indices.map((i) => policy.bounds[i].max))),
    };
  });
}

/** Throws on malformed or jointly infeasible constraints, including empty groups. */
export function validatePolicy(assets, policy = defaultPolicy(assets)) {
  if (!Array.isArray(assets) || assets.length < 2 || assets.length > 8) {
    throw new RangeError('자산은 2개 이상 8개 이하이어야 합니다.');
  }
  if (!policy || !policy.groups || !Array.isArray(policy.bounds) || policy.bounds.length !== assets.length) {
    throw new RangeError('SAA 자산별 비중 범위를 확인하세요.');
  }
  GROUPS.forEach((name) => band(policy.groups[name], `${name} 그룹`));
  policy.bounds.forEach((value, i) => band(value, `자산 ${i + 1}`));
  const sets = buckets(assets, policy);
  if (sets.some((set) => set.min > set.max + TOL) ||
      total(sets.map((set) => set.min)) > 1 + TOL ||
      total(sets.map((set) => set.max)) < 1 - TOL) {
    throw new RangeError('SAA 제약을 동시에 만족하며 비중 합계 100%를 구성할 수 없습니다.');
  }
  return true;
}

export function satisfiesPolicy(weights, assets, policy = defaultPolicy(assets), tol = 1e-7) {
  if (!Array.isArray(weights) || weights.length !== assets.length ||
      weights.some((x) => !Number.isFinite(x)) || Math.abs(total(weights) - 1) > tol) return false;
  if (weights.some((x, i) => x < policy.bounds[i].min - tol || x > policy.bounds[i].max + tol)) return false;
  return GROUPS.every((name) => {
    const weight = total(weights.filter((_, i) => assets[i].group === name));
    return weight >= policy.groups[name].min - tol && weight <= policy.groups[name].max + tol;
  });
}

function unrestricted(policy) {
  return [...Object.values(policy.groups), ...policy.bounds].every((value) => value.min === 0 && value.max === 1);
}

// Disjoint group bands and boxes permit an exact greedy linear optimizer:
// satisfy each group's minimum at its best assets, then fill globally by score.
function linearAllocation(assets, policy, scores) {
  const sets = buckets(assets, policy);
  const weights = policy.bounds.map((value) => value.min);
  const order = assets.map((_, i) => i).sort((a, b) => scores[b] - scores[a] || a - b);
  const setOf = assets.map((_, i) => sets.find((set) => set.indices.includes(i)));
  for (const set of sets) {
    let remaining = set.min - total(set.indices.map((i) => weights[i]));
    for (const i of order.filter((index) => set.indices.includes(index))) {
      const add = Math.max(0, Math.min(remaining, policy.bounds[i].max - weights[i]));
      weights[i] += add;
      remaining -= add;
    }
  }
  let remaining = 1 - total(weights);
  for (const i of order) {
    const set = setOf[i];
    const room = set.max - total(set.indices.map((index) => weights[index]));
    const add = Math.max(0, Math.min(remaining, room, policy.bounds[i].max - weights[i]));
    weights[i] += add;
    remaining -= add;
  }
  if (!satisfiesPolicy(weights, assets, policy, 1e-8)) throw new RangeError('SAA 실행 가능 비중 계산에 실패했습니다.');
  return weights;
}

// Partial-pivot Gaussian elimination. Only small (at most 16 x 16) systems occur.
function solve(matrix, values) {
  const n = values.length;
  if (!n) return [];
  const work = matrix.map((entries, i) => [...entries, values[i]]);
  for (let j = 0; j < n; j += 1) {
    let pivot = j;
    for (let i = j + 1; i < n; i += 1) if (Math.abs(work[i][j]) > Math.abs(work[pivot][j])) pivot = i;
    if (Math.abs(work[pivot][j]) < 1e-13) return null;
    [work[j], work[pivot]] = [work[pivot], work[j]];
    for (let i = j + 1; i < n; i += 1) {
      const ratio = work[i][j] / work[j][j];
      for (let k = j; k <= n; k += 1) work[i][k] -= ratio * work[j][k];
    }
  }
  const result = Array(n).fill(0);
  for (let j = n - 1; j >= 0; j -= 1) {
    let value = work[j][n];
    for (let i = j + 1; i < n; i += 1) value -= work[j][i] * result[i];
    result[j] = value / work[j][j];
  }
  return result;
}

function independent(rows, candidate) {
  let residual = [...candidate];
  const basis = [];
  for (const source of rows) {
    let direction = [...source];
    for (const b of basis) {
      const amount = dot(direction, b);
      direction = direction.map((x, i) => x - amount * b[i]);
    }
    const norm = Math.sqrt(dot(direction, direction));
    if (norm > 1e-9) basis.push(direction.map((x) => x / norm));
  }
  for (const b of basis) {
    const amount = dot(residual, b);
    residual = residual.map((x, i) => x - amount * b[i]);
  }
  return Math.sqrt(dot(residual, residual)) > 1e-9;
}

function constraints(assets, policy) {
  const n = assets.length;
  const equalities = [{ a: Array(n).fill(1), b: 1 }];
  const inequalities = [];
  function addBand(a, min, max) {
    if (!a.some(Boolean)) return;
    if (min === max) {
      if (independent(equalities.map((entry) => entry.a), a)) equalities.push({ a, b: min });
    } else {
      inequalities.push({ a: a.map((x) => -x), b: -min }, { a, b: max });
    }
  }
  policy.bounds.forEach((value, i) => addBand(row(n, i), value.min, value.max));
  GROUPS.forEach((name) => {
    const a = assets.map((asset) => +(asset.group === name));
    // Redundant 0..1 group bands add degeneracy without changing the region.
    if (policy.groups[name].min !== 0 || policy.groups[name].max !== 1) {
      addBand(a, policy.groups[name].min, policy.groups[name].max);
    }
  });
  return { equalities, inequalities };
}

function clean(weights) {
  const result = weights.map((x) => Math.max(0, Math.min(1, x)));
  const scale = total(result);
  return result.map((x) => x / scale);
}

/** Primal feasible active-set QP; no ridge, penalty, or constraint relaxation. */
function minimumVariance(cov, region, feasibleStart, extraEquality = null) {
  const n = cov.length;
  const scale = Math.max(...cov.map((values, i) => values[i]));
  const hessian = cov.map((values) => values.map((value) => value / scale));
  const equalities = [...region.equalities];
  if (extraEquality && independent(equalities.map((entry) => entry.a), extraEquality.a)) equalities.push(extraEquality);
  const active = [];
  let weights = [...feasibleStart];
  for (let i = 0; i < region.inequalities.length; i += 1) {
    const constraint = region.inequalities[i];
    const current = [...equalities.map((entry) => entry.a), ...active.map((index) => region.inequalities[index].a)];
    if (Math.abs(dot(constraint.a, weights) - constraint.b) < 1e-9 && independent(current, constraint.a)) active.push(i);
  }
  for (let iteration = 0; iteration < 500; iteration += 1) {
    const rows = [...equalities.map((entry) => entry.a), ...active.map((index) => region.inequalities[index].a)];
    const gradient = hessian.map((values) => dot(values, weights));
    const matrix = hessian.map((values, i) => [...values, ...rows.map((a) => a[i])]);
    rows.forEach((a) => matrix.push([...a, ...Array(rows.length).fill(0)]));
    const solution = solve(matrix, [...gradient.map((value) => -value), ...Array(rows.length).fill(0)]);
    if (!solution) throw new RangeError('SAA 제약 계산이 수치적으로 불안정합니다. 비중 범위와 상관행렬을 점검하세요.');
    const direction = solution.slice(0, n);
    if (Math.max(...direction.map(Math.abs)) < 2e-10) {
      let remove = -1;
      let mostNegative = -1e-10;
      active.forEach((_, index) => {
        const multiplier = solution[n + equalities.length + index];
        if (multiplier < mostNegative) { mostNegative = multiplier; remove = index; }
      });
      if (remove < 0) return clean(weights);
      active.splice(remove, 1);
      continue;
    }
    let step = 1;
    let blocker = -1;
    region.inequalities.forEach((constraint, i) => {
      if (active.includes(i)) return;
      const change = dot(constraint.a, direction);
      if (change <= 1e-11) return;
      const distance = Math.max(0, (constraint.b - dot(constraint.a, weights)) / change);
      if (distance < step && independent(rows, constraint.a)) { step = distance; blocker = i; }
    });
    weights = weights.map((value, i) => value + step * direction[i]);
    if (blocker >= 0) active.push(blocker);
  }
  throw new RangeError('SAA 최적화가 수렴하지 않았습니다. 제약 범위를 점검하세요.');
}

function summarize(weights, assets, cov, rf) {
  const products = cov.map((values) => dot(values, weights));
  const variance = dot(weights, products);
  const vol = Math.sqrt(variance);
  const mu = dot(weights, assets.map((asset) => asset.mu));
  return { weights: [...weights], mu, vol, sharpe: (mu - rf) / vol,
    riskShares: weights.map((value, i) => value * products[i] / variance),
    riskContributions: weights.map((value, i) => value * products[i] / vol) };
}

// For entirely nonpositive excess returns, the maximum ratio occurs at a vertex.
// Enumerate independent binding constraints, including vertices inside the simplex.
function visitVertices(region, n, visit) {
  const base = region.equalities;
  const selected = [];
  function walk(start, rows) {
    if (rows.length === n) {
      const values = [...base.map((entry) => entry.b), ...selected.map((i) => region.inequalities[i].b)];
      const weights = solve(rows, values);
      if (weights && region.inequalities.every((entry) => dot(entry.a, weights) <= entry.b + 1e-8)) visit(clean(weights));
      return;
    }
    const needed = n - rows.length;
    for (let i = start; i <= region.inequalities.length - needed; i += 1) {
      const a = region.inequalities[i].a;
      if (!independent(rows, a)) continue;
      selected.push(i);
      walk(i + 1, [...rows, a]);
      selected.pop();
    }
  }
  walk(0, base.map((entry) => entry.a));
}

/**
 * Constrained QP minimum/target variance and positive-Sharpe scalar search.
 * Maximum Sharpe uses deterministic numerical tolerance, not a closed-form claim.
 * The frontier is the upper efficient arm; an unattainable target returns null.
 */
export function optimizeAllocation(assets, cov, rf = 0, target = null, policy = defaultPolicy(assets)) {
  validatePolicy(assets, policy);
  if (unrestricted(policy)) return { ...optimize(assets, cov, rf, target), returnRange: [Math.min(...assets.map((asset) => asset.mu)), Math.max(...assets.map((asset) => asset.mu))] };
  const means = assets.map((asset) => asset.mu);
  const lowerWeights = linearAllocation(assets, policy, means.map((value) => -value));
  const upperWeights = linearAllocation(assets, policy, means);
  // Reuse the base engine's moment, dimension, finite-rf and SPD validation once.
  stats(lowerWeights, assets, cov, rf);
  if (target !== null && target !== undefined && !Number.isFinite(target)) throw new RangeError('목표수익률은 유한한 숫자이어야 합니다.');
  const minMean = dot(lowerWeights, means);
  const maxMean = dot(upperWeights, means);
  const region = constraints(assets, policy);
  const makeStats = (weights) => {
    if (!satisfiesPolicy(weights, assets, policy, 1e-7)) throw new RangeError('계산된 비중이 SAA 제약을 만족하지 않습니다.');
    return summarize(weights, assets, cov, rf);
  };
  const middle = lowerWeights.map((value, i) => (value + upperWeights[i]) / 2);
  const minVol = makeStats(minimumVariance(cov, region, middle));
  const spread = Math.max(...means) - Math.min(...means);
  function atTarget(value) {
    if (value < minMean - 1e-8 || value > maxMean + 1e-8) return null;
    if (maxMean - minMean < 1e-10) return Math.abs(value - minMean) < 1e-8 ? minVol : null;
    const requested = Math.max(minMean, Math.min(maxMean, value));
    const fraction = (requested - minMean) / (maxMean - minMean);
    const start = lowerWeights.map((entry, i) => entry + fraction * (upperWeights[i] - entry));
    const origin = Math.min(...means);
    const equality = { a: means.map((entry) => (entry - origin) / spread), b: (requested - origin) / spread };
    const result = makeStats(minimumVariance(cov, region, start, equality));
    if (Math.abs(result.mu - requested) > 1e-7) throw new RangeError('목표수익률 제약의 계산 오차가 허용 범위를 넘었습니다.');
    return result;
  }
  let maxSharpe = minVol;
  const choose = (candidate) => { if (candidate && candidate.sharpe > maxSharpe.sharpe) maxSharpe = candidate; };
  const frontier = [minVol];
  if (maxMean - minVol.mu > 1e-8) {
    for (let i = 1; i <= 64; i += 1) {
      const point = atTarget(i === 64 ? maxMean : minVol.mu + (maxMean - minVol.mu) * i / 64);
      frontier.push(point);
      choose(point);
    }
  }
  if (maxMean > rf) {
    let left = Math.max(minVol.mu, rf);
    let right = maxMean;
    const ratio = (Math.sqrt(5) - 1) / 2;
    let x1 = right - ratio * (right - left);
    let x2 = left + ratio * (right - left);
    let p1 = atTarget(x1);
    let p2 = atTarget(x2);
    for (let i = 0; i < 56 && right - left > 1e-10; i += 1) {
      choose(p1); choose(p2);
      if (p1.sharpe < p2.sharpe) {
        left = x1; x1 = x2; p1 = p2;
        x2 = left + ratio * (right - left); p2 = atTarget(x2);
      } else {
        right = x2; x2 = x1; p2 = p1;
        x1 = right - ratio * (right - left); p1 = atTarget(x1);
      }
    }
    choose(p1); choose(p2); choose(atTarget(maxMean));
  } else {
    visitVertices(region, assets.length, (weights) => choose(makeStats(weights)));
  }
  return { minVol, maxSharpe, target: target === null || target === undefined ? null : atTarget(target), frontier, returnRange: [minMean, maxMean] };
}

function randomSource(seed) {
  let state = Number(seed) >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

/** Deterministic feasible mixes, including sparse boundaries; fixed policy yields one point. */
export function samplePortfolios(assets, cov, rf = 0, policy = defaultPolicy(assets), { count = 2400, seed = 20261016 } = {}) {
  validatePolicy(assets, policy);
  if (!Number.isInteger(count) || count < 0 || count > 50000) throw new RangeError('조합 개수는 0~50,000 정수이어야 합니다.');
  const n = assets.length;
  const random = randomSource(seed);
  const extremes = [];
  for (let i = 0; i < n; i += 1) {
    extremes.push(linearAllocation(assets, policy, row(n, i)), linearAllocation(assets, policy, row(n, i).map((x) => -x)));
  }
  // Validate every input even when the requested cloud is empty.
  stats(extremes[0], assets, cov, rf);
  if (!count) return [];
  const region = constraints(assets, policy);
  GROUPS.forEach((name) => {
    const scores = assets.map((asset) => +(asset.group === name));
    extremes.push(linearAllocation(assets, policy, scores), linearAllocation(assets, policy, scores.map((x) => -x)));
  });
  for (let i = 0; i < 80; i += 1) extremes.push(linearAllocation(assets, policy, assets.map(() => random() - 0.5)));
  const center = assets.map((_, i) => total(extremes.map((weights) => weights[i])) / extremes.length);
  const result = [];
  const append = (weights) => {
    const cleaned = clean(weights);
    if (!satisfiesPolicy(cleaned, assets, policy, 1e-7)) throw new RangeError('조합 비중이 SAA 제약을 만족하지 않습니다.');
    result.push(summarize(cleaned, assets, cov, rf));
  };
  const unique = new Set();
  for (const weights of extremes) {
    const key = weights.map((value) => value.toFixed(9)).join(',');
    if (!unique.has(key)) { unique.add(key); append(weights); }
    if (result.length === count) return result;
  }
  if (unique.size === 1) return result;
  const equalities = region.equalities.map((entry) => entry.a);
  // Implicitly fixed asset/group bands are discovered from feasible extremes.
  for (const constraint of region.inequalities) {
    if (extremes.every((weights) => Math.abs(dot(constraint.a, weights) - constraint.b) < 1e-9) && independent(equalities, constraint.a)) equalities.push(constraint.a);
  }
  const gram = equalities.map((a) => equalities.map((b) => dot(a, b)));
  let weights = [...center];
  while (result.length < count) {
    if (result.length % 32 === 0) weights = [...center];
    let direction = assets.map(() => random() - 0.5);
    const projection = solve(gram, equalities.map((a) => dot(a, direction)));
    direction = direction.map((value, i) => value - total(equalities.map((a, j) => projection[j] * a[i])));
    let lower = -Infinity;
    let upper = Infinity;
    for (const constraint of region.inequalities) {
      const change = dot(constraint.a, direction);
      if (Math.abs(change) < 1e-12) continue;
      const distance = (constraint.b - dot(constraint.a, weights)) / change;
      if (change > 0) upper = Math.min(upper, distance);
      else lower = Math.max(lower, distance);
    }
    if (Number.isFinite(lower) && Number.isFinite(upper) && upper >= lower && upper - lower > 1e-12) {
      const fraction = random();
      const step = lower + fraction * (upper - lower);
      weights = weights.map((value, i) => value + step * direction[i]);
    }
    append(weights);
  }
  return result;
}
