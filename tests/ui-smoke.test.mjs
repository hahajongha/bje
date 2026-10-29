/**
 * Node DOM-stub integration checks, not browser or visual QA.
 * The real app's event handlers, calculations and markup run here.
 * Browser layout, native number-input behavior and persistence are
 * not validated. No private data values are embedded in this file.
 *
 * node --test tests/ui-smoke.test.mjs
 * BJE_TEST_DATA=/path/to/private-data.json node --test tests/ui-smoke.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { covariance, stats, optimize, validateInputs } from '../dist/portfolio.mjs';
import { demoData } from '../dist/demo-data.mjs';
import { normalizeFxHedge, renderHedgeMarkup } from '../dist/fx-hedge.mjs';
import { renderRiskMarkup } from '../dist/risk.mjs';
import { defaultPolicy, validatePolicy, satisfiesPolicy, optimizeAllocation, samplePortfolios } from '../dist/allocation.mjs';
import { frontierTarget } from '../dist/frontier-target.mjs';
import { initDataInfoUI } from '../dist/data-info-ui.mjs';
import { mountHedgeAnalytics } from '../dist/hedge-analytics.mjs';
import { mountFxWorkspace } from '../dist/fx-workspace.mjs';

const html = await fs.readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
const source = (await fs.readFile(new URL('../dist/app.mjs', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function createDocument() {
  const byId = new Map();
  const roots = [];
  const groups = new Map();

  function element(tag, attributes = {}) {
    const classes = new Set((attributes.class || '').split(/\s+/).filter(Boolean));
    let markup = '';
    let value = attributes.value || '';
    const el = {
      tagName: tag.toUpperCase(),
      id: attributes.id,
      dataset: Object.fromEntries(Object.entries(attributes)
        .filter(([key]) => key.startsWith('data-'))
        .map(([key, val]) => [key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()), val])),
      textContent: '',
      hidden: 'hidden' in attributes,
      disabled: 'disabled' in attributes,
      classList: {
        contains: name => classes.has(name),
        toggle(name, force) {
          const enabled = force === undefined ? !classes.has(name) : !!force;
          if (enabled) classes.add(name); else classes.delete(name);
          return enabled;
        },
      },
      getAttribute: name => attributes[name] ?? null,
      setAttribute: (name, value) => { attributes[name] = String(value); },
      click() {
        return this.onclick?.({ target: this, preventDefault() {} });
      },
      get value() { return value; },
      set value(next) { value = String(next); },
      get innerHTML() { return markup; },
      set innerHTML(next) {
        markup = String(next);
        groups.set(el, parse(markup));
      },
    };
    if (el.id) byId.set(el.id, el);
    return el;
  }

  function parse(markup) {
    const found = [];
    for (const match of markup.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
      const attrs = Object.fromEntries([...match[2].matchAll(/([\w:-]+)(?:="([^"]*)"|'([^']*)')?/g)]
        .map(part => [part[1], part[2] ?? part[3] ?? '']));
      if (attrs.id || attrs.class || Object.keys(attrs).some(key => key.startsWith('data-'))) {
        found.push(element(match[1], attrs));
      }
    }
    for(const match of markup.matchAll(/<select[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)){
      const select=byId.get(match[1]);
      select.options=[...match[2].matchAll(/<option value="([^"]+)"([^>]*)>/g)].map(m=>({value:m[1],disabled:m[2].includes('disabled')}));
      const chosen=[...match[2].matchAll(/<option value="([^"]+)"([^>]*)>/g)].find(m=>m[2].includes('selected'));
      select.value=chosen?.[1]??select.options[0]?.value??'';
    }
    return found;
  }

  roots.push(...parse(html));
  byId.get('coverage').value = '.9';
  const all = () => [...roots, ...groups.values()].flat();
  const querySelectorAll = selector => all().filter(el => {
    if (selector.startsWith('.')) return el.classList.contains(selector.slice(1));
    const match = selector.match(/^\[data-([\w-]+)(?:=([^\]]+))?\]$/);
    assert.ok(match, `Unsupported DOM-stub selector: ${selector}`);
    const key = match[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return key in el.dataset && (match[2] === undefined || el.dataset[key] === match[2]);
  });
  return {
    getElementById(id) { return byId.get(id) || null; },
    querySelectorAll,
    querySelector: selector => querySelectorAll(selector)[0] || null,
  };
}

async function boot(raw, published = {}) {
  const document = createDocument();
  const cache = new Map();
  const run = new AsyncFunction(
    'covariance', 'stats', 'optimize', 'validateInputs', 'demoData', 'normalizeFxHedge', 'renderHedgeMarkup', 'renderRiskMarkup',
    'defaultPolicy', 'validatePolicy', 'satisfiesPolicy', 'optimizeAllocation', 'samplePortfolios', 'initDataInfoUI', 'frontierTarget',
    'mountHedgeAnalytics', 'mountFxWorkspace', 'document', 'localStorage', 'fetch', 'setTimeout', 'clearTimeout',
    `${source}\nreturn { snapshot: () => structuredClone({data,state,results,chosen,frontierComparison}), dataInfoUI, hedgeAnalytics, fxWorkspace };`,
  );
  const app = await run(
    covariance, stats, optimize, validateInputs, demoData, normalizeFxHedge, renderHedgeMarkup, renderRiskMarkup,
    defaultPolicy, validatePolicy, satisfiesPolicy, optimizeAllocation, samplePortfolios, initDataInfoUI, frontierTarget,
    mountHedgeAnalytics, mountFxWorkspace, document, { getItem: key => cache.get(key) ?? null, setItem: (key, value) => cache.set(key, value) },
    async url => url === './data.json' ? { ok: true, json: async () => structuredClone(raw) }
      : url in published ? { ok: true, json: async () => structuredClone(published[url]) } : { ok: false, status: 404 },
    () => 1, () => {},
  );
  const get = id => {
    const el = document.getElementById(id);
    assert.ok(el, `Missing UI element ${id}`);
    return el;
  };
  const importData = async candidate => {
    const content = JSON.stringify(candidate);
    const target = { files: [{ size: Buffer.byteLength(content), text: async () => content }], value: 'selected.json' };
    await get('importFile').onchange({ target });
    assert.equal(target.value, '');
  };
  return { ...app, document, get, cache, importData };
}

const datasets = [['demo', demoData]];
if (process.env.BJE_TEST_DATA) {
  datasets.push(['external snapshot', JSON.parse(await fs.readFile(process.env.BJE_TEST_DATA, 'utf8'))]);
}

if(process.env.BJE_INFO_DATA){
  test('combined private snapshot updates Hedge and FX atomically and clears stale models on legacy imports',async()=>{
    const app=await boot(demoData),raw=JSON.parse(await fs.readFile(process.env.BJE_INFO_DATA,'utf8'));
    const portfolio=app.snapshot();app.dataInfoUI.apply(raw);
    assert.deepEqual(app.snapshot(),portfolio);
    assert.equal(app.hedgeAnalytics.getSnapshot().ratePairs.length,5);
    assert.equal(app.fxWorkspace.getAnalytics().spots.length,5);
    assert.equal(app.fxWorkspace.getModelSnapshot().meta.asOf,raw.fxModel.meta.asOf);
    assert.match(app.get('haCharts').innerHTML,/<svg/);assert.match(app.get('fxModelChart').innerHTML,/<svg/);
    const previous=app.dataInfoUI.getSnapshot(),model=app.fxWorkspace.getModelSnapshot(),bad=structuredClone(raw);
    bad.fxModel.forecast[0].lower95=bad.fxModel.forecast[0].upper95+1;
    assert.throws(()=>app.dataInfoUI.apply(bad));assert.equal(app.dataInfoUI.getSnapshot(),previous);assert.equal(app.fxWorkspace.getModelSnapshot(),model);
    const wrongHash=structuredClone(raw);wrongHash.fxModel.meta.provenance.primary.sha256='0'.repeat(64);assert.throws(()=>app.dataInfoUI.apply(wrongHash));
    const missingDate=structuredClone(raw),usd=missingDate.fxAnalytics.spots.find(s=>s.id==='usdkrw');usd.history=usd.history.filter(r=>r.date!==raw.fxModel.history[0].date);assert.throws(()=>app.dataInfoUI.apply(missingDate));
    await app.importData({...demoData,fxHedge:{unit:'annual_percent',source:'Synthetic replacement',pairs:[]}});
    assert.equal(app.hedgeAnalytics.getSnapshot(),null);assert.equal(app.fxWorkspace.getModelSnapshot(),model);
    app.dataInfoUI.apply(raw);
    const legacy=structuredClone(raw);delete legacy.fxAnalytics;delete legacy.fxModel;
    app.dataInfoUI.apply(legacy);assert.equal(app.hedgeAnalytics.getSnapshot(),null);assert.equal(app.fxWorkspace.getAnalytics(),null);assert.equal(app.fxWorkspace.getModelSnapshot(),null);
    assert.equal(app.get('fxModelCSV').disabled,true);assert.deepEqual(app.snapshot().state,portfolio.state);assert.deepEqual(app.snapshot().results,portfolio.results);
  });
}

test('risk selection stays synchronized with portfolio cards and model navigation is isolated', async () => {
  const app = await boot(demoData);
  const buttons = app.document.querySelectorAll('[data-tab]');
  assert.deepEqual(buttons.map(button => button.dataset.tab), ['overview', 'risk', 'assumptions', 'hedge', 'fxmodel']);
  const nav = name => buttons.find(button => button.dataset.tab === name);
  nav('risk').click();
  assert.equal(app.get('risk').hidden, false);
  assert.equal(app.get('overview').hidden, true);
  app.get('riskPortfolio').value = 'minVol';
  app.get('riskPortfolio').onchange();
  assert.equal(app.snapshot().chosen, 'minVol');
  assert.match(app.get('riskContent').innerHTML, /최소 변동성/);
  assert.doesNotMatch(app.get('riskContent').innerHTML, /NaN|Infinity|undefined/);
  assert.equal(app.document.querySelectorAll('[data-portfolio]').find(b => b.dataset.portfolio === 'minVol').getAttribute('aria-pressed'), 'true');
  nav('hedge').click();
  assert.equal(app.get('hedge').hidden, false);
  assert.equal(app.document.querySelector('.data-strip'), null);
  for (const tab of ['modelA', 'modelB', 'monitor']) {
    const button = app.document.querySelectorAll('[data-hedge-tab]').find(b => b.dataset.hedgeTab === tab);
    button.click();
    assert.equal(button.getAttribute('aria-pressed'), 'true');
    for (const panel of app.document.querySelectorAll('.hedge-panel')) assert.equal(panel.hidden, panel.id !== `hedge-${tab}`);
  }
  nav('fxmodel').click();
  assert.equal(app.get('fxmodel').hidden, false);
  assert.equal(app.get('hedge').hidden, true);
  assert.equal(app.get('overview').hidden, true);
  assert.equal(app.get('pageTitle').innerHTML, 'Currency');
  nav('overview').click();
  assert.equal(app.get('fxmodel').hidden, true);
  assert.equal(app.document.querySelector('.heading-actions'), null);
  nav('assumptions').click();
  assert.equal(app.get('assumptions').hidden, false);
  assert.equal(app.get('pageTitle').innerHTML, 'Capital Market Assumption');
  assert.equal(app.get('riskPortfolio').value, 'minVol');
});

test('FX imports preserve missing tenors, signs, dates and prior data on rejection', async () => {
  const app = await boot(demoData);
  const initial = app.get('hedgeGrid').innerHTML;
  assert.equal((initial.match(/데이터 없음/g) || []).length, 20);
  assert.doesNotMatch(initial, /2026-09-23|0\.00%/);
  const payload = {unit:'annual_percent', source:'<snapshot>', pairs:[
    {currency:'USDKRW', asOf:'2026-10-15', hedge3m:-1, hedge6m:-2, hedge12m:-3, fxVol:10},
    {currency:'JPYKRW', asOf:'2026-10-14', hedge3m:1, hedge6m:null, hedge12m:3, fxVol:0},
  ]};
  const importFx = async raw => {
    const body = JSON.stringify(raw);
    const target = {files:[{size:body.length, text:async () => body}], value:'fx.json'};
    await app.get('hedgeImportFile').onchange({target});
    assert.equal(target.value, '');
  };
  await importFx(payload);
  assert.equal(app.get('alert').hidden, true);
  const markup = app.get('hedgeGrid').innerHTML;
  assert.match(markup, /negative">-2\.00%/);
  assert.match(markup, /positive">\+1\.00%/);
  assert.match(markup, /2026-10-15/);
  assert.match(markup, /0\.00%/);
  assert.equal((markup.match(/데이터 없음/g) || []).length, 12);
  const broken = structuredClone(payload);
  broken.pairs[0].asOf = '2026-02-30';
  await importFx(broken);
  assert.equal(app.get('alert').hidden, false);
  assert.equal(app.get('hedgeGrid').innerHTML, markup);
  const invalidPortfolio = structuredClone(demoData);
  invalidPortfolio.fxHedge = broken;
  const prior = app.snapshot();
  await app.importData(invalidPortfolio);
  assert.deepEqual(app.snapshot(), prior);
  assert.equal(app.get('hedgeGrid').innerHTML, markup);
});

test('SAA group and asset limits constrain the frontier and reject infeasible edits transactionally', async () => {
  const app = await boot(demoData);
  const initial = app.snapshot();
  const groupField = (group, bound) => app.document.querySelectorAll('[data-saa-group]')
    .find(el => el.dataset.saaGroup === group && el.dataset.bound === bound);
  const assetField = (index, bound) => app.document.querySelectorAll('[data-saa-asset]')
    .find(el => Number(el.dataset.saaAsset) === index && el.dataset.bound === bound);
  groupField('bond', 'min').value = '70';
  groupField('equity', 'max').value = '20';
  groupField('alternative', 'max').value = '10';
  assetField(0, 'min').value = '10';
  app.get('saaApply').click();
  assert.equal(app.get('alert').hidden, true);
  const applied = app.snapshot();
  assert.equal(applied.state.policy.groups.bond.min, .7);
  assert.equal(applied.state.policy.bounds[0].min, .1);
  assert.notDeepEqual(applied.results.frontier, initial.results.frontier);
  assert.ok(applied.results.frontier.length > 1);
  for (const point of [...applied.results.frontier, applied.results.minVol, applied.results.maxSharpe]) {
    const bonds = point.weights.reduce((sum, weight, index) => sum + (index < 4 ? weight : 0), 0);
    assert.ok(bonds >= .7 - 1e-7);
    assert.ok(point.weights[4] + point.weights[5] <= .2 + 1e-7);
    assert.ok(point.weights[6] <= .1 + 1e-7);
    assert.ok(point.weights[0] >= .1 - 1e-7);
    assert.ok(Math.abs(point.weights.reduce((sum, weight) => sum + weight, 0) - 1) < 1e-8);
  }
  assert.equal(applied.results.target, null, 'The original 6% target is outside these limits');
  const previousChart = app.get('frontierChart').innerHTML;
  groupField('equity', 'min').value = '40';
  groupField('equity', 'max').value = '50';
  app.get('saaApply').click();
  assert.equal(app.get('alert').hidden, false);
  assert.deepEqual(app.snapshot(), applied);
  assert.equal(app.get('frontierChart').innerHTML, previousChart);
  app.get('saaReset').click();
  assert.equal(app.get('alert').hidden, true);
  assert.deepEqual(app.snapshot().state.policy, initial.state.policy);
});

test('TAA applied weights and chart exploration stay synchronized with allocation and risk', async () => {
  const app = await boot(demoData);
  const vectors = { taa1: [30, 20, 10, 10, 10, 10, 10], taa2: [20, 10, 10, 10, 15, 20, 15] };
  for (const field of app.document.querySelectorAll('[data-taa]')) {
    field.value = vectors[field.dataset.taa][Number(field.dataset.asset)];
  }
  app.get('taaApply').click();
  assert.equal(app.get('alert').hidden, true);
  let snapshot = app.snapshot();
  assert.equal(snapshot.chosen, 'taa1');
  assert.deepEqual(snapshot.results.taa1.weights, vectors.taa1.map(value => value / 100));
  assert.deepEqual(snapshot.results.taa2.weights, vectors.taa2.map(value => value / 100));
  assert.equal(app.get('selectedLabel').textContent, '비중1');
  app.get('selectTaa2').click();
  assert.equal(app.snapshot().chosen, 'taa2');
  assert.equal(app.get('riskPortfolio').value, 'taa2');
  assert.match(app.get('riskContent').innerHTML, /비중2/);
  assert.equal(app.get('selectTaa2').getAttribute('aria-pressed'), 'true');
  const beforeInvalid = app.snapshot();
  app.document.querySelectorAll('[data-taa]')[0].value = '29';
  app.get('taaApply').click();
  assert.equal(app.get('alert').hidden, false);
  assert.deepEqual(app.snapshot(), beforeInvalid);
  const previousAllocation = app.get('allocationTable').innerHTML;
  const points = app.document.querySelectorAll('[data-mix]');
  assert.ok(points.length >= 100, 'The chart should expose a useful feasible portfolio cloud');
  assert.ok(new Set(points.map(point => point.getAttribute('fill'))).size > 20, 'Sharpe should vary visibly across the cloud');
  points[Math.floor(points.length / 2)].click();
  snapshot = app.snapshot();
  assert.equal(snapshot.chosen, 'explored');
  assert.ok(snapshot.results.explored);
  assert.equal(app.get('riskPortfolio').value, 'explored');
  assert.equal(app.get('selectedLabel').textContent, '탐색 조합');
  assert.match(app.get('riskContent').innerHTML, /탐색 조합/);
  assert.notEqual(app.get('allocationTable').innerHTML, previousAllocation);
  assert.doesNotMatch(app.get('frontierChart').innerHTML, /NaN|Infinity|undefined/);
  const chosenWeights = snapshot.results.explored.weights;
  app.get('mixSlider').value = '0';
  app.get('mixSlider').oninput();
  assert.notDeepEqual(app.snapshot().results.explored.weights, chosenWeights);
});

test('SAA and TAA actions preserve unsaved drafts in the other section', async () => {
  const app = await boot(demoData);
  const groupField = () => app.document.querySelectorAll('[data-saa-group]')
    .find(el => el.dataset.saaGroup === 'equity' && el.dataset.bound === 'max');
  const weightField = index => app.document.querySelectorAll('[data-taa]')
    .find(el => el.dataset.taa === 'taa1' && Number(el.dataset.asset) === index);
  const meanField = () => app.document.querySelectorAll('[data-taa-moment]')
    .find(el => el.dataset.taaMoment === 'mu' && el.dataset.asset === '0');
  groupField().value = '30';
  app.get('saaSave').click();
  meanField().value = '4.3';
  app.get('taaSave').click();
  weightField(0).value = '30';
  weightField(1).value = '10';
  meanField().value = '4.8';
  for (const action of ['saaLoad', 'saaApply']) {
    app.get(action).click();
    assert.equal(app.get('alert').hidden, true);
    assert.equal(weightField(0).value, '30');
    assert.equal(weightField(1).value, '10');
    assert.equal(meanField().value, '4.8');
    assert.equal(app.snapshot().state.taa1[0], .25, 'An SAA action must not apply a TAA draft');
    assert.equal(app.snapshot().state.assets[0].mu, 3.4);
  }
  groupField().value = '45';
  for (const action of ['taaLoad', 'taaApply']) {
    app.get(action).click();
    assert.equal(app.get('alert').hidden, true);
    assert.equal(groupField().value, '45');
    assert.equal(app.snapshot().state.policy.groups.equity.max, .3, 'A TAA action must not apply an SAA draft');
  }
  assert.equal(app.snapshot().state.assets[0].mu, 4.3);
});

test('SAA and TAA slots load drafts, including saved moments, before explicit application', async () => {
  const app = await boot(demoData);
  const groupField = (group, bound) => app.document.querySelectorAll('[data-saa-group]')
    .find(el => el.dataset.saaGroup === group && el.dataset.bound === bound);
  const moment = (index, name) => app.document.querySelectorAll('[data-taa-moment]')
    .find(el => Number(el.dataset.asset) === index && el.dataset.taaMoment === name);
  groupField('equity', 'max').value = '30';
  app.get('saaPreset').value = '1';
  app.get('saaSave').click();
  assert.equal(app.get('alert').hidden, true);
  assert.equal(app.snapshot().state.policy.groups.equity.max, 1, 'Saving a draft does not apply it');
  groupField('equity', 'max').value = '50';
  app.get('saaLoad').click();
  assert.equal(groupField('equity', 'max').value, '30');
  assert.equal(app.snapshot().state.policy.groups.equity.max, 1);
  app.get('saaApply').click();
  assert.equal(app.snapshot().state.policy.groups.equity.max, .3);
  const originalMean = app.snapshot().state.assets[0].mu;
  moment(0, 'mu').value = '4.3';
  moment(0, 'vol').value = '4.1';
  app.get('taaPreset').value = '1';
  app.get('taaSave').click();
  assert.equal(app.get('alert').hidden, true);
  assert.equal(app.snapshot().state.assets[0].mu, originalMean);
  moment(0, 'mu').value = '5.5';
  app.get('taaLoad').click();
  assert.equal(moment(0, 'mu').value, '4.3');
  assert.equal(moment(0, 'vol').value, '4.1');
  assert.equal(app.snapshot().state.assets[0].mu, originalMean);
  app.get('taaApply').click();
  assert.equal(app.get('alert').hidden, true);
  assert.equal(app.snapshot().state.assets[0].mu, 4.3);
  assert.equal(app.snapshot().state.assets[0].vol, 4.1);
  assert.equal(app.snapshot().state.policy.groups.equity.max, .3);
});

for (const [label, raw] of datasets) {
  test(`${label}: startup renders selected data and finite portfolio markup`, async () => {
    const app = await boot(raw);
    assert.equal(app.get('alert').hidden, true, 'Data should initialize without demo fallback');
    assert.deepEqual(app.snapshot().data.assets.map(a => a.id), raw.assets.map(a => a.id));
    for (const id of ['portfolioCards', 'frontierChart', 'allocationTable', 'allocationDonut']) {
      assert.ok(app.get(id).innerHTML.length > 0);
      assert.doesNotMatch(app.get(id).innerHTML, /NaN|Infinity|undefined/);
    }
    if (raw.monthly) {
      assert.match(app.get('historyChart').innerHTML, /<svg/);
      assert.doesNotMatch(app.get('historyChart').innerHTML, /NaN|Infinity|undefined/);
      assert.equal(app.snapshot().data.monthly.dates.length, raw.monthly.base100.length);
      const start = raw.meta?.sampleStart || raw.meta?.periodStart;
      const end = raw.meta?.sampleEnd || raw.meta?.periodEnd;
      if (start && end) assert.deepEqual([app.snapshot().data.meta.sampleStart, app.snapshot().data.meta.sampleEnd], [start, end]);
    }
  });

  test(`${label}: feasible target applies and infeasible target is explicit`, async () => {
    const app = await boot(raw);
    const means = app.snapshot().state.assets.map(a => a.mu);
    const target = (Math.min(...means) + Math.max(...means)) / 2;
    app.get('targetInput').value = target;
    app.get('targetApply').click();
    assert.equal(app.get('alert').hidden, true);
    assert.equal(app.snapshot().chosen, 'target');
    assert.ok(Math.abs(app.snapshot().results.target.mu - target) < 1e-8);
    assert.ok(app.cache.size > 0);
    app.get('targetInput').value = Math.max(...means) + 1;
    app.get('targetApply').click();
    assert.equal(app.snapshot().results.target, null);
    assert.equal(app.get('alert').hidden, false);
    assert.match(app.get('portfolioCards').innerHTML, /달성 불가/);
    assert.equal(app.snapshot().chosen, 'current');
  });

  test(`${label}: rejected import preserves data, assumptions and previous results`, async () => {
    const app = await boot(raw);
    const previous = app.snapshot();
    const previousMarkup = app.get('portfolioCards').innerHTML;
    const bad = structuredClone(raw);
    // Regression: the former 1e-6 import tolerance accepted this while stats did not.
    const key = 'weight' in bad.assets[0] ? 'weight' : 'currentWeight';
    bad.assets[0][key] += 5e-7;
    bad.assets[0].name = 'Rejected replacement';
    await app.importData(bad);
    assert.equal(app.get('alert').hidden, false);
    assert.deepEqual(app.snapshot(), previous);
    assert.equal(app.get('portfolioCards').innerHTML, previousMarkup);
  });

  test(`${label}: invalid correlation leaves applied assumptions and results intact`, async () => {
    const app = await boot(raw);
    const previous = app.snapshot();
    const previousMarkup = app.get('portfolioCards').innerHTML;
    const field = app.document.querySelectorAll('[data-corr]')[0];
    assert.ok(field);
    field.value = '1.1';
    app.get('applyButton').click();
    assert.equal(app.get('alert').hidden, false);
    assert.deepEqual(app.snapshot(), previous);
    assert.equal(app.get('portfolioCards').innerHTML, previousMarkup);
  });

  test(`${label}: blank assumption is rejected without changing the applied portfolio`, async () => {
    const app = await boot(raw);
    const previous = app.snapshot();
    app.document.querySelectorAll('[data-field]')[0].value = '';
    app.get('applyButton').click();
    assert.equal(app.get('alert').hidden, false);
    assert.deepEqual(app.snapshot(), previous);
  });

}

const syntheticMarket=()=>({kind:'bje_data_info',schemaVersion:1,meta:{source:'synthetic DailyRate',asOf:'2026-10-16',latestObservation:'2026-10-15',sha256:'a'.repeat(64),units:{hedge:'source_value'}},market:{rates:[{id:'rate',label:'한국 3년',value:3,previous:2.9,change:.1,unit:'%',asOf:'2026-10-15',previousDate:'2026-10-14',source:'DailyRate!C'}],risk:[],fx:[]},bond:null,fxHedge:{unit:'source_value',source:'synthetic DailyRate',pairs:[{currency:'USDKRW',asOf:'2026-10-15',hedge3m:-1,hedge6m:-2,hedge12m:-3,fxVol:10,history:[{date:'2026-10-14',value:-1},{date:'2026-10-15',value:-2}]}]}});

test('published market snapshot loads at startup and a missing one leaves the default views', async()=>{
  const market=syntheticMarket(),app=await boot(demoData,{'./data/market.json':market});
  assert.equal(app.dataInfoUI.getSnapshot().meta.source,'synthetic DailyRate');
  assert.match(app.get('marketSnapshot').innerHTML,/한국 3년/);
  assert.equal(app.get('dataInfoError').hidden,true);
  const plain=await boot(demoData);
  assert.equal(plain.dataInfoUI.getSnapshot(),null);
  assert.equal(plain.get('dataInfoError').hidden,true);
  const broken=await boot(demoData,{'./data/market.json':{kind:'bje_data_info'}});
  assert.equal(broken.get('dataInfoError').hidden,false);
});

test('market import changes market and hedge views without touching applied portfolio assumptions', async()=>{
  const app=await boot(demoData);
  const prior=app.snapshot();
  const market=syntheticMarket();
  app.dataInfoUI.apply(market);
  assert.deepEqual(app.snapshot(),prior);
  assert.match(app.get('marketSnapshot').innerHTML,/한국 3년/);
  assert.match(app.get('hedgeGrid').innerHTML,/-2\.00<\/div>/);
  assert.match(app.get('hedgeUnit').textContent,/원자료 단위/);
  assert.match(app.get('hedgeHistograms').innerHTML,/2026-10-14 ~ 2026-10-15/);
  const previousMarkup=app.get('marketSnapshot').innerHTML, previousHedge=app.get('hedgeGrid').innerHTML;
  const invalid=structuredClone(market);invalid.market.rates[0].change=100;
  const body=JSON.stringify(invalid);
  await app.get('dataInfoImportFile').onchange({target:{files:[{size:body.length,text:async()=>body}],value:'invalid.json'}});
  assert.equal(app.get('dataInfoError').hidden,false);
  assert.equal(app.get('hedgeGrid').innerHTML,previousHedge);
  assert.deepEqual(app.snapshot(),prior);
  await app.importData(demoData);
  assert.equal(app.get('marketSnapshot').innerHTML,previousMarkup);
  assert.equal(app.get('hedgeGrid').innerHTML,previousHedge);
  assert.match(app.get('hedgeHistograms').innerHTML,/2026-10-14 ~ 2026-10-15/);
  assert.equal(app.dataInfoUI.getSnapshot().meta.source,'synthetic DailyRate');
});

test('asset and mix selection show efficient target deltas and selected annual moments', async () => {
  const app = await boot(demoData);
  assert.doesNotMatch(html.match(/<nav aria-label="주 메뉴">([\s\S]*?)<\/nav>/)[1], /<span|◈|◫|☷|⇄|⌁/);
  const baseline = app.snapshot().state;
  const assetButtons = app.document.querySelectorAll('[data-select-asset]');
  assert.equal(assetButtons.length, demoData.assets.length);
  assetButtons[0].click();
  let snap = app.snapshot();
  assert.equal(snap.chosen, 'asset');
  assert.deepEqual(snap.results.asset.weights, [1,0,0,0,0,0,0]);
  assert.equal(app.get('selectedLabel').textContent, demoData.assets[0].name);
  assert.equal(app.get('riskPortfolio').value, 'asset');
  assert.match(app.get('allocationLegend').innerHTML, /선택 %.*목표 %.*증감 %p/);
  assert.match(app.get('selectedMetrics').innerHTML, /기대수익.*3\.40.*변동성.*3\.80/);
  assert.ok(snap.frontierComparison.target.mu >= snap.results.asset.mu - 1e-7);
  assert.ok(snap.frontierComparison.target.vol <= snap.results.asset.vol + 1e-7);
  assert.match(app.get('frontierChart').innerHTML, /frontier-move/);
  const exactAsset = app.document.querySelectorAll('[data-chart-asset]').find(el => el.dataset.chartAsset === '4');
  exactAsset.onkeydown({key:'Enter', preventDefault(){}});
  snap = app.snapshot();
  assert.equal(snap.results.asset.weights[4], 1);
  app.get('frontierMode').value = 'same-return';
  app.get('frontierMode').onchange();
  snap = app.snapshot();
  assert.equal(snap.frontierComparison.mode, 'same-return');
  assert.ok(Math.abs(snap.frontierComparison.target.mu - snap.results.asset.mu) < 1e-7);
  assert.ok(snap.frontierComparison.target.vol < snap.results.asset.vol);
  const mixes = app.document.querySelectorAll('[data-mix]');
  mixes[Math.floor(mixes.length / 2)].click();
  snap = app.snapshot();
  assert.equal(snap.chosen, 'explored');
  assert.ok(Math.abs(snap.frontierComparison.deltas.reduce((sum,value)=>sum+value,0)) < 1e-8);
  assert.deepEqual(snap.state, baseline, 'Exploration must not change saved portfolio weights or assumptions');
});

test('SAA infeasibility clears stale frontier target while keeping selected portfolio metrics', async () => {
  const app = await boot(demoData);
  app.document.querySelectorAll('[data-select-asset]').find(el => el.dataset.selectAsset === '5').click();
  app.get('frontierMode').value = 'same-return';
  app.get('frontierMode').onchange();
  assert.ok(app.snapshot().frontierComparison.target);
  const equityMax=app.document.querySelectorAll('[data-saa-group]').find(el=>el.dataset.saaGroup==='equity'&&el.dataset.bound==='max');
  equityMax.value='0';app.get('saaApply').click();
  const snap=app.snapshot();
  assert.equal(snap.chosen,'asset');
  assert.equal(snap.frontierComparison.target,null);
  assert.match(app.get('allocationLegend').innerHTML,/—/);
  assert.doesNotMatch(app.get('frontierChart').innerHTML,/frontier-move/);
  assert.match(app.get('selectedMetrics').innerHTML,/기대수익.*8\.00.*변동성.*18\.00/);
  assert.equal(app.get('frontierCondition').classList.contains('warn'),true);
});

test('imported asset names remain plain text in selection markup', async () => {
  const raw=structuredClone(demoData);
  raw.assets[0].name='<img src=x onerror=alert(1)>"asset';
  const app=await boot(raw);
  app.document.querySelectorAll('[data-select-asset]')[0].click();
  for(const id of ['riskPortfolio','frontierChart','selectedMetrics','allocationLegend','assetSelectors']){
    assert.doesNotMatch(app.get(id).innerHTML,/<img src/);
    assert.match(app.get(id).innerHTML,/&lt;img/);
  }
  assert.equal(app.get('selectedLabel').textContent,raw.assets[0].name);
});

test('frontier axis zoom and auto reset preserve portfolio results and allocation', async () => {
  const app=await boot(demoData),before=app.snapshot();
  const allocation=app.get('allocationLegend').innerHTML,original=app.get('frontierChart').innerHTML;
  const apply=()=>app.get('frontierAxisForm').onsubmit({preventDefault(){}});
  for(const [id,value] of Object.entries({frontierXMin:2,frontierXMax:6,frontierYMin:-1,frontierYMax:5}))app.get(id).value=value;
  apply();
  const chart=app.get('frontierChart').innerHTML;
  assert.equal(app.get('frontierAxisError').hidden,true);
  assert.match(chart,/>-1\.00<\/text>/);
  assert.match(chart,/>6\.00<\/text>/);
  assert.match(chart,/clip-path="url\(#frontierPlotClip\)"/);
  assert.doesNotMatch(chart,/data-chart-asset="5"/,'Out-of-range asset must not remain a focusable plot target');
  assert.doesNotMatch(chart,/NaN|Infinity/);
  assert.notEqual(chart,original);
  assert.deepEqual(app.snapshot(),before);
  assert.equal(app.get('allocationLegend').innerHTML,allocation);
  app.get('coverage').onchange();
  assert.equal(app.get('frontierChart').innerHTML,chart);
  app.get('frontierAxisReset').click();
  assert.equal(app.get('frontierChart').innerHTML,original);
  for(const axis of ['X','Y'])for(const bound of ['Min','Max'])assert.equal(app.get(`frontier${axis}${bound}`).value,'');
});

test('invalid frontier ranges leave the last valid chart intact; either axis can stay automatic', async () => {
  const app=await boot(demoData),before=app.snapshot();
  const apply=()=>app.get('frontierAxisForm').onsubmit({preventDefault(){}});
  const previous=app.get('frontierChart').innerHTML;
  for(const [min,max] of [['2','2'],['6','2'],['-1','6'],['2',''],['Infinity','6'],['2','2.000000000001']]){
    app.get('frontierXMin').value=min;app.get('frontierXMax').value=max;apply();
    assert.equal(app.get('frontierAxisError').hidden,false);
    assert.equal(app.get('frontierChart').innerHTML,previous);
    assert.deepEqual(app.snapshot(),before);
  }
  app.get('frontierXMin').value='';app.get('frontierXMax').value='';
  app.get('frontierYMin').value='3.001';app.get('frontierYMax').value='3.005';apply();
  assert.equal(app.get('frontierAxisError').hidden,true);
  assert.match(app.get('frontierChart').innerHTML,/>3\.0010<\/text>/);
  assert.match(app.get('frontierChart').innerHTML,/>3\.0050<\/text>/);
  assert.doesNotMatch(app.get('frontierChart').innerHTML,/NaN|Infinity/);
  app.get('frontierYMin').value='';app.get('frontierYMax').value='';
  app.get('frontierXMin').value='0';app.get('frontierXMax').value='1e308';apply();
  assert.equal(app.get('frontierAxisError').hidden,true);
  assert.doesNotMatch(app.get('frontierChart').innerHTML,/NaN|Infinity/);
  app.get('frontierAxisReset').click();
  assert.equal(app.get('frontierChart').innerHTML,previous);
});
