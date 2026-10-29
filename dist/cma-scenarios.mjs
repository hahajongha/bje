import { covariance, stats, validateInputs } from './portfolio.mjs';

export const SCENARIOS = Object.freeze([
  Object.freeze({ id: 'optimistic', label: '낙관' }),
  Object.freeze({ id: 'neutral', label: '중립' }),
  Object.freeze({ id: 'pessimistic', label: '비관' }),
]);

const identity = n => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => +(i === j)));

function validateScenarios(assets, correlation, scenarios) {
  validateInputs(assets, correlation);
  if (!Array.isArray(scenarios) || scenarios.length !== SCENARIOS.length) {
    throw new RangeError('낙관·중립·비관 시나리오를 모두 입력하십시오.');
  }
  scenarios.forEach((scenario, s) => {
    const label = SCENARIOS[s].label;
    if (!scenario || scenario.id !== SCENARIOS[s].id || !Array.isArray(scenario.assets) || scenario.assets.length !== assets.length) {
      throw new RangeError(`${label} 시나리오의 자산과 순서를 확인하십시오.`);
    }
    if (typeof scenario.probability !== 'number' || !Number.isFinite(scenario.probability) || scenario.probability < 0 || scenario.probability > 1) {
      throw new RangeError(`${label} 확률은 0~100%이어야 합니다.`);
    }
    // Validate zero-probability scenarios too: they remain editable and reusable.
    validateInputs(scenario.assets, correlation);
  });
  const total = scenarios.reduce((sum, scenario) => sum + scenario.probability, 0);
  if (Math.abs(total - 1) > 1e-8) throw new RangeError('시나리오 확률 합계는 100%이어야 합니다.');
  return total;
}

/** Preserve the existing forecast until a user changes the scenario inputs. */
export function createScenarios(assets) {
  validateInputs(assets, identity(assets?.length ?? 0));
  return SCENARIOS.map(({ id }, s) => ({
    id,
    probability: s === 1 ? 1 : 0,
    assets: assets.map(({ mu, vol }) => ({ mu, vol })),
  }));
}

/**
 * Annual mu/vol are in percent; covariance is in percentage-points squared.
 * Correlation is shared across conditional scenario distributions. Total
 * covariance includes both conditional risk and between-scenario mean risk.
 */
export function aggregateScenarios(baseAssets, conditionalCorrelation, scenarios) {
  const total = validateScenarios(baseAssets, conditionalCorrelation, scenarios);
  // Only floating-point sum error within the validated tolerance is removed.
  const probabilities = scenarios.map(scenario => scenario.probability / total);
  const conditional = scenarios.map(scenario => covariance(scenario.assets, conditionalCorrelation));
  const means = baseAssets.map((_, i) => {
    const anchor = scenarios[1].assets[i].mu;
    return anchor + scenarios.reduce((sum, scenario, s) => sum + probabilities[s] * (scenario.assets[i].mu - anchor), 0);
  });
  const matrix = baseAssets.map(() => Array(baseAssets.length).fill(0));
  for (let i = 0; i < baseAssets.length; i += 1) {
    for (let j = i; j < baseAssets.length; j += 1) {
      const value = scenarios.reduce((sum, scenario, s) => sum + probabilities[s] * (
        conditional[s][i][j] + (scenario.assets[i].mu - means[i]) * (scenario.assets[j].mu - means[j])
      ), 0);
      matrix[i][j] = matrix[j][i] = value;
    }
  }
  const assets = baseAssets.map((asset, i) => ({ ...asset, mu: means[i], vol: Math.sqrt(matrix[i][i]) }));
  // Reuse the optimizer's covariance validation, including numerical singularity.
  stats(assets.map(() => 1 / assets.length), assets, matrix, 0);
  return { assets, covariance: matrix };
}

/**
 * TAA moment edits apply the same positive affine return transformation to
 * every scenario for an asset. This preserves standardized scenario structure
 * and conditional correlations while matching the requested aggregate moments.
 */
export function remapScenarios(scenarios, currentAssets, targetAssets) {
  const correlation = identity(currentAssets?.length ?? 0);
  validateScenarios(currentAssets, correlation, scenarios);
  validateInputs(targetAssets, correlation);
  const remapped = scenarios.map(scenario => ({
    ...scenario,
    assets: scenario.assets.map((asset, i) => {
      const current = currentAssets[i], target = targetAssets[i];
      if (current.mu === target.mu && current.vol === target.vol) return { ...asset };
      const scale = target.vol / current.vol;
      return { ...asset, mu: target.mu + scale * (asset.mu - current.mu), vol: scale * asset.vol };
    }),
  }));
  validateScenarios(targetAssets, correlation, remapped);
  return remapped;
}
