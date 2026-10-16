/**
 * Deterministic, long-only, fully-invested portfolio calculations for 2–8 assets.
 * mu, vol, rf and target use annual percentage points (5 means 5%);
 * covariance uses annual percentage-points squared; weights use fractions.
 * No leverage, upper bounds, transaction costs, or implicit regularization.
 */
const MAX_ASSETS = 8;
const WEIGHT_TOLERANCE = 1e-10;
const RETURN_TOLERANCE = 1e-8;

const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const sum = (a) => a.reduce((total, value) => total + value, 0);

function finite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RangeError(`${label}: 유한한 숫자를 입력하세요.`);
  }
}

function validateAssets(assets) {
  if (!Array.isArray(assets) || assets.length < 2 || assets.length > MAX_ASSETS) {
    throw new RangeError(`자산은 2개 이상 ${MAX_ASSETS}개 이하이어야 합니다.`);
  }
  assets.forEach((asset, i) => {
    if (!asset || typeof asset !== 'object') throw new RangeError(`자산 ${i + 1} 입력이 잘못되었습니다.`);
    finite(asset.mu, `자산 ${i + 1} 기대수익률`);
    finite(asset.vol, `자산 ${i + 1} 변동성`);
    if (asset.vol <= 0) throw new RangeError(`자산 ${i + 1} 변동성은 0보다 커야 합니다.`);
  });
}

function validateMatrixShape(matrix, size, label) {
  if (!Array.isArray(matrix) || matrix.length !== size ||
      matrix.some((row) => !Array.isArray(row) || row.length !== size)) {
    throw new RangeError(`${label}은 ${size} × ${size} 행렬이어야 합니다.`);
  }
  matrix.forEach((row, i) => row.forEach((value, j) => finite(value, `${label} ${i + 1},${j + 1}`)));
}

function cholesky(matrix) {
  const n = matrix.length;
  const lower = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let remainder = matrix[i][j];
      for (let k = 0; k < j; k += 1) remainder -= lower[i][k] * lower[j][k];
      if (i === j) {
        // Reject singular / numerically singular matrices; never add a hidden ridge.
        if (!Number.isFinite(remainder) || remainder <= matrix[i][i] * 1e-12 || remainder <= 0) {
          throw new RangeError('상관·공분산행렬이 양의 정부호가 아니거나 수치적으로 특이합니다. 상관계수를 점검하세요.');
        }
        lower[i][j] = Math.sqrt(remainder);
      } else {
        lower[i][j] = remainder / lower[j][j];
      }
    }
  }
  return lower;
}

function solve(lower, values) {
  const n = values.length;
  const y = Array(n).fill(0);
  const x = Array(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    let remainder = values[i];
    for (let j = 0; j < i; j += 1) remainder -= lower[i][j] * y[j];
    y[i] = remainder / lower[i][i];
  }
  for (let i = n - 1; i >= 0; i -= 1) {
    let remainder = y[i];
    for (let j = i + 1; j < n; j += 1) remainder -= lower[j][i] * x[j];
    x[i] = remainder / lower[i][i];
  }
  return x;
}

/** Validate asset moments and a strictly positive-definite correlation matrix. */
export function validateInputs(assets, correlation) {
  validateAssets(assets);
  validateMatrixShape(correlation, assets.length, '상관행렬');
  for (let i = 0; i < assets.length; i += 1) {
    if (Math.abs(correlation[i][i] - 1) > 1e-10) throw new RangeError('상관행렬의 대각선은 1이어야 합니다.');
    for (let j = 0; j < assets.length; j += 1) {
      if (correlation[i][j] < -1 || correlation[i][j] > 1) throw new RangeError('상관계수는 -1부터 1 사이이어야 합니다.');
      if (Math.abs(correlation[i][j] - correlation[j][i]) > 1e-10) {
        throw new RangeError('상관행렬은 대칭이어야 합니다.');
      }
    }
  }
  cholesky(correlation);
  return true;
}

/** Annual covariance in percentage-points squared, e.g. a 5% vol has variance 25. */
export function covariance(assets, correlation) {
  validateInputs(assets, correlation);
  return assets.map((asset, i) => assets.map((other, j) =>
    asset.vol * other.vol * (i === j ? 1 : (correlation[i][j] + correlation[j][i]) / 2)));
}

function validateCovariance(assets, cov) {
  validateAssets(assets);
  validateMatrixShape(cov, assets.length, '공분산행렬');
  for (let i = 0; i < assets.length; i += 1) {
    if (cov[i][i] <= 0) throw new RangeError('공분산행렬의 대각선은 0보다 커야 합니다.');
    if (Math.abs(cov[i][i] - assets[i].vol ** 2) > 1e-8 * Math.max(1, assets[i].vol ** 2)) {
      throw new RangeError('공분산행렬의 단위 또는 자산 변동성이 일치하지 않습니다. 단위는 연간 %p²입니다.');
    }
    for (let j = 0; j < assets.length; j += 1) {
      const scale = Math.max(1, Math.abs(cov[i][j]), Math.abs(cov[j][i]));
      if (Math.abs(cov[i][j] - cov[j][i]) > 1e-10 * scale) throw new RangeError('공분산행렬은 대칭이어야 합니다.');
    }
  }
  cholesky(cov);
}

function validateWeights(weights, n) {
  if (!Array.isArray(weights) || weights.length !== n) throw new RangeError('비중 개수와 자산 개수가 일치해야 합니다.');
  weights.forEach((value) => {
    finite(value, '비중');
    if (value < 0 || value > 1) throw new RangeError('비중은 0부터 1 사이이어야 합니다.');
  });
  if (Math.abs(sum(weights) - 1) > 1e-8) throw new RangeError('비중 합계는 100%이어야 합니다.');
}

function uncheckedStats(weights, assets, cov, rf) {
  const products = cov.map((row) => dot(row, weights));
  const variance = dot(weights, products);
  if (!Number.isFinite(variance) || variance <= 0) throw new RangeError('포트폴리오 분산을 계산할 수 없습니다. 입력 단위를 확인하세요.');
  const vol = Math.sqrt(variance);
  const mu = dot(weights, assets.map((asset) => asset.mu));
  return {
    weights: [...weights],
    mu,
    vol,
    sharpe: (mu - rf) / vol,
    riskShares: weights.map((weight, i) => weight * products[i] / variance),
    riskContributions: weights.map((weight, i) => weight * products[i] / vol),
  };
}

/** Risk shares sum to 1; signed volatility contributions sum to vol (%p). */
export function stats(weights, assets, cov, rf = 0) {
  validateCovariance(assets, cov);
  finite(rf, '무위험금리');
  validateWeights(weights, assets.length);
  return uncheckedStats(weights, assets, cov, rf);
}

function feasibleWeights(partial, indices, n) {
  if (partial.some((weight) => !Number.isFinite(weight) || weight < -WEIGHT_TOLERANCE || weight > 1 + WEIGHT_TOLERANCE)) return null;
  const cleaned = partial.map((weight) => Math.max(0, weight));
  const total = sum(cleaned);
  if (!Number.isFinite(total) || total <= 0 || Math.abs(total - 1) > 1e-7) return null;
  const full = Array(n).fill(0);
  indices.forEach((index, i) => { full[index] = cleaned[i] / total; });
  return full;
}

function createSupports(assets, cov) {
  const n = assets.length;
  const supports = [];
  for (let mask = 1; mask < 2 ** n; mask += 1) {
    const indices = Array.from({ length: n }, (_, i) => i).filter((i) => mask & (1 << i));
    const means = indices.map((i) => assets[i].mu);
    const subCov = indices.map((i) => indices.map((j) => cov[i][j]));
    const lower = cholesky(subCov);
    const u = solve(lower, indices.map(() => 1));
    const a = sum(u);
    const origin = Math.min(...means);
    const spread = Math.max(...means) - origin;
    const support = { indices, means, lower, u, a, origin, spread };
    // Center and scale expected returns to avoid subtracting large nearly equal
    // quantities when a target is constrained, e.g. means near 100%.
    if (spread > 0) {
      const q = means.map((value) => (value - origin) / spread);
      const v = solve(lower, q);
      const b = sum(v);
      const h = v.map((value, i) => value - u[i] * b / a);
      support.b = b;
      support.h = h;
      support.hq = dot(h, q);
    }
    supports.push(support);
  }
  return supports;
}

/**
 * Exact active-set enumeration for long-only minimum variance, maximum Sharpe,
 * and target-return portfolios. The frontier contains the efficient upper arm.
 * A missing / infeasible target returns null; invalid input throws RangeError.
 */
export function optimize(assets, cov, rf = 0, target = null) {
  validateCovariance(assets, cov);
  finite(rf, '무위험금리');
  if (target !== null && target !== undefined) finite(target, '목표수익률');
  const n = assets.length;
  const supports = createSupports(assets, cov);
  const minMean = Math.min(...assets.map((asset) => asset.mu));
  const maxMean = Math.max(...assets.map((asset) => asset.mu));
  const summarize = (weights) => uncheckedStats(weights, assets, cov, rf);
  let minVol = null;
  let maxSharpe = null;

  for (const support of supports) {
    const weights = feasibleWeights(support.u.map((value) => value / support.a), support.indices, n);
    if (weights) {
      const candidate = summarize(weights);
      if (!minVol || candidate.vol < minVol.vol) minVol = candidate;
    }

    if (maxMean > rf) {
      const x = solve(support.lower, support.means.map((value) => value - rf));
      const total = sum(x);
      if (total > 0) {
        const tangentWeights = feasibleWeights(x.map((value) => value / total), support.indices, n);
        if (tangentWeights) {
          const candidate = summarize(tangentWeights);
          if (candidate.sharpe > 0 && (!maxSharpe || candidate.sharpe > maxSharpe.sharpe)) maxSharpe = candidate;
        }
      }
    } else if (support.indices.length === 1) {
      // With no positive excess return, the best attainable Sharpe is at a
      // vertex; normalizing a negative tangency vector would give a wrong answer.
      const vertex = Array(n).fill(0);
      vertex[support.indices[0]] = 1;
      const candidate = summarize(vertex);
      if (!maxSharpe || candidate.sharpe > maxSharpe.sharpe) maxSharpe = candidate;
    }
  }

  if (!minVol || !maxSharpe) throw new RangeError('입력에서 유효한 최적 포트폴리오를 찾지 못했습니다.');

  function atTarget(value) {
    if (value < minMean || value > maxMean) return null;
    let best = null;
    for (const support of supports) {
      if (value < support.origin - RETURN_TOLERANCE || value > support.origin + support.spread + RETURN_TOLERANCE) continue;
      let partial;
      if (support.spread === 0) {
        if (Math.abs(value - support.origin) > RETURN_TOLERANCE) continue;
        partial = support.u.map((entry) => entry / support.a);
      } else {
        if (!(support.hq > 0)) continue;
        const scaledTarget = (value - support.origin) / support.spread;
        const multiplier = (scaledTarget - support.b / support.a) / support.hq;
        partial = support.u.map((entry, i) => entry / support.a + support.h[i] * multiplier);
      }
      const weights = feasibleWeights(partial, support.indices, n);
      if (!weights) continue;
      const candidate = summarize(weights);
      if (Math.abs(candidate.mu - value) > RETURN_TOLERANCE) continue;
      if (!best || candidate.vol < best.vol) best = candidate;
    }
    return best;
  }

  const frontier = [minVol];
  if (maxMean - minVol.mu > RETURN_TOLERANCE) {
    for (let i = 1; i <= 64; i += 1) {
      const value = i === 64 ? maxMean : minVol.mu + (maxMean - minVol.mu) * i / 64;
      const point = atTarget(value);
      if (point) frontier.push(point);
    }
  }
  return {
    minVol,
    maxSharpe,
    target: target === null || target === undefined ? null : atTarget(target),
    frontier,
  };
}
