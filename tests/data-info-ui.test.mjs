import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {normalizeDataInfo,renderMarketMarkup,renderBondMarkup,buildHistogram,renderHistogramMarkup,initDataInfoUI} from '../dist/data-info-ui.mjs';
import {normalizeFxHedge,renderHedgeMarkup} from '../dist/fx-hedge.mjs';

export function infoFixture() {
  return {
    kind:'bje_data_info',schemaVersion:1,
    meta:{source:'synthetic data_info · DailyRate',asOf:'2026-10-16',latestObservation:'2026-10-15',sha256:'a'.repeat(64),units:{hedge:'source_value'}},
    market:{
      rates:[{id:'rate',label:'한국 3년',value:3.12,previous:3.1,change:.02,unit:'%',asOf:'2026-10-15',previousDate:'2026-10-14',source:'DailyRate!C'}],
      risk:[{id:'risk',label:'변동성',value:12,previous:13,change:-1,unit:'pt',asOf:'2026-10-15',previousDate:'2026-10-14',source:'DailyRate!D'}],
      fx:[{id:'fx',label:'원/100엔',value:900,previous:null,change:null,unit:'원/100엔',asOf:'2026-10-15',previousDate:null,source:'DailyRate!E'}],
    },
    bond:{name:'KIS 종합채권',asOf:'2026-10-15',index:103,duration:4,convexity:20,totalReturnYtd:2,totalReturn1y:3,annualMean:5,annualVol:4,annualGeometricReturn:5,maxDrawdown:-1,periodStart:'2026-07-31',periodEnd:'2026-09-30',observations:2,monthly:[{date:'2026-07-31',index:100},{date:'2026-08-31',index:102},{date:'2026-09-30',index:101}],source:'DailyRate!JO:JQ'},
    fxHedge:{unit:'source_value',source:'DailyRate',pairs:[{currency:'USDKRW',asOf:'2026-10-15',hedge3m:-1,hedge6m:-2,hedge12m:-3,fxVol:12,volAsOf:'2026-10-15',volPeriod:'최근 1년 · 연율',history:[{date:'2025-09-10',value:-3},{date:'2026-10-14',value:-1},{date:'2026-10-15',value:-2}]}]},
  };
}

test('market snapshot validates dates, changes, missing fields and NaN before rendering',()=>{
  const fixture=infoFixture();
  const normalized=normalizeDataInfo(fixture);
  assert.equal(normalized.market.rates[0].value,3.12);
  for(const mutate of [
    x=>x.kind='portfolio',
    x=>x.meta.units.hedge='annual_percent',
    x=>x.meta.latestObservation='2026-10-17',
    x=>x.market.rates[0].value=NaN,
    x=>x.market.rates[0].change=.2,
    x=>x.market.rates[0].asOf='2026-02-30',
    x=>x.market.rates[0].previousDate='2026-10-15',
    x=>x.market.fx[0].change=0,
    x=>x.market.fx[0].unit=null,
    x=>x.market.fx[0].id='rate',
    x=>x.bond.monthly[1].date='2026-07-31',
    x=>x.bond.monthly[1].date='2026-08-15',
    x=>x.bond.monthly[2].date='2026-10-01',
    x=>x.bond.monthly[1].index=Infinity,
    x=>x.bond.observations=3,
    x=>x.bond.periodEnd='2026-09-29',
    x=>x.fxHedge.pairs[0].history.at(-1).value=0,
    x=>x.fxHedge.pairs[0].hedge6m=null,
  ]) {
    const bad=structuredClone(fixture);mutate(bad);assert.throws(()=>normalizeDataInfo(bad));
  }
});

test('source values have no percent suffix; annual hedge imports retain percent and FX vol always uses percent',()=>{
  const raw=infoFixture().fxHedge;
  let markup=renderHedgeMarkup(normalizeFxHedge(raw));
  assert.match(markup,/negative">-2\.00<\/div>/);
  assert.doesNotMatch(markup,/-2\.00%/);
  assert.match(markup,/12\.00%/);
  raw.unit='annual_percent';markup=renderHedgeMarkup(normalizeFxHedge(raw));
  assert.match(markup,/negative">-2\.00%/);
  const missing=infoFixture();missing.fxHedge.pairs[0].history.pop();missing.fxHedge.pairs[0].hedge6m=null;
  assert.doesNotThrow(()=>normalizeDataInfo(missing));
});

test('metric and source labels are escaped; rate change is percentage points',()=>{
  const input=infoFixture();input.market.rates[0].label='<img src=x onerror=alert(1)>';input.market.rates[0].source='<b>source</b>';input.bond.name='<script>x</script>';
  const normalized=normalizeDataInfo(input);
  const markup=renderMarketMarkup(normalized)+renderBondMarkup(normalized.bond);
  assert.match(markup,/0\.02 %p/);
  assert.match(markup,/&lt;img/);
  assert.match(markup,/&lt;script&gt;/);
  assert.doesNotMatch(markup,/<script>|<img|<b>source|NaN|Infinity|undefined/);
});

test('histograms conserve observations and show actual period; constant data and missing current remain finite',()=>{
  const history=infoFixture().fxHedge.pairs[0].history;
  const one=buildHistogram(history,-2,'1','2026-10-15');
  assert.equal(one.rows.length,2);assert.equal(one.bins.reduce((sum,bin)=>sum+bin.count,0),2);
  assert.equal(one.percentile,50);
  const all=buildHistogram(history,null,'all','2026-10-15');assert.equal(all.rows.length,3);assert.equal(all.percentile,null);
  const constant=buildHistogram(history.map(row=>({...row,value:2})),2,'all','2026-10-15');assert.ok(constant.max>constant.min);assert.equal(constant.bins.reduce((sum,bin)=>sum+bin.count,0),3);
  const html=renderHistogramMarkup(normalizeFxHedge(infoFixture().fxHedge),'1');
  assert.match(html,/2026-10-14 ~ 2026-10-15/);assert.match(html,/stroke-dasharray="5 3"/);assert.doesNotMatch(html,/NaN|Infinity|undefined/);
  assert.equal((html.match(/class="panel info-histogram"/g)||[]).length,4);
});

test('market import is atomic and period selections update active distributions',async()=>{
  const ids=['hedgeUnit','hedgeHistoryUnit','hedgeHistograms','dataInfoSource','marketSnapshot','bondReference','dataInfoError','dataInfoImportFile','hedgeHistoryPeriod'];
  const elements=Object.fromEntries(ids.map(id=>[id,{id,innerHTML:'',textContent:'',hidden:true,value:''}]));
  let appliedHedge=null;
  const ui=initDataInfoUI({document:{getElementById:id=>elements[id]},onHedge:next=>{appliedHedge=next;}});
  ui.apply(infoFixture());
  const before=elements.marketSnapshot.innerHTML, prior=ui.getSnapshot(), previousHedge=appliedHedge;
  const invalid=infoFixture();invalid.bond.monthly[0].index=0;
  const event={target:{value:'market.json',files:[{size:100,text:async()=>JSON.stringify(invalid)}]}};
  await elements.dataInfoImportFile.onchange(event);
  assert.equal(event.target.value,'');assert.equal(elements.dataInfoError.hidden,false);
  assert.equal(elements.marketSnapshot.innerHTML,before);assert.equal(ui.getSnapshot(),prior);assert.equal(appliedHedge,previousHedge);
  elements.hedgeHistoryPeriod.value='1';elements.hedgeHistoryPeriod.onchange();
  assert.match(elements.hedgeHistograms.innerHTML,/2026-10-14 ~ 2026-10-15/);
  const emptyData=infoFixture();emptyData.bond=null;emptyData.market={rates:[],risk:[],fx:[]};emptyData.fxHedge.pairs=[];
  ui.apply(emptyData);assert.equal(elements.dataInfoError.hidden,true);assert.match(elements.bondReference.innerHTML,/자료 미연결/);
  emptyData.bond={asOf:null,observations:0,monthly:[]};
  assert.equal(normalizeDataInfo(emptyData).bond,null);
  emptyData.bond.annualMean=3;
  assert.throws(()=>normalizeDataInfo(emptyData));
});

if(process.env.BJE_INFO_DATA) {
  test('external market snapshot validates and renders all sections without nonfinite values',async()=>{
    const raw=JSON.parse(await fs.readFile(process.env.BJE_INFO_DATA,'utf8'));
    const snapshot=normalizeDataInfo(raw);
    for(const markup of [renderMarketMarkup(snapshot),renderBondMarkup(snapshot.bond),renderHedgeMarkup(snapshot.fxHedge),renderHistogramMarkup(snapshot.fxHedge)])assert.doesNotMatch(markup,/NaN|Infinity|undefined/);
    assert.equal(snapshot.kind,'bje_data_info');
  });
}
