/**
 * Efficient-frontier destinations for a selected fully invested portfolio.
 * Returns/volatility use annual percentage points; weights/deltas are fractions.
 * The upper frontier is solved under the current SAA constraints. Cloud points
 * are never used as destinations or as an approximation to an optimum.
 */
import { stats } from './portfolio.mjs';
import { defaultPolicy, optimizeAllocation, satisfiesPolicy, validatePolicy } from './allocation.mjs';

const cache = new WeakMap();
const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;

function signature(assets, cov, rf, policy) {
  return JSON.stringify([assets.map(({ mu, vol, group }) => [mu, vol, group]), cov, rf, policy]);
}

function contextFor(assets, cov, rf, policy, optimized) {
  const fingerprint = signature(assets, cov, rf, policy);
  const previous = optimized && cache.get(optimized);
  if (previous?.fingerprint === fingerprint) return previous;
  // A reused result object after a CMA/SAA edit must not carry a stale frontier.
  const solution = !optimized || previous ? optimizeAllocation(assets, cov, rf, null, policy) : optimized;
  if (!solution.minVol || !Array.isArray(solution.returnRange)) {
    throw new RangeError('효율적 경계선 계산 결과를 확인하세요.');
  }
  const record = { fingerprint, solution, targets: new Map(), results: new Map() };
  if (optimized) cache.set(optimized, record);
  return record;
}

/**
 * mode='same-risk': maximize return subject to volatility <= selected volatility.
 * mode='same-return': minimize volatility subject to return >= selected return.
 * Supply the optimizer result from the same CMA/SAA state for fast UI rendering.
 * An unavailable/non-dominating destination returns target/deltas=null; malformed
 * inputs and solver failures throw so the caller can display its error state.
 */
export function frontierTarget({ selected, assets, cov, rf = 0,
  policy = defaultPolicy(assets), optimized = null, mode = 'same-risk' }) {
  if (!['same-risk', 'same-return'].includes(mode)) throw new RangeError('효율적 경계선 이동 기준을 확인하세요.');
  validatePolicy(assets, policy);
  // Recompute from weights, so stale or rounded display statistics cannot change
  // the optimization criterion or the reported weight-change identity.
  const source = stats(selected?.weights, assets, cov, rf);
  const context = contextFor(assets, cov, rf, policy, optimized);
  const key = JSON.stringify([mode, source.weights]);
  if (context.results.has(key)) return context.results.get(key);
  const { solution, targets } = context;
  const minimum = solution.minVol;
  const maximumReturn = solution.returnRange[1];
  const muTolerance = 1e-8 * Math.max(1, Math.abs(source.mu), Math.abs(maximumReturn));
  const volTolerance = 1e-8 * Math.max(1, source.vol, minimum.vol);
  const finish = (target, status, condition = '') => {
    if (target && (!satisfiesPolicy(target.weights, assets, policy) ||
        target.mu < source.mu - muTolerance || target.vol > source.vol + volTolerance)) {
      target = null;
      status = 'non-dominating';
      condition = '현재 SAA 내 개선안 없음';
    }
    if (target && near(target.mu, source.mu, muTolerance) && near(target.vol, source.vol, volTolerance)) {
      status = 'already-efficient';
      condition = '효율적 경계선 위 선택';
    }
    const result = { target, deltas: target ? target.weights.map((weight, i) => weight - source.weights[i]) : null,
      status, condition, mode };
    context.results.set(key, result);
    return result;
  };
  const atReturn = (requested) => {
    if (near(requested, minimum.mu, 1e-12)) return minimum;
    if (!targets.has(requested)) {
      const point = optimizeAllocation(assets, cov, rf, requested, policy).target;
      if (!point) throw new RangeError('효율적 경계선의 목표 비중을 계산할 수 없습니다.');
      targets.set(requested, point);
    }
    return targets.get(requested);
  };

  if (source.mu > maximumReturn + muTolerance) {
    return finish(null, 'infeasible', 'SAA 최대 기대수익 초과');
  }
  if (mode === 'same-return') {
    if (source.mu < minimum.mu - muTolerance) {
      return finish(minimum, 'gmv-floor', '최소변동성 경계 · 목표수익 ≥ 선택수익');
    }
    const requested = Math.max(minimum.mu, Math.min(maximumReturn, source.mu));
    return finish(atReturn(requested), 'matched');
  }

  if (source.vol < minimum.vol - volTolerance) {
    return finish(null, 'infeasible', 'SAA 최소 변동성 미달');
  }
  const highest = atReturn(maximumReturn);
  if (highest.vol <= source.vol + volTolerance) {
    return finish(highest, 'return-ceiling', '최대수익 경계 · 목표위험 ≤ 선택위험');
  }
  if (source.vol <= minimum.vol) return finish(minimum, 'matched');

  const budget = source.vol ** 2;
  const varianceTolerance = 1e-12 * Math.max(1, budget);
  let left = minimum;
  let right = highest;
  // Existing exact frontier points only narrow the root bracket. Repeated points
  // and identical asset means do not create divisions by zero.
  for (const point of solution.frontier || []) {
    if (!point || point.mu < minimum.mu || point.mu > maximumReturn) continue;
    if (point.vol <= source.vol && point.mu > left.mu) left = point;
    if (point.vol > source.vol && point.mu < right.mu) right = point;
  }
  for (let iteration = 0; iteration < 40; iteration += 1) {
    if ((iteration > 0 && budget - left.vol ** 2 <= varianceTolerance) || right.mu - left.mu <= muTolerance) {
      return finish(left, 'matched');
    }
    const middle = atReturn((left.mu + right.mu) / 2);
    const lowVariance = left.vol ** 2;
    const highVariance = right.vol ** 2;
    // On a fixed active set, frontier variance is quadratic in expected return.
    // Predict that root, then VERIFY it with another exact constrained solve.
    // An active-set change is handled by retaining the feasible root bracket.
    const a = 2 * (highVariance + lowVariance - 2 * middle.vol ** 2);
    const b = highVariance - lowVariance - a;
    const c = lowVariance - budget;
    const discriminant = b * b - 4 * a * c;
    const denominator = b + Math.sqrt(Math.max(0, discriminant));
    let fraction = discriminant >= 0 && denominator > 0 ? -2 * c / denominator : 0.5;
    if (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1) fraction = 0.5;
    const candidate = fraction === 0.5 ? middle : atReturn(left.mu + fraction * (right.mu - left.mu));
    if (Math.abs(candidate.vol ** 2 - budget) <= varianceTolerance) return finish(candidate, 'matched');
    for (const point of [middle, candidate]) {
      if (point.vol <= source.vol && point.mu > left.mu) left = point;
      if (point.vol > source.vol && point.mu < right.mu) right = point;
    }
  }
  throw new RangeError('동일 변동성의 효율적 경계선 계산이 수렴하지 않았습니다.');
}
