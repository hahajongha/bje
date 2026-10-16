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
import { initDataInfoUI } from '../dist/data-info-ui.mjs';

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

async function boot(raw) {
  const document = createDocument();
  const cache = new Map();
  const run = new AsyncFunction(
    'covariance', 'stats', 'optimize', 'validateInputs', 'demoData', 'normalizeFxHedge', 'renderHedgeMarkup', 'renderRiskMarkup',
    'defaultPolicy', 'validatePolicy', 'satisfiesPolicy', 'optimizeAllocation', 'samplePortfolios', 'initDataInfoUI',
    'document', 'localStorage', 'fetch', 'setTimeout', 'clearTimeout',
    `${source}\nreturn { snapshot: () => structuredClone({data,state,results,chosen}), dataInfoUI };`,
  );
  const app = await run(
    covariance, stats, optimize, validateInputs, demoData, normalizeFxHedge, renderHedgeMarkup, renderRiskMarkup,
    defaultPolicy, validatePolicy, satisfiesPolicy, optimizeAllocation, samplePortfolios, initDataInfoUI,
    document, { getItem: key => cache.get(key) ?? null, setItem: (key, value) => cache.set(key, value) },
    async () => ({ ok: true, json: async () => structuredClone(raw) }),
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

test('risk selection stays synchronized with portfolio cards and model navigation is isolated', async () => {
  const app = await boot(demoData);
  const buttons = app.document.querySelectorAll('[data-tab]');
  assert.deepEqual(buttons.map(button => button.dataset.tab), ['risk', 'overview', 'assumptions', 'hedge', 'fxmodel']);
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
  assert.equal(app.get('pageTitle').innerHTML, '환율모형');
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

test('market import changes market and hedge views without touching applied portfolio assumptions', async()=>{
  const app=await boot(demoData);
  const prior=app.snapshot();
  const market={kind:'bje_data_info',schemaVersion:1,meta:{source:'synthetic DailyRate',asOf:'2026-10-16',latestObservation:'2026-10-15',sha256:'a'.repeat(64),units:{hedge:'source_value'}},market:{rates:[{id:'rate',label:'한국 3년',value:3,previous:2.9,change:.1,unit:'%',asOf:'2026-10-15',previousDate:'2026-10-14',source:'DailyRate!C'}],risk:[],fx:[]},bond:null,fxHedge:{unit:'source_value',source:'synthetic DailyRate',pairs:[{currency:'USDKRW',asOf:'2026-10-15',hedge3m:-1,hedge6m:-2,hedge12m:-3,fxVol:10,history:[{date:'2026-10-14',value:-1},{date:'2026-10-15',value:-2}]}]}};
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
