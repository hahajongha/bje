import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFxModel, renderFxChart, renderFxRegimes, renderFxProbabilities, renderFxTable, fxModelCSV, selectFxWindow, mountFxModel } from '../dist/fx-model-ui.mjs';
function fixture() {
  const base=Date.UTC(2024,0,1),day=86400000,date=n=>new Date(base+n*day).toISOString().slice(0,10);
  const history=Array.from({length:600},(_,i)=>({date:date(i),spot:100+i*.01,probs:[.5,.3,.2]}));
  const forecast=Array.from({length:504},(_,i)=>({date:date(600+i),mean:106+i*.01,median:106+i*.01,lower68:104-i*.01,upper68:108+i*.03,lower90:102-i*.01,upper90:110+i*.03,lower95:100-i*.01,upper95:112+i*.03,sigmaLog:.02,probs:[.4,.3,.3]}));
  return {schemaVersion:1,pair:'USDKRW',meta:{asOf:date(599),source:'SYNTHETIC TEST ONLY',n:599,start:date(0),end:date(599)},history,forecast,model:{currentProbs:[.5,.3,.2],transition:[[.9,.05,.05],[.1,.8,.1],[.05,.05,.9]],regimes:[{label:'국면 1',meanDailyPct:0,volDailyPct:.1,persistence:.9},{label:'국면 2',meanDailyPct:.1,volDailyPct:.2,persistence:.8},{label:'국면 3',meanDailyPct:-.1,volDailyPct:.3,persistence:.9}]},validation:{summary:'Synthetic test'}};
}
test('FX snapshot is copied, frozen, and checks probability, interval, date, and state consistency',()=>{
  const raw=fixture(),s=normalizeFxModel(raw);assert.ok(Object.isFrozen(s));assert.ok(Object.isFrozen(s.forecast[0]));raw.history[0].spot=999;assert.equal(s.history[0].spot,100);
  for(const mutate of [r=>r.model.currentProbs=[.9,.9,.9],r=>r.forecast[0].lower95=999,r=>r.history[0].date='2024-02-31',r=>r.history[1].date=r.history[0].date,r=>r.model.regimes[0].persistence=.8,r=>r.meta.asOf='2020-01-01',r=>r.forecast[0].mean=Infinity,r=>r.forecast[0].probs=[.5,-.1,.6],r=>r.meta.n=2.5]){const bad=fixture();mutate(bad);assert.throws(()=>normalizeFxModel(bad));}
});
test('FX 21-day horizon truncation, SVG ranges, table endpoints, and escaping',()=>{
  const raw=fixture();raw.model.regimes[0].label='<img src=x onerror=alert(1)>';const s=normalizeFxModel(raw),w=selectFxWindow(s,3,1);assert.equal(w.forecast.length,63);assert.ok(w.history.length<600);
  const svg=renderFxChart(s,24,3,420);assert.match(svg,/viewBox="0 0 420 365"/);assert.match(svg,/95% 모형 예측구간/);assert.doesNotMatch(svg,/NaN|Infinity|undefined/);
  const rendered=renderFxRegimes(s);assert.doesNotMatch(rendered.cards,/<img/);assert.match(rendered.cards,/&lt;img/);
  assert.match(renderFxTable(s,3),new RegExp(s.forecast[62].date));
});
test('CSV exports selected history and every requested daily forecast with fixed columns',()=>{
  const s=normalizeFxModel(fixture()),csv=fxModelCSV(s,6,0),rows=csv.trim().split('\r\n').map(r=>r.split(','));assert.equal(rows.length,1+600+126);assert.equal(rows[0].length,15);rows.forEach(r=>assert.equal(r.length,15));assert.equal(rows.at(-1)[1],s.forecast[125].date);assert.equal(rows[1][0],'history');
});
test('historical probability chart renders three bounded states and shares the selected history window',()=>{
  const raw=fixture();raw.model.regimes[0].label='<img onerror=alert(1)>';const s=normalizeFxModel(raw);
  const chart=renderFxProbabilities(s,1,420),window=selectFxWindow(s,12,1).history;
  assert.match(chart,/viewBox="0 0 420 280"/);assert.equal((chart.match(/<path data-state=/g)||[]).length,3);
  assert.match(chart,new RegExp(`${window[0].date} ~ ${window.at(-1).date}`));assert.doesNotMatch(chart,new RegExp(`${s.history[0].date} ~`));
  assert.match(chart,/>0%<\/text>/);assert.match(chart,/>100%<\/text>/);assert.match(chart,/&lt;img/);assert.doesNotMatch(chart,/<img|NaN|Infinity|undefined/);
  assert.match(renderFxProbabilities(s,0,Infinity),/viewBox="0 0 1040 280"/);
  const paths=[...chart.matchAll(/<path[^>]+ d="([^"]+)"/g)].map(m=>m[1]);
  for(const path of paths)for(const point of path.matchAll(/[ML]([\d.]+),([\d.]+)/g)){assert.ok(+point[1]>=58&&+point[1]<=396);assert.ok(+point[2]>=20&&+point[2]<=238);}
});
test('missing historical probabilities make gaps, not interpolated state assignments',()=>{
  const raw=fixture();delete raw.history[150].probs;raw.history[450].probs=null;
  const s=normalizeFxModel(raw),chart=renderFxProbabilities(s,0);
  const paths=[...chart.matchAll(/<path[^>]+ d="([^"]+)"/g)].map(m=>m[1]);assert.equal(paths.length,3);
  for(const path of paths){assert.equal((path.match(/M/g)||[]).length,3);assert.equal((path.match(/[ML]/g)||[]).length,598);}
  raw.history.forEach(row=>delete row.probs);const empty=normalizeFxModel(raw);
  assert.match(renderFxProbabilities(empty,1),/확률 데이터 미연결/);assert.doesNotMatch(renderFxProbabilities(empty,1),/<svg|NaN|undefined/);
  raw.history.at(-1).probs=[.5,.3,.2];const isolated=renderFxProbabilities(normalizeFxModel(raw),1);
  assert.equal((isolated.match(/<circle data-state=/g)||[]).length,3);assert.doesNotMatch(isolated,/<path|NaN|undefined/);
});
test('partial or malformed probability arrays are rejected at import and not plotted directly',()=>{
  for(const invalid of [[.5,.5],[.2,.2,.2],[NaN,.5,.5],[null,.5,.5],[-.1,.6,.5]]){
    const raw=fixture();raw.history[100].probs=invalid;assert.throws(()=>normalizeFxModel(raw),/과거 국면 확률/);
    const rendered=renderFxProbabilities(raw,0);assert.doesNotMatch(rendered,/NaN|undefined/);
    const paths=[...rendered.matchAll(/<path[^>]+ d="([^"]+)"/g)].map(m=>m[1]);assert.equal(paths.length,3);paths.forEach(path=>assert.equal((path.match(/M/g)||[]).length,2));
  }
});

function tinyDocument() {
  const nodes=new Map();
  function node(id){
    const el={id,hidden:false,disabled:false,value:'',textContent:'',clientWidth:1040,options:[],attributes:{},setAttribute(k,v){this.attributes[k]=v;},click(){return this.onclick?.();}};
    Object.defineProperty(el,'innerHTML',{get(){return this.markup||'';},set(value){this.markup=value;for(const match of value.matchAll(/id="([^"]+)"/g))if(!nodes.has(match[1]))node(match[1]);for(const match of value.matchAll(/<select[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)){nodes.get(match[1]).options=[...match[2].matchAll(/<option value="([^"]+)"([^>]*)>/g)].map(m=>({value:m[1],disabled:false}));}}});
    nodes.set(id,el);return el;
  }
  node('fxModelHost');return {getElementById:id=>nodes.get(id),createElement:()=>node('download-link')};
}
test('FX real mount imports, switches chart/table controls, preserves data on malformed import, and surfaces warnings',async()=>{
  const document=tinyDocument(),viewer=mountFxModel(document),get=id=>document.getElementById(id),raw=fixture();
  raw.meta.warnings=['Synthetic warning'];raw.model.diagnostics={converged:false};
  const importFile=async candidate=>{const content=JSON.stringify(candidate),target={files:[{size:content.length,text:async()=>content}],value:'selected.json'};await get('fxModelFile').onchange({target});assert.equal(target.value,'');};
  await importFile(raw);assert.ok(viewer.getSnapshot());assert.equal(get('fxModelError').hidden,true);assert.equal(get('fxModelWarning').hidden,false);assert.equal(get('fxModelWarning').textContent,'Synthetic warning');assert.equal(get('fxModelCSV').disabled,false);
  get('fxModelCoverage').onchange({target:{value:'68'}});assert.equal(get('fxLegend90').hidden,true);assert.equal(get('fxLegend95').hidden,true);assert.match(get('fxModelChart').innerHTML,/음영은 68%/);
  get('fxModelHorizon').onchange({target:{value:'3'}});assert.match(get('fxModelMetrics').innerHTML,/3개월 평균 전망/);
  assert.match(get('fxModelProbabilities').innerHTML,/<svg/);const fullProbabilities=get('fxModelProbabilities').innerHTML;
  get('fxModelHistory').onchange({target:{value:'1'}});assert.notEqual(get('fxModelProbabilities').innerHTML,fullProbabilities);
  get('fxModelTableButton').onclick();assert.equal(get('fxModelTable').hidden,false);assert.equal(get('fxModelTableButton').attributes['aria-expanded'],'true');
  const before=viewer.getSnapshot(),beforeChart=get('fxModelChart').innerHTML;const bad=fixture();bad.forecast[0].probs=[1,1,1];await importFile(bad);assert.equal(get('fxModelError').hidden,false);assert.equal(viewer.getSnapshot(),before);assert.equal(get('fxModelChart').innerHTML,beforeChart);
  const corrected=fixture();await importFile(corrected);assert.equal(get('fxModelError').hidden,true);assert.equal(get('fxModelWarning').hidden,true);
});
test('FX viewer clear and install(null) remove the preceding dataset without remounting',()=>{
  const document=tinyDocument(),viewer=mountFxModel(document),get=id=>document.getElementById(id),raw=fixture();
  raw.meta.warnings=['Synthetic warning'];viewer.install(raw);get('fxModelTableButton').onclick();
  const historyHandler=get('fxModelHistory').onchange,importHandler=get('fxModelFile').onchange;
  assert.equal(viewer.clear(),null);assert.equal(viewer.getSnapshot(),null);
  for(const id of ['fxModelMetrics','fxModelTable','fxModelRegimes','fxModelProbabilities','fxModelTransition','fxModelMethod'])assert.equal(get(id).innerHTML,'');
  for(const id of ['fxModelError','fxModelWarning','fxModelDetails','fxModelTable'])assert.equal(get(id).hidden,true);
  assert.equal(get('fxModelCSV').disabled,true);assert.equal(get('fxModelTableButton').disabled,true);assert.equal(get('fxModelTableButton').attributes['aria-expanded'],'false');
  assert.equal(get('fxModelSource').textContent,'데이터 미연결');assert.equal(get('fxModelSample').textContent,'');assert.match(get('fxModelChart').innerHTML,/전망 데이터 미연결/);
  assert.equal(get('fxModelHistory').onchange,historyHandler);assert.equal(get('fxModelFile').onchange,importHandler);
  viewer.install(fixture());assert.ok(viewer.getSnapshot());assert.equal(get('fxModelCSV').disabled,false);assert.equal(get('fxModelTable').hidden,true);
  assert.equal(viewer.install(null),null);assert.equal(viewer.getSnapshot(),null);assert.equal(get('fxModelDetails').hidden,true);
  get('fxModelHistory').onchange({target:{value:'1'}});assert.equal(get('fxModelProbabilities').innerHTML,'');
});
test('importing the viewer module does not auto-mount a second host',async()=>{
  const original=globalThis.document;globalThis.document={getElementById(){assert.fail('unexpected automatic mount');}};
  try{await import('../dist/fx-model-ui.mjs?manual-mount-only');}finally{if(original===undefined)delete globalThis.document;else globalThis.document=original;}
});
if(process.env.BJE_TEST_FX){
  test('external private FX snapshot imports through actual UI mount',async()=>{
    const fs=await import('node:fs/promises'),raw=JSON.parse(await fs.readFile(process.env.BJE_TEST_FX,'utf8')),doc=tinyDocument(),viewer=mountFxModel(doc);viewer.install(raw);assert.equal(viewer.getSnapshot().pair,'USDKRW');assert.match(doc.getElementById('fxModelChart').innerHTML,/<svg/);assert.doesNotMatch(doc.getElementById('fxModelChart').innerHTML,/NaN|undefined/);assert.match(doc.getElementById('fxModelMethod').innerHTML,/1기간 OOS/);assert.match(doc.getElementById('fxModelSample').textContent,/환율관측/);
  });
}
