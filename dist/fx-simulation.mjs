/** Seeded conditional FX simulation. No fitting, networking or persistence. */
const ENGINE = 'markov-gaussian';
const VERSION = 1;
const error = field => { throw Error(`몬테카를로 ${field} 형식을 확인하십시오.`); };
const integer = (value, min, max, field) => {
  if (!Number.isInteger(value) || value < min || value > max) error(field);
  return value;
};
const finite = (value, min, max, field) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) error(field);
  return value;
};
function probability(row, field) {
  if (!Array.isArray(row) || row.length !== 3) error(field);
  const values = row.map(value => finite(value, 0, 1, field));
  const total = values.reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - 1) > 1e-5) error(`${field} 합계`);
  return values.map(value => value / total);
}
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
function randomStream(seed) {
  let state = seed >>> 0, spare = null;
  const uniform = () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (((value ^ (value >>> 14)) >>> 0) + 0.5) / 4294967296;
  };
  const normal = () => {
    if (spare !== null) { const value = spare; spare = null; return value; }
    const radius = Math.sqrt(-2 * Math.log(uniform())), angle = 2 * Math.PI * uniform();
    spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  };
  return {uniform, normal};
}
const drawState = (row, draw) => draw < row[0] ? 0 : draw < row[0] + row[1] ? 1 : 2;
const multiply = (vector, matrix) => [0, 1, 2].map(j => vector.reduce((sum, value, i) => sum + value * matrix[i][j], 0));

/** A transition/emission adapter; output aggregation below is model-independent. */
function markovAdapter(model) {
  if (!model || !Array.isArray(model.regimes) || model.regimes.length !== 3 || !Array.isArray(model.transition) || model.transition.length !== 3) error('3개 국면');
  const initial = probability(model.currentProbs, '현재 확률');
  const transition = model.transition.map(row => probability(row, '전이확률'));
  const means = model.regimes.map(row => finite(row?.meanDailyPct, -100, 100, '국면 평균') / 100);
  const sigmas = model.regimes.map(row => finite(row?.volDailyPct, 0, 100, '국면 변동성') / 100);
  let probs = initial.slice(), first = [0, 0, 0], second = [0, 0, 0], priceMGF = initial.slice();
  return {
    initialize: rng => drawState(initial, rng.uniform()),
    advance: (state, rng) => {
      const next = drawState(transition[state], rng.uniform());
      return [next, means[next] + sigmas[next] * rng.normal()];
    },
    // Exact finite-state recursion is a diagnostic, never the displayed MC mean.
    benchmark: spot => {
      probs = multiply(probs, transition);
      const priorFirst = multiply(first, transition), priorSecond = multiply(second, transition);
      const priorMGF = multiply(priceMGF, transition);
      first = means.map((mean, j) => priorFirst[j] + probs[j] * mean);
      second = means.map((mean, j) => priorSecond[j] + 2 * mean * priorFirst[j] + probs[j] * (sigmas[j] ** 2 + mean ** 2));
      priceMGF = means.map((mean, j) => priorMGF[j] * Math.exp(mean + sigmas[j] ** 2 / 2));
      const logMean = first.reduce((sum, value) => sum + value, 0);
      const logVariance = Math.max(0, second.reduce((sum, value) => sum + value, 0) - logMean ** 2);
      const analyticMean = spot * priceMGF.reduce((sum, value) => sum + value, 0);
      if (!Number.isFinite(analyticMean) || analyticMean <= 0 || !Number.isFinite(logVariance)) error('수치 범위');
      return {probs:probs.slice(), analyticMean, analyticSigmaLog:Math.sqrt(logVariance)};
    }
  };
}
const quantile = (sorted, fraction) => {
  const index = (sorted.length - 1) * fraction, lower = Math.floor(index), weight = index - lower;
  return sorted[lower] + (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]) * weight;
};

/** Pointwise empirical distribution, separate from the transition/emission model. */
function summarize(logReturns, spot, samples, step) {
  const prices = new Float64Array(logReturns.length);
  let mean = 0, priceM2 = 0, logMean = 0, logM2 = 0;
  for (let path = 0; path < logReturns.length; path++) {
    const logReturn = logReturns[path], value = spot * Math.exp(logReturn), n = path + 1;
    if (!Number.isFinite(value) || value <= 0) error('수치 범위');
    prices[path] = value;
    const priceDelta = value - mean; mean += priceDelta / n; priceM2 += priceDelta * (value - mean);
    const logDelta = logReturn - logMean; logMean += logDelta / n; logM2 += logDelta * (logReturn - logMean);
    if (path < samples.length) samples[path].values[step + 1] = value;
  }
  const n = logReturns.length, meanSE = Math.sqrt(Math.max(0, priceM2) / (n - 1) / n);
  const sigmaLog = Math.sqrt(Math.max(0, logM2) / n);
  if (![mean, meanSE, sigmaLog].every(Number.isFinite)) error('수치 범위');
  prices.sort();
  return {
    mean, meanSE, median:quantile(prices, 0.5), sigmaLog,
    lower68:quantile(prices, 0.16), upper68:quantile(prices, 0.84),
    lower90:quantile(prices, 0.05), upper90:quantile(prices, 0.95),
    lower95:quantile(prices, 0.025), upper95:quantile(prices, 0.975)
  };
}

/**
 * Simulate each observation from the last filtered state distribution.
 * Input: existing normalized snapshot; forecast contributes only ordered dates.
 * Output: daily summary rows + a fixed first-path preview + reproducibility data.
 * No paths, bends or means are adjusted to create a particular visual shape.
 */
export function simulateFx(snapshot, options = {}) {
  const paths = integer(options.paths ?? 10000, 1000, 40000, '경로 수');
  const seed = integer(options.seed ?? 20261020, 0, 4294967295, '시드');
  const horizon = integer(options.horizon ?? snapshot?.forecast?.length, 1, 504, '전망기간');
  const count = integer(options.samplePaths ?? 20, 0, Math.min(paths, 64), '표본 경로 수');
  const anchor = snapshot?.history?.at(-1);
  const spot = finite(anchor?.spot, Number.MIN_VALUE, Number.MAX_VALUE, '최근 환율');
  if (!validDate(anchor.date) || !Array.isArray(snapshot?.forecast)) error('전망 날짜');
  const dates = snapshot?.forecast?.slice(0, horizon).map(row => row.date);
  if (!dates || dates.length !== horizon) error('전망 날짜');
  let previous = anchor.date;
  for (const date of dates) {
    if (!validDate(date) || date <= previous) error('전망 날짜');
    previous = date;
  }
  const adapter = markovAdapter(snapshot.model), rng = randomStream(seed);
  const states = new Uint8Array(paths), cumulative = new Float64Array(paths);
  const samplePaths = Array.from({length:count}, (_, id) => ({id, values:[spot]}));
  for (let path = 0; path < paths; path++) states[path] = adapter.initialize(rng);
  const forecast = [];
  for (let step = 0; step < horizon; step++) {
    for (let path = 0; path < paths; path++) {
      const [state, innovation] = adapter.advance(states[path], rng);
      states[path] = state;
      cumulative[path] += innovation;
    }
    const benchmark = adapter.benchmark(spot);
    forecast.push({date:dates[step], step:step + 1, ...summarize(cumulative, spot, samplePaths, step), ...benchmark});
  }
  const final = forecast.at(-1);
  return {
    forecast, samplePaths,
    simulation:{
      engine:ENGINE, version:VERSION, rng:'mulberry32-box-muller', paths, seed, horizon, samplePathCount:count,
      meanMethod:'empirical-price', meanEstimator:'arithmetic-price', intervalMethod:'pointwise-empirical-quantiles',
      diagnostics:{analyticMean:final.analyticMean, simulatedMean:final.mean, meanSE:final.meanSE,
        meanAgreementSE:final.meanSE > 0 ? Math.abs(final.mean - final.analyticMean) / final.meanSE : null,
        analyticSigmaLog:final.analyticSigmaLog, simulatedSigmaLog:final.sigmaLog}
    }
  };
}
