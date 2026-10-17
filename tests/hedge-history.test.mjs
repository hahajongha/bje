import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeFxHedge} from '../dist/fx-hedge.mjs';
import {buildHistogram,selectHedgeSeries,renderHistogramMarkup,hedgeHistoryCSV,initDataInfoUI} from '../dist/data-info-ui.mjs';

function fixture() {
  return {unit:'source_value',source:'Synthetic DailyRate',pairs:[{
    currency:'USDKRW',asOf:'2026-10-15',hedge3m:2,hedge6m:4,hedge12m:6,fxVol:12,
    history:[{date:'2025-10-14',value:-6},{date:'2025-10-15',value:-4},{date:'2026-10-15',value:4}],
    tenorHistory:[
      {date:'2025-10-14',hedge3m:-4,hedge6m:-6,hedge12m:-8},
      {date:'2025-10-15',hedge3m:-2,hedge6m:-4,hedge12m:-6},
      {date:'2026-10-14',hedge3m:0,hedge6m:null,hedge12m:2},
      {date:'2026-10-15',hedge3m:2,hedge6m:4,hedge12m:6},
    ],
  }]};
}

test('tenor histories preserve missing observations, zeroes and source signs; average retains complete cases',()=>{
  const snapshot=normalizeFxHedge(fixture()),pair=snapshot.pairs[0];
  assert.equal(snapshot.unit,'source_value');
  assert.equal(pair.tenorHistory[2].hedge6m,null);
  assert.deepEqual(selectHedgeSeries(pair,'hedge3m').history.map(row=>row.value),[-4,-2,0,2]);
  assert.deepEqual(selectHedgeSeries(pair,'hedge6m').history.map(row=>row.value),[-6,-4,4]);
  assert.deepEqual(selectHedgeSeries(pair).history.map(row=>row.value),[-6,-4,4]);
  assert.equal(selectHedgeSeries(pair).current,4);
  assert.throws(()=>selectHedgeSeries(pair,'2Y'));
});

test('invalid tenor history and contradictions fail before the snapshot can be used',()=>{
  for(const mutate of [
    x=>x.pairs[0].tenorHistory={},
    x=>x.pairs[0].tenorHistory[0].date='2025-02-30',
    x=>x.pairs[0].tenorHistory[0].date='2026-10-16',
    x=>x.pairs[0].tenorHistory[1].date='2025-10-14',
    x=>x.pairs[0].tenorHistory[0].hedge3m='-4',
    x=>x.pairs[0].tenorHistory[0].hedge3m=Infinity,
    x=>x.pairs[0].tenorHistory[2]={date:'2026-10-14',hedge3m:null,hedge6m:null,hedge12m:null},
    x=>x.pairs[0].tenorHistory.at(-1).hedge3m=3,
    x=>x.pairs[0].tenorHistory[0].hedge3m=-3,
    x=>x.pairs[0].tenorHistory[0].hedge6m=null,
  ]) {
    const snapshot=fixture();mutate(snapshot);assert.throws(()=>normalizeFxHedge(snapshot));
  }
});

test('shared period applies inclusive cutoff to charts, statistics and CSV without synthesizing observations',()=>{
  const snapshot=normalizeFxHedge(fixture()),pair=snapshot.pairs[0];
  const series=selectHedgeSeries(pair,'hedge3m');
  const result=buildHistogram(series.history,series.current,'1',pair.asOf);
  assert.deepEqual(result.rows.map(row=>row.date),['2025-10-15','2026-10-14','2026-10-15']);
  assert.equal(result.mean,0);
  assert.equal(result.std,2); // Sample SD of [-2, 0, 2], denominator n - 1.
  assert.equal(result.percentile,100);
  assert.equal(result.bins.reduce((total,bin)=>total+bin.count,0),3);
  const csv=hedgeHistoryCSV(snapshot,'1','hedge3m');
  assert.equal(csv,'\ufeffdate,currency,tenor,premium,unit\r\n2025-10-15,USDKRW,3M,-2,source_value\r\n2026-10-14,USDKRW,3M,0,source_value\r\n2026-10-15,USDKRW,3M,2,source_value');
  assert.equal(hedgeHistoryCSV(snapshot,'1','average').split('\r\n').length,3);
  for(const view of ['distribution','history']) {
    const html=renderHistogramMarkup(snapshot,'1','hedge3m',view);
    assert.match(html,/2025-10-15 ~ 2026-10-15/);
    assert.match(html,/표본 σ/);
    assert.doesNotMatch(html,/2025-10-14|NaN|Infinity|undefined/);
    assert.match(html,/최근<\/span><strong>2\.00<\/strong>/);
  }
});

test('legacy v1 averages remain available while absent tenor histories stay empty',()=>{
  const legacy=fixture();delete legacy.pairs[0].tenorHistory;
  const snapshot=normalizeFxHedge(legacy),pair=snapshot.pairs[0];
  assert.equal(selectHedgeSeries(pair).history.length,3);
  assert.deepEqual(selectHedgeSeries(pair,'hedge3m'),{history:[],current:2});
  assert.equal(hedgeHistoryCSV(snapshot,'all','hedge3m'),'');
  assert.ok(hedgeHistoryCSV(snapshot,'all','average'));
  assert.match(renderHistogramMarkup(snapshot,'all','hedge3m','history'),/과거 관측값 없음/);
  assert.doesNotMatch(renderHistogramMarkup(snapshot,'all','hedge3m','history'),/<path/);
});

test('single observations have no sample SD and constant or missing data do not create nonfinite charts',()=>{
  const one=[{date:'2026-10-15',value:-3}];
  assert.equal(buildHistogram(one,-3,'1').std,null);
  assert.equal(buildHistogram(one,-3,'1').mean,-3);
  const two=[...one,{date:'2026-10-16',value:-3}];
  assert.equal(buildHistogram(two,-3,'1').std,0);
  assert.deepEqual(buildHistogram([],null,'1').rows,[]);
  const raw={unit:'annual_percent',pairs:[{currency:'USDKRW',asOf:'2026-10-15',hedge3m:-3,hedge6m:-3,hedge12m:-3,history:one,tenorHistory:[{date:'2026-10-15',hedge3m:-3,hedge6m:-3,hedge12m:-3}]}]};
  for(const view of ['distribution','history']){
    const markup=renderHistogramMarkup(normalizeFxHedge(raw),'1','hedge3m',view);
    assert.doesNotMatch(markup,/NaN|Infinity|undefined/);
    assert.match(markup,/최근 \(%\)/);
  }
});

test('monitoring controls update tenor, view, period and export availability together',()=>{
  const ids=['hedgeUnit','hedgeHistoryUnit','hedgeHistograms','dataInfoSource','marketSnapshot','bondReference','dataInfoError','dataInfoImportFile','hedgeHistoryPeriod','hedgeHistoryTenor','hedgeHistoryView','hedgeHistoryCSV'];
  const elements=Object.fromEntries(ids.map(id=>[id,{innerHTML:'',textContent:'',value:'',hidden:true,disabled:false}]));
  const ui=initDataInfoUI({document:{getElementById:id=>elements[id]}});
  ui.renderHedge(normalizeFxHedge(fixture()));
  assert.equal(elements.hedgeHistoryCSV.disabled,false);
  elements.hedgeHistoryPeriod.value='1';elements.hedgeHistoryPeriod.onchange();
  elements.hedgeHistoryTenor.value='hedge6m';elements.hedgeHistoryTenor.onchange();
  elements.hedgeHistoryView.value='history';elements.hedgeHistoryView.onchange();
  assert.equal(elements.hedgeHistoryUnit.textContent,'6M · 원자료 단위');
  assert.match(elements.hedgeHistograms.innerHTML,/USDKRW 6M 프리미엄 시계열/);
  assert.match(elements.hedgeHistograms.innerHTML,/2025-10-15 ~ 2026-10-15/);
  const legacy=fixture();delete legacy.pairs[0].tenorHistory;ui.renderHedge(normalizeFxHedge(legacy));
  assert.equal(elements.hedgeHistoryCSV.disabled,true);
  elements.hedgeHistoryTenor.value='average';elements.hedgeHistoryTenor.onchange();
  assert.equal(elements.hedgeHistoryCSV.disabled,false);
});
