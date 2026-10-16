import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHedgeAnalytics,rateStatistics,correlation,renderRateCards,renderRateCharts,hedgeAnalyticsCSV,mountHedgeAnalytics } from '../dist/hedge-analytics.mjs';

const history=[
  {date:'2025-01-02',kr:2,us:2,hedge:1},
  {date:'2025-01-03',kr:3,us:2,hedge:3},
  {date:'2025-01-06',kr:4,us:2,hedge:5},
];
function fixture(){return {schemaVersion:1,asOf:'2025-01-06',source:'Synthetic test',hedgeUnit:'source_value',ratePairs:[{tenor:'PR',krSource:'Synthetic KR',usSource:'Synthetic US',history:structuredClone(history)}]};}
test('independent arithmetic example: residuals 1,2,3 have RMSE sqrt(14/3), sample Z=1',()=>{
  const s=rateStatistics(history,true);assert.equal(s.correlation,1);assert.equal(s.gap,3);assert.ok(Math.abs(s.rmse-Math.sqrt(14/3))<1e-14);assert.equal(s.z,1);
  const raw=rateStatistics(history);assert.equal(raw.correlation,1);assert.equal(raw.gap,null);assert.equal(raw.rmse,null);assert.equal(raw.z,null);
  const filtered=rateStatistics(history,true,'2025-01-03');assert.equal(filtered.n,2);assert.ok(Math.abs(filtered.z-Math.SQRT1_2)<1e-14);
  assert.equal(correlation([0,1,2],[5,3,1]),-1);assert.equal(correlation([1,1,1],[2,3,4]),null);
  assert.equal(rateStatistics([history[0]],true).z,null);assert.equal(rateStatistics([],true).rmse,null);
});
test('invalid dates, duplicate tenors, nonfinite values and detached unit assumptions are rejected',()=>{
  for(const mutate of [r=>r.ratePairs.push(r.ratePairs[0]),r=>r.ratePairs[0].history[1].date='2025-02-31',r=>r.ratePairs[0].history[0].kr=null,r=>r.ratePairs[0].history[0].hedge=Infinity,r=>r.ratePairs[0].history[1].date='2025-01-01',r=>r.hedgeUnit='annual_percent']){const r=fixture();mutate(r);assert.throws(()=>normalizeHedgeAnalytics(r));}
  const r=fixture(),copy=normalizeHedgeAnalytics(r);r.ratePairs[0].history[0].kr=999;assert.equal(copy.ratePairs[0].history[0].kr,2);
});
test('CSV retains raw-unit assumption and selected exact dates; charts handle constant/empty series',()=>{
  const raw=fixture();raw.ratePairs[0].krSource='<img onerror=x>';const s=normalizeHedgeAnalytics(raw);
  const csv=hedgeAnalyticsCSV(s,false,'2025-01-03').trim().split('\r\n').map(s=>s.split(','));assert.equal(csv.length,3);assert.equal(csv[1][1],'2025-01-03');assert.equal(csv[1][6],'source_value');assert.equal(csv[1][7],'');
  assert.match(hedgeAnalyticsCSV(s,true),/annual_percent_assumed,3/);
  const cards=renderRateCards(s);assert.match(cards,/&lt;img/);assert.doesNotMatch(cards,/<img/);
  for(const annual of [true,false])for(const rows of [history,[],history.map(r=>({...r,kr:2,us:2,hedge:0}))])assert.doesNotMatch(renderRateCharts({...s,ratePairs:[{...s.ratePairs[0],history:rows}]},annual,'','9999-01-01',400),/NaN|Infinity|undefined/);
});
test('unit assumption resets on a new import and malformed input preserves active data',()=>{
  const nodes=new Map();const node=id=>{const el={id,value:'',hidden:false,disabled:false,clientWidth:900};Object.defineProperty(el,'innerHTML',{get(){return this.html??'';},set(v){this.html=v;for(const m of v.matchAll(/id="([^"]+)"/g))if(!nodes.has(m[1]))node(m[1]);}});nodes.set(id,el);return el;};node('hedgeAnalyticsHost');
  const viewer=mountHedgeAnalytics({getElementById:id=>nodes.get(id)});viewer.install(fixture());nodes.get('haUnit').value='annual_percent';nodes.get('haUnit').onchange();assert.match(nodes.get('haCards').innerHTML,/연 % 가정/);
  const previous=viewer.getSnapshot(),bad=fixture();bad.ratePairs[0].history[0].date='bad';assert.throws(()=>viewer.install(bad));assert.equal(viewer.getSnapshot(),previous);
  viewer.install(fixture());assert.equal(nodes.get('haUnit').value,'source_value');viewer.install(null);assert.equal(viewer.getSnapshot(),null);assert.equal(nodes.get('haCSV').disabled,true);
});
