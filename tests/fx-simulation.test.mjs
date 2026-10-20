import test from 'node:test';
import assert from 'node:assert/strict';
import {simulateFx} from '../dist/fx-simulation.mjs';

function snapshot({means=[-.05, .02, .1], sigmas=[.3, .7, 1.5], transition=[[.9,.08,.02],[.04,.92,.04],[.03,.12,.85]], initial=[.2,.6,.2], horizon=63}={}) {
  const date = n => new Date(Date.UTC(2026,0,2 + n)).toISOString().slice(0,10);
  return {history:[{date:date(0),spot:1400}], forecast:Array.from({length:horizon},(_,i)=>({date:date(i+1)})),
    model:{currentProbs:initial,transition,regimes:means.map((mean,i)=>({meanDailyPct:mean,volDailyPct:sigmas[i]}))}};
}
const close = (actual, expected, tolerance=1e-10) => assert.ok(Math.abs(actual-expected)<=tolerance, `${actual} differs from ${expected} by ${Math.abs(actual-expected)} > ${tolerance}`);

test('seeded runs preserve input, regenerate exactly, and keep horizon and sample-count prefixes',()=>{
  const input=snapshot(),before=structuredClone(input),a=simulateFx(input,{paths:2000,seed:0});
  assert.deepEqual(input,before);assert.deepEqual(a,simulateFx(input,{paths:2000,seed:0}));
  assert.notDeepEqual(a.forecast,simulateFx(input,{paths:2000,seed:1}).forecast);
  const short=simulateFx(input,{paths:2000,seed:0,horizon:4,samplePaths:2});
  assert.deepEqual(short.forecast,a.forecast.slice(0,4));
  assert.deepEqual(short.samplePaths,a.samplePaths.slice(0,2).map(p=>({...p,values:p.values.slice(0,5)})));
  assert.equal(a.samplePaths.length,20);assert.equal(a.simulation.samplePathCount,20);
  assert.equal(a.simulation.meanEstimator,'arithmetic-price');assert.equal(a.simulation.meanMethod,'empirical-price');
  assert.equal(a.simulation.intervalMethod,'pointwise-empirical-quantiles');
  a.samplePaths.forEach(p=>{assert.equal(p.values.length,64);assert.equal(p.values[0],1400);p.values.forEach(v=>assert.ok(v>0&&Number.isFinite(v)));});
  for(const row of a.forecast){
    const ordered=[row.lower95,row.lower90,row.lower68,row.median,row.upper68,row.upper90,row.upper95];
    ordered.forEach((v,i)=>assert.ok(Number.isFinite(v)&&v>0&&(!i||v>=ordered[i-1])));
    close(row.probs.reduce((a,b)=>a+b,0),1,1e-12);
  }
});

test('deterministic cycling states prove transition-before-emission and cumulative level arithmetic',()=>{
  const input=snapshot({means:[1,2,-3],sigmas:[0,0,0],initial:[1,0,0],transition:[[0,1,0],[0,0,1],[1,0,0]],horizon:6});
  const run=simulateFx(input,{paths:1000});
  const logs=[.02,-.01,0,.02,-.01,0];
  run.forecast.forEach((row,i)=>{
    const expected=1400*Math.exp(logs[i]);
    for(const key of ['mean','median','lower68','upper68','lower90','upper90','lower95','upper95','analyticMean'])close(row[key],expected,1e-9);
    assert.equal(row.sigmaLog,0);assert.equal(row.meanSE,0);close(row.analyticSigmaLog,0,1e-9);
    assert.deepEqual(row.probs,Array.from({length:3},(_,j)=>j===(i+1)%3?1:0));
  });
  run.samplePaths.forEach(p=>logs.forEach((log,i)=>close(p.values[i+1],1400*Math.exp(log),1e-9)));
});

test('identical regimes match independently known lognormal moments and quantiles',()=>{
  const h=30,mu=.0003,sigma=.012,n=40000,input=snapshot({means:[mu*100,mu*100,mu*100],sigmas:[sigma*100,sigma*100,sigma*100],horizon:h});
  const run=simulateFx(input,{paths:n,seed:25}),row=run.forecast.at(-1),s=sigma*Math.sqrt(h);
  const analyticMean=1400*Math.exp(h*mu+s*s/2),median=1400*Math.exp(h*mu);
  const meanSE=analyticMean*Math.sqrt(Math.expm1(s*s)/n);
  close(row.analyticMean,analyticMean,1e-9);close(row.analyticSigmaLog,s,1e-12);
  close(row.mean,analyticMean,6*meanSE);
  close(row.median,median,6*median*s*Math.sqrt(Math.PI/(2*n)));
  close(row.meanSE,meanSE,.06*meanSE);close(row.sigmaLog,s,.03*s);
  const pairs=[['lower95',-1.95996398454005],['lower90',-1.64485362695147],['lower68',-.994457883209753],['upper68',.994457883209753],['upper90',1.64485362695147],['upper95',1.95996398454005]];
  pairs.forEach(([key,z])=>{const expected=median*Math.exp(s*z);close(row[key],expected,.008*expected);});
  assert.notEqual(row.mean,row.analyticMean,'displayed mean must come from simulated prices');
});

test('short mixed-state analytic benchmarks agree with exhaustive path enumeration',()=>{
  const input=snapshot({horizon:3}),run=simulateFx(input,{paths:40000,seed:731});
  const {regimes,transition,currentProbs}=input.model;
  for(let h=1;h<=3;h++){
    let exactMean=0,exactLogMean=0,exactLogSecond=0;
    const visit=(state,depth,weight,drift,variance)=>{
      if(depth===h){exactMean+=weight*1400*Math.exp(drift+variance/2);exactLogMean+=weight*drift;exactLogSecond+=weight*(variance+drift*drift);return;}
      for(let next=0;next<3;next++)visit(next,depth+1,weight*transition[state][next],drift+regimes[next].meanDailyPct/100,variance+(regimes[next].volDailyPct/100)**2);
    };
    currentProbs.forEach((weight,state)=>visit(state,0,weight,0,0));
    const row=run.forecast[h-1];close(row.analyticMean,exactMean,1e-9);close(row.analyticSigmaLog,Math.sqrt(exactLogSecond-exactLogMean**2),1e-12);
    close(row.mean,exactMean,6*row.meanSE);
  }
});

test('future snapshot values never influence simulation; tolerated probability sums are normalized consistently',()=>{
  const clean=snapshot({horizon:4}),changed=structuredClone(clean);
  changed.forecast.forEach(row=>Object.assign(row,{mean:999999,median:1,lower95:50000}));
  assert.deepEqual(simulateFx(changed,{paths:1000}),simulateFx(clean,{paths:1000}));
  const slightlyOff=snapshot({horizon:4});slightlyOff.model.currentProbs[0]+=.000001;
  slightlyOff.model.transition[0][0]+=.000001;
  const normalized=structuredClone(slightlyOff);
  normalized.model.currentProbs=normalized.model.currentProbs.map(p=>p/1.000001);
  normalized.model.transition[0]=normalized.model.transition[0].map(p=>p/1.000001);
  const a=simulateFx(slightlyOff,{paths:1000}),b=simulateFx(normalized,{paths:1000});
  a.forecast.forEach((r,i)=>{close(r.mean,b.forecast[i].mean,1e-10);close(r.analyticMean,b.forecast[i].analyticMean,1e-10);close(r.probs.reduce((x,y)=>x+y,0),1,1e-12);});
});

test('invalid configuration and nonfinite simulated distributions fail without clipping',()=>{
  const input=snapshot();
  for(const options of [{paths:0},{paths:40001},{paths:1.5},{seed:-1},{seed:Infinity},{seed:4294967296},{horizon:505},{horizon:64},{samplePaths:65}])assert.throws(()=>simulateFx(input,options));
  for(const mutate of [s=>s.model.currentProbs=[.9,.9,.9],s=>s.model.transition[0]=[-.1,.5,.6],s=>s.model.regimes[0].volDailyPct=NaN,s=>s.history[0].spot=0,s=>s.forecast[0].date='2026-02-30',s=>s.forecast[1].date=s.forecast[0].date]){
    const bad=structuredClone(input);mutate(bad);assert.throws(()=>simulateFx(bad,{paths:1000}));
  }
  const explosive=snapshot({means:[100,100,100],sigmas:[100,100,100],horizon:504});
  assert.throws(()=>simulateFx(explosive,{paths:1000}),/수치 범위/);
  assert.deepEqual(input,snapshot());
});
