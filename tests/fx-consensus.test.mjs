import test from 'node:test';
import assert from 'node:assert/strict';
import {futureQuarters,annualRealizedVol,summarizeConsensus,buildRandomWalk,renderConsensusChart,consensusCSV,mountFxConsensus} from '../dist/fx-consensus.mjs';

const near=(actual,expected,tolerance=1e-10)=>assert.ok(Math.abs(actual-expected)<tolerance,`${actual} != ${expected}`);
function pairFixture(){
  const base=Date.UTC(2025,1,10)-252*86400000,history=[];let spot=1000;
  for(let i=0;i<=252;i++){if(i)spot*=Math.exp(i%2?0.01:-0.01);history.push({date:new Date(base+i*86400000).toISOString().slice(0,10),spot,hedge3m:null,hedge6m:null,hedge12m:null,hedgeMean:null});}
  return {currency:'USDKRW',spotUnit:'원/USD',history,asOf:history.at(-1).date};
}
const snapshot=()=>({schemaVersion:1,source:'SYNTHETIC TEST ONLY',asOf:'2025-02-10',unit:'source_value',unitVerified:false,pairs:[pairFixture()],usdRates:[]});

test('quarter schedule uses real quarter ends and excludes an already ended quarter',()=>{
  assert.deepEqual(futureQuarters('2026-03-31',4).map(r=>r.date),['2026-06-30','2026-09-30','2026-12-31','2027-03-31']);
  assert.equal(futureQuarters('2026-10-16',12).at(-1).date,'2029-09-30');
  assert.equal(futureQuarters('2024-02-29',1)[0].date,'2024-03-31');
  assert.throws(()=>futureQuarters('2026-02-31'));assert.throws(()=>futureQuarters('2026-10-16',13));
});
test('realized vol uses sample variance and rejects missing source spots instead of bridging quotes',()=>{
  const pair=pairFixture(),vol=annualRealizedVol(pair);
  // 126 positive and 126 negative returns: exact centered sum of squares = 252 * .01².
  near(vol.sigma,Math.sqrt(252*.01**2/251*252));assert.equal(vol.observations,252);
  const bad={...pair,history:pair.history.map(r=>({...r,spot:null}))};assert.equal(annualRealizedVol(bad).sigma,null);
  assert.equal(annualRealizedVol({...pair,history:pair.history.slice(0,20)}).sigma,null);
  const missing={...pair,history:pair.history.map((row,i)=>i===20?{...row,spot:null}:row)};assert.equal(annualRealizedVol(missing).sigma,null);assert.equal(annualRealizedVol(missing).incomplete,true);
  const many={...pair,history:Array.from({length:300},(_,i)=>({date:new Date(Date.UTC(2024,0,1)+i*86400000).toISOString().slice(0,10),spot:i===0?null:1000}))};assert.equal(annualRealizedVol(many).observations,252);assert.equal(annualRealizedVol(many).sigma,0);
});
test('consensus mean, sample disagreement, sparse inputs and historical range have distinct definitions',()=>{
  const pair=pairFixture(),q=futureQuarters(pair.asOf,4),estimates={[q[0].date]:[1000,1100,null,''],[q[1].date]:[1200]};
  const result=summarizeConsensus(pair,estimates,4);near(result.rows[0].mean,1050);near(result.rows[0].disagreement,Math.sqrt(5000));assert.equal(result.rows[0].n,2);
  near(result.rows[0].consensusHigh,1050+Math.sqrt(5000));assert.equal(result.rows[1].disagreement,null);assert.equal(result.rows[2].mean,null);
  near(Math.log(result.rows[0].volHigh/result.last.spot),result.vol.sigma*Math.sqrt(q[0].years));
  assert.throws(()=>summarizeConsensus(pair,{[q[0].date]:[-10]}));
});
test('log random walk keeps median constant and respects lognormal mean and 95% bounds',()=>{
  const pair=pairFixture(),result=buildRandomWalk(pair,4,95),end=result.rows.at(-1),variance=result.vol.sigma**2*end.years;
  near(end.median,result.last.spot);near(end.mean/end.median,Math.exp(variance/2));near(end.lower*end.upper,end.median**2,1e-7);
  assert.ok(end.mean>end.median);assert.ok(end.lower<end.median&&end.median<end.upper);
  assert.ok(buildRandomWalk(pair,4,68).rows.at(-1).upper<end.upper);
  const constant={...pair,history:pair.history.map(row=>({...row,spot:1000}))},zero=buildRandomWalk(constant,4).rows.at(-1);assert.equal(zero.mean,1000);assert.equal(zero.lower,1000);assert.equal(zero.upper,1000);
});
test('chart handles missing inputs without invented consensus and CSV retains fixed columns',()=>{
  const pair=pairFixture(),result=summarizeConsensus(pair,{},12),svg=renderConsensusChart(pair,result,{width:420});
  assert.match(svg,/viewBox="0 0 420 410"/);assert.doesNotMatch(svg,/NaN|Infinity|undefined/);assert.ok(result.rows.every(row=>row.mean===null));
  const q=result.rows[0].date,estimates={[q]:[1000,1100]},csv=consensusCSV(pair,summarizeConsensus(pair,estimates,4),estimates,['기관1','기관2','추가기관']);
  csv.trim().split('\r\n').forEach(row=>assert.equal(row.split(',').length,16));
});

function tinyDocument(){
  const nodes=new Map();
  function node(id){
    const el={id,hidden:false,disabled:false,value:'',textContent:'',clientWidth:1040,attributes:{},setAttribute(k,v){this.attributes[k]=v;},click(){return this.onclick?.();}};
    Object.defineProperty(el,'innerHTML',{get(){return this.markup||'';},set(value){this.markup=value;for(const match of value.matchAll(/id="([^"]+)"/g))if(!nodes.has(match[1]))node(match[1]);}});nodes.set(id,el);return el;
  }
  node('fxConsensusHost');node('fxBenchmarkHost');return {getElementById:id=>nodes.get(id),createElement:()=>node('download')};
}
test('actual mount updates estimates and benchmark, rejects invalid import atomically, and clears source data',()=>{
  const doc=tinyDocument(),ui=mountFxConsensus(doc),get=id=>doc.getElementById(id);ui.install(snapshot());
  assert.match(get('fxConsensusChart').innerHTML,/<svg/);assert.match(get('fxBenchmarkChart').innerHTML,/<svg/);
  const quarter=futureQuarters('2025-02-10',4)[0].date;
  get('fxConsensusInputs').onchange({target:{dataset:{quarter,provider:'0'},value:'1100'}});
  get('fxConsensusInputs').onchange({target:{dataset:{quarter,provider:'1'},value:'1300'}});
  assert.match(get('fxConsensusTable').innerHTML,/1,200/);assert.equal(ui.getConsensus().estimates.USDKRW[quarter][0],1100);
  get('fxConsensusInputs').onchange({target:{dataset:{quarter,provider:'0'},value:'-1'}});assert.equal(get('fxConsensusError').hidden,false);assert.equal(ui.getConsensus().estimates.USDKRW[quarter][0],1100);
  const before=ui.getSnapshot();assert.throws(()=>ui.install({...snapshot(),pairs:[{...pairFixture(),currency:'BAD'}]}));assert.equal(ui.getSnapshot(),before);
  get('fxConsensusQuarters').onchange({target:{value:'12'}});assert.match(get('fxConsensusInputs').innerHTML,/2027Q4/);
  get('fxBenchmarkCoverage').onchange({target:{value:'68'}});assert.match(get('fxBenchmarkTable').innerHTML,/68% 하한/);
  ui.install(null);assert.equal(ui.getSnapshot().pairs.length,0);assert.equal(get('fxConsensusCSV').disabled,true);assert.match(get('fxConsensusChart').innerHTML,/환율 데이터 없음/);assert.doesNotMatch(get('fxBenchmarkChart').innerHTML,/<svg/);
});
