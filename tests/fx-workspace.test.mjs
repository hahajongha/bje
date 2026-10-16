import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeFxAnalyticsSpots,selectFxSpotWindow,fxSpotStatistics,renderFxSpotChart,fxSpotCSV,mountFxWorkspace} from '../dist/fx-workspace.mjs';

function weekdayHistory(start='2023-01-02',count=600){
  const rows=[];let t=Date.parse(start+'T00:00:00Z'),value=100;
  while(rows.length<count){const d=new Date(t);if(d.getUTCDay()!==0&&d.getUTCDay()!==6){value*=Math.exp(rows.length%2?.01:-.01);rows.push({date:d.toISOString().slice(0,10),value});}t+=86400000;}
  return rows;
}
function fixture(){const history=weekdayHistory();return {schemaVersion:1,asOf:history.at(-1).date,source:'SYNTHETIC TEST ONLY',spots:['usdkrw','jpykrw','eurkrw','audkrw','dxy'].map(id=>({id,label:id,unit:id==='dxy'?'지수':'원',source:'fixture',history:structuredClone(history)}))};}
function tinyDocument(){
  const nodes=new Map();
  function node(id){
    const el={id,hidden:false,disabled:false,value:'',textContent:'',clientWidth:1040,options:[],attributes:{},setAttribute(k,v){this.attributes[k]=v;},click(){return this.onclick?.();},focus(){this.focused=true;}};
    Object.defineProperty(el,'innerHTML',{get(){return this.markup||'';},set(value){this.markup=value;for(const match of value.matchAll(/id="([^"]+)"/g))if(!nodes.has(match[1]))node(match[1]);for(const match of value.matchAll(/<select[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)){nodes.get(match[1]).options=[...match[2].matchAll(/<option value="([^"]+)"([^>]*)>/g)].map(m=>({value:m[1],disabled:false}));}}});
    nodes.set(id,el);return el;
  }
  node('fxWorkspaceHost');return {getElementById:id=>nodes.get(id),createElement:()=>node('download-link')};
}
function modelFixture(){
  const base=Date.UTC(2024,0,1),date=i=>new Date(base+i*86400000).toISOString().slice(0,10);
  return {schemaVersion:1,pair:'USDKRW',meta:{asOf:date(1),source:'SYNTHETIC TEST ONLY',n:2,start:date(0),end:date(1)},history:[{date:date(0),spot:100},{date:date(1),spot:100}],forecast:Array.from({length:63},(_,i)=>({date:date(i+2),mean:100,median:100,lower68:99,upper68:101,lower90:98,upper90:102,lower95:97,upper95:103,sigmaLog:.01,probs:[.5,.3,.2]})),model:{currentProbs:[.5,.3,.2],transition:[[.9,.05,.05],[.1,.8,.1],[.05,.05,.9]],regimes:[.9,.8,.9].map((p,i)=>({label:`국면 ${i+1}`,meanDailyPct:0,volDailyPct:.1,persistence:p}))}};
}

test('spot normalization rejects mixed/invalid series atomically and preserves immutable source quotes',()=>{
  const raw=fixture(),normalized=normalizeFxAnalyticsSpots(raw);assert.ok(Object.isFrozen(normalized.spots[0].history[0]));raw.spots[0].history[0].value=999;assert.notEqual(normalized.spots[0].history[0].value,999);
  const invalid=[r=>r.spots[0].history[0].value=null,r=>r.spots[0].history[0].value=0,r=>r.spots[0].history[0].value=Infinity,r=>r.spots[0].history[1].date=r.spots[0].history[0].date,r=>r.spots[0].history[0].date='2023-02-29',r=>r.spots[1].id='usdkrw',r=>r.asOf='2020-01-01',r=>r.spots[0].id='unknown',r=>r.spots[0].history=[]];
  for(const mutate of invalid){const bad=fixture();mutate(bad);assert.throws(()=>normalizeFxAnalyticsSpots(bad));}
  const short=fixture();short.spots=[short.spots[0]];assert.equal(normalizeFxAnalyticsSpots(short).spots.length,1);
});

test('realized 1Y volatility matches alternating return sample variance with exact observations',()=>{
  const spot=normalizeFxAnalyticsSpots(fixture()).spots[0],stats=fxSpotStatistics(spot),n=stats.volatilityObservations;
  const end=spot.history.at(-1).date,d=new Date(end+'T00:00:00Z');d.setUTCFullYear(d.getUTCFullYear()-1);
  const samples=spot.history.slice(1).filter(r=>r.date>d.toISOString().slice(0,10)).map(r=>Math.log(r.value/spot.history[spot.history.indexOf(r)-1].value));
  const mean=samples.reduce((sum,r)=>sum+r,0)/samples.length;
  const independentVariance=(samples.reduce((sum,r)=>sum+r*r,0)-samples.length*mean*mean)/(samples.length-1);
  assert.equal(n,samples.length);assert.equal(stats.volatilityCoverage,1);assert.ok(Math.abs(stats.volatility-Math.sqrt(independentVariance*252)*100)<1e-10);
  assert.ok(selectFxSpotWindow(spot,1).length<selectFxSpotWindow(spot,3).length);assert.equal(selectFxSpotWindow(spot,0).length,600);
});

test('volatility omits missing weekday bridges and requires full-year 80% weekday coverage',()=>{
  const spot=normalizeFxAnalyticsSpots(fixture()).spots[0],complete=fxSpotStatistics(spot),last=spot.history.length-1;
  const removed=spot.history.findLastIndex((r,i)=>i<last-3&&new Date(r.date+'T00:00:00Z').getUTCDay()===3);
  const missing={...spot,history:spot.history.filter((_,i)=>i!==removed)},stats=fxSpotStatistics(missing);
  assert.equal(stats.volatilityObservations,complete.volatilityObservations-2);
  const sparse={...spot,history:spot.history.filter((_,i)=>i%3!==0)};assert.equal(fxSpotStatistics(sparse).volatility,null);
  const short={...spot,history:spot.history.slice(-150)};assert.equal(fxSpotStatistics(short).volatility,null);
  const flat={...spot,history:spot.history.map(r=>({...r,value:100}))};assert.equal(fxSpotStatistics(flat).volatility,0);
});

test('chart handles flat/single quotes and escapes labels; CSV keeps source units and selected window',()=>{
  const raw=fixture();raw.spots[0].label='<img src=x onerror=1>';raw.spots[0].unit='원,"USD"';const normalized=normalizeFxAnalyticsSpots(raw),spot=normalized.spots[0];
  const svg=renderFxSpotChart(spot,1,360);assert.match(svg,/viewBox="0 0 360 320"/);assert.doesNotMatch(svg,/<img|NaN|Infinity|undefined/);assert.match(svg,/&lt;img/);
  const single={...spot,history:spot.history.slice(-1)};assert.doesNotMatch(renderFxSpotChart(single,1,400),/NaN|Infinity|undefined/);
  const csv=fxSpotCSV(normalized,'usdkrw',1);assert.ok(csv.startsWith('\ufeffdate,series,unit,value'));assert.match(csv,/"원,""USD"""/);assert.equal(csv.split('\r\n').length,selectFxSpotWindow(spot,1).length+1);
  assert.equal(fxSpotCSV(normalized,'unknown',1),'');
});

test('mounted FX workspace selects tabs/quotes/windows, keeps valid data after bad imports, and clears stale provenance',()=>{
  const doc=tinyDocument(),viewer=mountFxWorkspace(doc),get=id=>doc.getElementById(id),raw=fixture();
  viewer.installAnalytics(raw);assert.equal(viewer.getAnalytics().spots.length,5);assert.equal(get('fxSpotCSV').disabled,false);assert.match(get('fxSpotChart').innerHTML,/<svg/);
  get('fxSpotCard-jpykrw').onclick();assert.equal(get('fxSpotCurrency').value,'jpykrw');assert.equal(get('fxSpotChartHeading').textContent,'JPY/KRW');
  get('fxSpotYears').onchange({target:{value:'1'}});assert.match(get('fxSpotCards').innerHTML,/등락률 \(1Y\)/);
  const before=viewer.getAnalytics(),beforeChart=get('fxSpotChart').innerHTML,bad=fixture();bad.spots[0].history[0].value=-1;assert.throws(()=>viewer.installAnalytics(bad));assert.equal(viewer.getAnalytics(),before);assert.equal(get('fxSpotChart').innerHTML,beforeChart);
  viewer.installModel(modelFixture());assert.equal(viewer.getModelSnapshot().pair,'USDKRW');viewer.selectTab('model');assert.equal(get('fxModelPanel').hidden,false);assert.equal(get('fxMonitorPanel').hidden,true);assert.equal(get('fxModelTab').attributes['aria-selected'],'true');
  get('fxModelTab').onkeydown({key:'ArrowLeft',preventDefault(){}});assert.equal(get('fxMonitorPanel').hidden,false);assert.equal(get('fxMonitorTab').focused,true);
  viewer.clear();assert.equal(viewer.getAnalytics(),null);assert.equal(viewer.getModelSnapshot(),null);assert.equal(get('fxSpotCSV').disabled,true);assert.match(get('fxSpotSource').textContent,/미연결/);assert.equal(get('fxModelDetails').hidden,true);
});

test('partial spot snapshots leave missing currencies unavailable and safely reset on null',()=>{
  const doc=tinyDocument(),viewer=mountFxWorkspace(doc),raw=fixture();raw.spots=raw.spots.slice(0,1);viewer.installAnalytics(raw);doc.getElementById('fxSpotCard-dxy').onclick();assert.equal(doc.getElementById('fxSpotCSV').disabled,true);assert.match(doc.getElementById('fxSpotChart').innerHTML,/데이터 없음/);viewer.installAnalytics(null);assert.equal(viewer.getAnalytics(),null);assert.equal(mountFxWorkspace({getElementById(){return null;}}),null);
});
