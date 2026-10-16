import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHedgeFx, annualPremiumEnabled, alignHedgeRates, hedgeDiagnostics, hedgeScenario, realizedFxVol, renderHedgeModelA } from '../dist/hedge-lab.mjs';

function source(){return {schemaVersion:1,source:'data_info',asOf:'2026-10-15',unit:'source_value',unitVerified:false,pairs:[{currency:'USDKRW',history:[{date:'2026-10-12',spot:1400,hedge3m:-1,hedge6m:-2,hedge12m:-3,hedgeMean:-2},{date:'2026-10-13',spot:null,hedge3m:0,hedge6m:1,hedge12m:2,hedgeMean:1},{date:'2026-10-15',spot:1410,hedge3m:1,hedge6m:2,hedge12m:3,hedgeMean:2}]}],usdRates:[{date:'2026-10-12',kr3m:2,us3m:4},{date:'2026-10-14',kr3m:3,us3m:4},{date:'2026-10-15',kr3m:5,us3m:3}]};}
const near=(actual,expected,tolerance=1e-10)=>assert.ok(Math.abs(actual-expected)<tolerance,`${actual} != ${expected}`);
test('strict sparse normalization preserves source metadata and rejects bad ordering/means',()=>{
  const raw=source(),s=normalizeHedgeFx(raw);assert.equal(s.pairs[0].history[1].spot,null);assert.equal(s.unitVerified,false);assert.ok(Object.isFrozen(s.pairs[0].history));raw.pairs[0].history[0].spot=1;assert.equal(s.pairs[0].history[0].spot,1400);
  const bad=source();bad.pairs[0].history.reverse();assert.throws(()=>normalizeHedgeFx(bad),/日期|날짜/);
  const invalid=source();invalid.pairs[0].history[0].hedgeMean=-1;assert.throws(()=>normalizeHedgeFx(invalid),/평균/);
  const invalidDate=source();invalidDate.asOf='2026-02-30';assert.throws(()=>normalizeHedgeFx(invalidDate),/기준일/);
  const invalidNumber=source();invalidNumber.pairs[0].history[0].spot=Infinity;assert.throws(()=>normalizeHedgeFx(invalidNumber),/spot/);
  const trailing=source();trailing.pairs[0].asOf='2026-10-13';trailing.pairs[0].history[2]={date:'2026-10-15',spot:null,hedge3m:null,hedge6m:null,hedge12m:null,hedgeMean:null};assert.equal(normalizeHedgeFx(trailing).pairs[0].history.length,3);
});
test('inner-date alignment never forward fills rates or premium',()=>{
  const rows=alignHedgeRates(normalizeHedgeFx(source()),'3M');assert.deepEqual(rows.map(r=>r.date),['2026-10-12','2026-10-15']);assert.deepEqual(rows.map(r=>r.difference),[-2,2]);assert.equal(alignHedgeRates(normalizeHedgeFx(source()),'3M','2026-10-13').length,1);
});
test('unit uncertainty blocks gap diagnostics while preserving association',()=>{
  const rows=[{difference:0,premium:1},{difference:1,premium:2},{difference:2,premium:4}];
  const unknown=hedgeDiagnostics(rows);assert.equal(unknown.gap,null);assert.equal(unknown.rmse,null);assert.equal(unknown.zScore,null);near(unknown.correlation,3/Math.sqrt(28/3));
  const assumed=hedgeDiagnostics(rows,true);near(assumed.rmse,Math.sqrt(2));near(assumed.gap,2);near(assumed.zScore,2/Math.sqrt(3));
  const s=normalizeHedgeFx(source());assert.equal(annualPremiumEnabled(s),false);assert.equal(annualPremiumEnabled(s,'annual_percent'),true);assert.equal(annualPremiumEnabled({...s,unit:'annual_percent'}),false);assert.equal(annualPremiumEnabled({...s,unit:'annual_percent',unitVerified:true}),true);
  assert.match(renderHedgeModelA(s),/단위 확인/);assert.doesNotMatch(renderHedgeModelA(s),/CIP/);
});
test('constant sequences have undefined correlation/z and exact zero RMS error',()=>{
  const rows=Array.from({length:4},()=>({difference:2,premium:2}));assert.deepEqual(hedgeDiagnostics(rows,true),{n:4,correlation:null,rmse:0,gap:0,zScore:null});
});
const base={muAsset:4,volAsset:8,muFx:3,volFx:6,correlation:0,hedgeRatio:.5,premium:-2,horizonMonths:12};
test('hedging endpoints agree with exposure identities and signed carry',()=>{
  const zero=hedgeScenario({...base,hedgeRatio:0});near(zero.annualReturn,7);near(zero.annualVol,10);
  const full=hedgeScenario({...base,hedgeRatio:1,correlation:-.9,volFx:55});near(full.annualReturn,2);near(full.annualVol,8);
  near(hedgeScenario({...base,hedgeRatio:1,premium:2}).annualReturn,6);
  const unknown=hedgeScenario({...base,premium:null});assert.equal(unknown.annualReturn,null);near(unknown.annualVol,Math.sqrt(73));assert.equal(hedgeScenario({...base,hedgeRatio:0,premium:null}).annualReturn,7);
});
test('perfect negative covariance cancels and positive covariance adds volatility',()=>{
  near(hedgeScenario({...base,hedgeRatio:0,volAsset:6,correlation:-1}).annualVol,0);
  near(hedgeScenario({...base,hedgeRatio:0,correlation:1}).annualVol,14);
  near(hedgeScenario({...base,volAsset:3,hedgeRatio:.5,correlation:-1}).annualVol,0);
  const quarter=hedgeScenario({...base,horizonMonths:3}),year=hedgeScenario(base);near(quarter.periodReturn,year.annualReturn/4);near(quarter.periodVol,year.annualVol/2);
  assert.throws(()=>hedgeScenario({...base,correlation:1.01}),/상관계수/);assert.throws(()=>hedgeScenario({...base,volFx:-1}),/환변동성/);assert.throws(()=>hedgeScenario({...base,hedgeRatio:1.01}),/헤지비율/);assert.throws(()=>hedgeScenario({...base,muFx:NaN}),/환수익률/);
});
test('FX volatility uses 253 complete prices, is quotation invariant, and never bridges missing spots',()=>{
  const rows=Array.from({length:253},(_,i)=>({date:new Date(Date.UTC(2026,0,i+1)).toISOString().slice(0,10),spot:1400*Math.exp(.01*(i%2))}));
  const returns=Array.from({length:252},(_,i)=>i%2===0?.01:-.01),expected=Math.sqrt(returns.reduce((s,v)=>s+v*v,0)/251*252)*100;
  near(realizedFxVol(rows),expected);near(realizedFxVol(rows.map(r=>({...r,spot:r.spot*100}))),expected);assert.equal(realizedFxVol(rows.slice(0,252)),null);
  const missing=rows.map(r=>({...r}));missing[100].spot=null;assert.equal(realizedFxVol(missing),null);assert.equal(realizedFxVol(rows,rows[251].date),null);
});
