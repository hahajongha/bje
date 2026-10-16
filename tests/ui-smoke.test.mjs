/**
 * Node DOM-stub integration checks, not browser or visual QA.
 * The real app's event handlers, calculations, markup and CSV Blob run here.
 * Browser layout, native number-input behavior, downloads and persistence are
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

const html = await fs.readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
const source = (await fs.readFile(new URL('../dist/app.mjs', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function createDocument() {
  const byId = new Map();
  const roots = [];
  const groups = new Map();
  const downloads = [];

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
      click() {
        if (tag === 'a' && this.download) downloads.push({ download: this.download, href: this.href });
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
    downloads,
    getElementById(id) { return byId.get(id) || null; },
    querySelectorAll,
    querySelector: selector => querySelectorAll(selector)[0] || null,
    createElement: tag => element(tag),
  };
}

async function boot(raw) {
  const document = createDocument();
  const cache = new Map();
  const blobs = [];
  const run = new AsyncFunction(
    'covariance', 'stats', 'optimize', 'validateInputs', 'demoData',
    'document', 'localStorage', 'fetch', 'URL', 'Blob', 'setTimeout', 'clearTimeout',
    `${source}\nreturn { snapshot: () => structuredClone({data,state,results,chosen}) };`,
  );
  const app = await run(
    covariance, stats, optimize, validateInputs, demoData,
    document, { getItem: key => cache.get(key) ?? null, setItem: (key, value) => cache.set(key, value) },
    async () => ({ ok: true, json: async () => structuredClone(raw) }),
    { createObjectURL: blob => { blobs.push(blob); return `blob:test-${blobs.length}`; }, revokeObjectURL() {} },
    Blob, () => 1, () => {},
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
  return { ...app, document, get, blobs, cache, importData };
}

const datasets = [['demo', demoData]];
if (process.env.BJE_TEST_DATA) {
  datasets.push(['external snapshot', JSON.parse(await fs.readFile(process.env.BJE_TEST_DATA, 'utf8'))]);
}

for (const [label, raw] of datasets) {
  test(`${label}: startup renders selected data and finite portfolio markup`, async () => {
    const app = await boot(raw);
    assert.equal(app.get('alert').hidden, true, 'Data should initialize without demo fallback');
    assert.deepEqual(app.snapshot().data.assets.map(a => a.id), raw.assets.map(a => a.id));
    assert.equal(app.get('modeBadge').textContent.includes('DEMO'), !!raw.meta?.demo);
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
      if (start && end) assert.equal(app.get('dateLabel').textContent, `${start} — ${end}`);
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

  test(`${label}: CSV export creates a complete data Blob with safe asset text`, async () => {
    const app = await boot(raw);
    const escaped = structuredClone(raw);
    escaped.assets[0].name = '=unsafe,"quoted"';
    await app.importData(escaped);
    assert.equal(app.get('alert').hidden, true);
    app.get('exportButton').click();
    assert.equal(app.blobs.length, 1);
    assert.equal(app.document.downloads.length, 1);
    assert.equal(app.document.downloads[0].download, 'BJE-portfolio.csv');
    const csv = await app.blobs[0].text();
    const result = app.snapshot();
    const count = ['current', 'minVol', 'target', 'maxSharpe'].filter(key => result.results[key]).length;
    assert.equal(csv.split('\r\n').length, 1 + count * raw.assets.length);
    assert.match(csv, /"portfolio","asset","weight_pct"/);
    assert.ok(csv.includes('"\'=unsafe,""quoted"""'));
    assert.doesNotMatch(csv, /NaN|Infinity|undefined/);
    if (result.data.meta.sampleEnd) assert.ok(csv.includes(`"${result.data.meta.sampleEnd}"`));
  });
}
