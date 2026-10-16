import { normalizeHedgeFx } from './hedge-lab.mjs';

const CURRENCIES = ['USDKRW','AUDKRW','JPYKRW','EURKRW'];
const DAY = 86400000;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = (value, decimals=0) => Number.isFinite(value) ? value.toLocaleString('ko-KR',{minimumFractionDigits:decimals,maximumFractionDigits:decimals}) : '—';
const stamp = date => Date.parse(`${date}T00:00:00Z`);
const validSpot = row => Number.isFinite(row.spot) && row.spot > 0;
const observed = pair => (pair?.history ?? []).filter(validSpot);
const empty = text => `<div class="empty-chart">${esc(text)}</div>`;

export function futureQuarters(asOf, count=4) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || !Number.isFinite(stamp(asOf)) || new Date(stamp(asOf)).toISOString().slice(0,10) !== asOf) throw Error('기준일 형식을 확인하십시오.');
  if (!Number.isInteger(count) || count < 1 || count > 12) throw Error('전망분기는 1~12개입니다.');
  const d=new Date(stamp(asOf)), result=[];
  let end=new Date(Date.UTC(d.getUTCFullYear(),Math.floor(d.getUTCMonth()/3)*3+3,0));
  if(end.valueOf()<=stamp(asOf))end=new Date(Date.UTC(end.getUTCFullYear(),end.getUTCMonth()+4,0));
  for(let i=0;i<count;i++){
    const date=end.toISOString().slice(0,10),label=`${end.getUTCFullYear()}Q${Math.floor(end.getUTCMonth()/3)+1}`;
    result.push({date,label,years:(end.valueOf()-stamp(asOf))/(365.25*DAY)});
    end=new Date(Date.UTC(end.getUTCFullYear(),end.getUTCMonth()+4,0));
  }
  return result;
}

/** Latest 253 source observations; no missing-quote bridging; sample SD and 252 observations/year. */
export function annualRealizedVol(pair) {
  const source=pair?.history??[],lastIndex=source.findLastIndex(validSpot),last=source[lastIndex];
  if(!last)return {sigma:null,observations:0,start:null,end:null};
  const sample=source.slice(Math.max(0,lastIndex-252),lastIndex+1);
  if(sample.some(row=>!validSpot(row)))return {sigma:null,observations:0,start:sample[0].date,end:last.date,incomplete:true};
  const returns=sample.slice(1).map((row,i)=>Math.log(row.spot/sample[i].spot));
  const base={observations:returns.length,start:sample[0]?.date??null,end:last.date};
  if(returns.length<252)return {...base,sigma:null,insufficient:true};
  const mean=returns.reduce((sum,value)=>sum+value,0)/returns.length;
  return {...base,sigma:Math.sqrt(returns.reduce((sum,value)=>sum+(value-mean)**2,0)/(returns.length-1)*252)};
}

/** User forecasts are analyst levels, not probabilities or fitted observations. */
export function summarizeConsensus(pair, estimates={}, count=4, multiplier=1) {
  const history=observed(pair),last=history.at(-1);
  if(!last)return {history:[],rows:[],vol:annualRealizedVol(pair),last:null};
  if(![1,1.96].includes(multiplier))throw Error('범위 배율을 확인하십시오.');
  const vol=annualRealizedVol(pair);
  const rows=futureQuarters(last.date,count).map(q=>{
    const raw=estimates[q.date]??[];
    if(!Array.isArray(raw))throw Error('컨센서스 입력 배열을 확인하십시오.');
    const values=raw.filter(value=>value!=null && value!=='').map(value=>Number(value));
    if(values.some(value=>!Number.isFinite(value)||value<=0||value>1e8))throw Error('컨센서스 환율은 0보다 큰 숫자여야 합니다.');
    const mean=values.length?values.reduce((sum,value)=>sum+value,0)/values.length:null;
    const disagreement=values.length>1?Math.sqrt(values.reduce((sum,value)=>sum+(value-mean)**2,0)/(values.length-1)):null;
    const width=vol.sigma==null?null:multiplier*vol.sigma*Math.sqrt(q.years);
    return {...q,n:values.length,mean,disagreement,consensusLow:disagreement==null?null:mean-multiplier*disagreement,consensusHigh:disagreement==null?null:mean+multiplier*disagreement,volLow:width==null?null:last.spot*Math.exp(-width),volHigh:width==null?null:last.spot*Math.exp(width)};
  });
  return {history,rows,vol,last};
}

/** Zero drift in log spot: the median is flat; Jensen's term changes the level mean. */
export function buildRandomWalk(pair,count=4,coverage=95) {
  if(![68,95].includes(coverage))throw Error('예측구간을 확인하십시오.');
  const result=summarizeConsensus(pair,{},count),z=coverage===68?0.994457883209753:1.959963984540054;
  return {...result,coverage,rows:result.rows.map(q=>{
    const variance=result.vol.sigma==null?null:result.vol.sigma**2*q.years;
    const width=variance==null?null:z*Math.sqrt(variance);
    return {...q,median:result.last.spot,mean:variance==null?null:result.last.spot*Math.exp(variance/2),lower:width==null?null:result.last.spot*Math.exp(-width),upper:width==null?null:result.last.spot*Math.exp(width),sigmaLog:variance==null?null:Math.sqrt(variance)};
  })};
}

function paths(rows,key,x,y){
  let drawing=false;
  return rows.map(row=>{
    if(!Number.isFinite(row[key])){drawing=false;return '';}
    const part=`${drawing?'L':'M'}${x(stamp(row.date)).toFixed(2)},${y(row[key]).toFixed(2)}`;drawing=true;return part;
  }).join(' ');
}
function bandPaths(rows,low,high,x,y){
  const groups=[];let group=[];
  for(const row of rows){if(Number.isFinite(row[low])&&Number.isFinite(row[high]))group.push(row);else if(group.length){groups.push(group);group=[];}}
  if(group.length)groups.push(group);
  return groups.filter(g=>g.length>1).map(g=>`${paths(g,high,x,y)} ${[...g].reverse().map(row=>`L${x(stamp(row.date)).toFixed(2)},${y(row[low]).toFixed(2)}`).join(' ')} Z`);
}

export function renderConsensusChart(pair,result,{width=1040,years=1,benchmark=false}={}) {
  if(!result.last)return empty('환율 데이터 없음');
  const W=Math.max(420,Math.min(1600,width||1040)),H=410,p={l:65,r:22,t:25,b:48};
  const cutoff=new Date(stamp(result.last.date));cutoff.setUTCFullYear(cutoff.getUTCFullYear()-(Number(years)||100));
  const history=result.history.filter(row=>stamp(row.date)>=cutoff.valueOf());
  const start={date:result.last.date,mean:result.last.spot,median:result.last.spot,volLow:result.last.spot,volHigh:result.last.spot,lower:result.last.spot,upper:result.last.spot,consensusLow:result.last.spot,consensusHigh:result.last.spot};
  const rows=[start,...result.rows],loKey=benchmark?'lower':'volLow',hiKey=benchmark?'upper':'volHigh';
  const values=[...history.map(row=>row.spot),...rows.flatMap(row=>[row.mean,row[loKey],row[hiKey],...(!benchmark?[row.consensusLow,row.consensusHigh]:[])])].filter(Number.isFinite);
  const lo=Math.min(...values),hi=Math.max(...values),gap=Math.max(hi-lo,hi*.03),min=lo<0?lo-gap*.12:Math.max(0,lo-gap*.12),max=hi+gap*.12;
  const t0=stamp(history[0].date),t1=stamp(result.rows.at(-1).date),x=t=>p.l+(t-t0)/(t1-t0)*(W-p.l-p.r),y=value=>H-p.b-(value-min)/(max-min)*(H-p.t-p.b);
  let svg=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(pair.currency)} ${benchmark?'랜덤워크 기준모형':'컨센서스와 실현변동성 범위'}"><title>${esc(pair.currency)} · ${esc(pair.spotUnit??'원')}</title>`;
  for(let i=0;i<=5;i++){const v=min+(max-min)*i/5;svg+=`<line x1="${p.l}" x2="${W-p.r}" y1="${y(v)}" y2="${y(v)}" stroke="#2c3632"/><text x="${p.l-9}" y="${y(v)+4}" text-anchor="end">${fmt(v)}</text>`;}
  const ticks=W<650?4:7;
  for(let i=0;i<=ticks;i++){const t=t0+(t1-t0)*i/ticks;svg+=`<text x="${x(t)}" y="${H-17}" text-anchor="${i===0?'start':i===ticks?'end':'middle'}">${new Date(t).toISOString().slice(0,7).replace('-','.')}</text>`;}
  for(const path of bandPaths(rows,loKey,hiKey,x,y))svg+=`<path d="${path}" fill="#61a9ee" fill-opacity=".16"/>`;
  if(!benchmark)for(const path of bandPaths(rows,'consensusLow','consensusHigh',x,y))svg+=`<path d="${path}" fill="#ee9f9a" fill-opacity=".26"/>`;
  svg+=`<path d="${paths(history,'spot',x,y)}" fill="none" stroke="#d9e3db" stroke-width="1.8"/><path d="${paths(rows,'mean',x,y)}" fill="none" stroke="#eeaaa3" stroke-dasharray="5 5" stroke-width="2"/>`;
  if(benchmark)svg+=`<path d="${paths(rows,'median',x,y)}" fill="none" stroke="#c7b681" stroke-dasharray="3 4" stroke-width="1.5"/>`;
  svg+=`<line x1="${x(stamp(result.last.date))}" x2="${x(stamp(result.last.date))}" y1="${p.t}" y2="${H-p.b}" stroke="#8c9c92" stroke-dasharray="4 5"/>`;
  const labels=new Set();let nextLabelX=Infinity,nextLabelLeft=Infinity;
  for(let i=result.rows.length-1;i>=0;i--){
    const row=result.rows[i];if(!Number.isFinite(row.mean))continue;
    const px=x(stamp(row.date)),nearEnd=px>W-65,labelWidth=Math.max(row.label.slice(2).length,fmt(row.mean).length)*7.3,left=nearEnd?px-5-labelWidth:px-labelWidth/2,right=nearEnd?px-5:px+labelWidth/2;
    if(nextLabelX-px>=76&&right<=nextLabelLeft-10){labels.add(i);nextLabelX=px;nextLabelLeft=left;}
  }
  result.rows.forEach((row,i)=>{
    if(!Number.isFinite(row.mean))return;
    const px=x(stamp(row.date)),py=y(row.mean);svg+=`<circle cx="${px}" cy="${py}" r="3" fill="#eeaaa3"/>`;
    if(labels.has(i))svg+=`<text x="${px>W-65?px-5:px}" y="${py-25}" text-anchor="${px>W-65?'end':'middle'}" class="fxc-point-label">${row.label.slice(2)}</text><text x="${px>W-65?px-5:px}" y="${py-10}" text-anchor="${px>W-65?'end':'middle'}" class="fxc-point-label">${fmt(row.mean)}</text>`;
    if(!benchmark&&row.disagreement!=null)svg+=`<line x1="${px}" x2="${px}" y1="${y(row.consensusLow)}" y2="${y(row.consensusHigh)}" stroke="#eeaaa3" stroke-width="1.2"/>`;
  });
  return svg+'</svg>';
}

export function consensusCSV(pair,result,estimates={},names=[]) {
  const quote=value=>{const safe=typeof value==='string'&&/^\s*[=+@-]/.test(value)?`'${value}`:String(value??'');return `"${safe.replaceAll('"','""')}"`;};
  const rows=[['currency','unit','as_of','quarter','date','n','mean','disagreement_sd','consensus_lower','consensus_upper','annual_log_sigma','realized_vol_lower','realized_vol_upper',...names]];
  for(const row of result.rows)rows.push([pair.currency,pair.spotUnit,result.last?.date,row.label,row.date,row.n,row.mean,row.disagreement,row.consensusLow,row.consensusHigh,result.vol.sigma,row.volLow,row.volHigh,...names.map((_,i)=>estimates[row.date]?.[i]??null)]);
  return '\ufeff'+rows.map(row=>row.map(quote).join(',')).join('\r\n');
}
const currenciesOptions=()=>CURRENCIES.map(c=>`<option value="${c}">${c}</option>`).join('');
const quartersOptions=()=>Array.from({length:12},(_,i)=>`<option value="${i+1}"${i===3?' selected':''}>${i+1}분기</option>`).join('');
const yearsOptions='<option value="1">1년</option><option value="3">3년</option><option value="5">5년</option><option value="0">전체</option>';

export function mountFxConsensus(documentRoot=document) {
  const host=documentRoot.getElementById('fxConsensusHost'),benchmarkHost=documentRoot.getElementById('fxBenchmarkHost');if(!host)return null;
  const $=id=>documentRoot.getElementById(id);
  let snapshot=normalizeHedgeFx(null),currency='USDKRW',count=4,years=1,multiplier=1,benchmarkCurrency='USDKRW',benchmarkCount=4,benchmarkYears=1,coverage=95;
  const estimates=Object.fromEntries(CURRENCIES.map(c=>[c,{}]));let names=['기관 1','기관 2','기관 3','기관 4'];
  host.innerHTML=`<div class="fxc-toolbar"><div><h2>FX Consensus</h2><span id="fxConsensusSource" class="small">데이터 미연결</span></div><div class="fxc-controls"><label>통화<select id="fxConsensusCurrency">${currenciesOptions()}</select></label><label>과거<select id="fxConsensusHistory">${yearsOptions}</select></label><label>전망<select id="fxConsensusQuarters">${quartersOptions()}</select></label><label>범위<select id="fxConsensusRange"><option value="1">±1σ</option><option value="1.96">±1.96σ</option></select></label><button id="fxConsensusCSV" class="button secondary" disabled>CSV</button></div></div><div id="fxConsensusError" class="fx-model-error" role="alert" hidden></div><div id="fxConsensusMetrics" class="fxc-metrics"></div><article class="panel fxc-panel"><div class="fxc-legend"><span><i class="fxc-white"></i>과거 환율</span><span><i class="fxc-red-line"></i>컨센서스 평균</span><span><i class="fxc-blue"></i>실현 σ × √T</span><span><i class="fxc-red"></i>컨센서스 분산 범위</span></div><div id="fxConsensusChart" class="chart-wrap fxc-chart">${empty('환율 데이터 없음')}</div></article><article class="panel fxc-input-panel"><div class="panel-heading"><h2>분기별 컨센서스</h2><div class="fx-toolbar-actions"><span id="fxConsensusUnit" class="small"></span><button id="fxConsensusAdd" class="button secondary">기관 추가</button><button id="fxConsensusClear" class="button secondary">입력 초기화</button></div></div><div id="fxConsensusInputs" class="table-scroll"></div><div id="fxConsensusTable" class="table-scroll fxc-summary"></div></article>`;
  if(benchmarkHost)benchmarkHost.innerHTML=`<div class="fxc-toolbar"><div><h2>FX Model B <span class="pill">RANDOM WALK</span></h2><span id="fxBenchmarkSource" class="small">데이터 미연결</span></div><div class="fxc-controls"><label>통화<select id="fxBenchmarkCurrency">${currenciesOptions()}</select></label><label>과거<select id="fxBenchmarkHistory">${yearsOptions}</select></label><label>전망<select id="fxBenchmarkQuarters">${quartersOptions()}</select></label><label>예측구간<select id="fxBenchmarkCoverage"><option value="68">68%</option><option value="95" selected>95%</option></select></label></div></div><div id="fxBenchmarkMetrics" class="fxc-metrics"></div><article class="panel fxc-panel"><div class="fxc-legend"><span><i class="fxc-white"></i>과거 환율</span><span><i class="fxc-red-line"></i>조건부 평균</span><span><i class="fxc-gold-line"></i>중앙값</span><span><i class="fxc-blue"></i>로그 드리프트 0 · 실현 σ</span></div><div id="fxBenchmarkChart" class="chart-wrap fxc-chart">${empty('환율 데이터 없음')}</div><div id="fxBenchmarkTable" class="table-scroll fxc-summary"></div></article>`;
  const pairFor=c=>snapshot.pairs.find(p=>p.currency===c);
  const metric=(label,value,detail='')=>`<div><span>${esc(label)}</span><strong>${value}</strong><small>${esc(detail)}</small></div>`;
  function renderInputs(pair,result){
    if(!result.last){$('fxConsensusInputs').innerHTML='';return;}
    $('fxConsensusInputs').innerHTML=`<table class="fxc-inputs"><thead><tr><th>기관</th>${result.rows.map(row=>`<th>${row.label}</th>`).join('')}</tr></thead><tbody>${names.map((name,i)=>`<tr><td><input type="text" maxlength="40" data-provider="${i}" value="${esc(name)}" aria-label="기관 ${i+1} 이름"></td>${result.rows.map(row=>`<td><input type="number" min="1" max="100000000" step="1" inputmode="decimal" data-quarter="${row.date}" data-provider="${i}" value="${esc(estimates[currency][row.date]?.[i]??'')}" aria-label="${esc(pair.currency)} ${row.label} ${esc(name)}"></td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }
  function renderConsensus(inputs=true){
    const pair=pairFor(currency),result=summarizeConsensus(pair,estimates[currency],count,multiplier),last=result.last;
    $('fxConsensusSource').textContent=last?`${snapshot.source} · ${last.date}`:'데이터 미연결';
    $('fxConsensusCSV').disabled=!last;$('fxConsensusUnit').textContent=pair?.spotUnit??'';
    const final=result.rows.at(-1);
    $('fxConsensusMetrics').innerHTML=metric('최근 환율',fmt(last?.spot),pair?.spotUnit??'')+metric(`${final?.label??''} 평균`,fmt(final?.mean),`${final?.n??0}개 입력`)+metric('최근 1년 실현 σ',`${fmt(result.vol.sigma==null?null:result.vol.sigma*100,2)}%`,result.vol.incomplete?'결측 구간':result.vol.insufficient?'표본 부족':`${result.vol.observations}개 로그수익률 · 연환산`)+metric('컨센서스 σ',fmt(final?.disagreement),final?.label??'');
    $('fxConsensusChart').innerHTML=renderConsensusChart(pair,result,{width:$('fxConsensusChart').clientWidth,years});
    if(inputs)renderInputs(pair,result);
    $('fxConsensusTable').innerHTML=last?`<table><thead><tr><th>분기</th><th>입력 수</th><th>평균</th><th>컨센서스 σ</th><th>컨센서스 ±${multiplier}σ</th><th>실현 ±${multiplier}σ × √T</th></tr></thead><tbody>${result.rows.map(row=>`<tr><td>${row.label}</td><td>${row.n}</td><td class="fxc-salmon">${fmt(row.mean)}</td><td>${fmt(row.disagreement)}</td><td>${fmt(row.consensusLow)} ~ ${fmt(row.consensusHigh)}</td><td>${fmt(row.volLow)} ~ ${fmt(row.volHigh)}</td></tr>`).join('')}</tbody></table>`:'';
  }
  function renderBenchmark(){
    if(!benchmarkHost)return;
    const pair=pairFor(benchmarkCurrency),result=buildRandomWalk(pair,benchmarkCount,coverage),last=result.last,final=result.rows.at(-1);
    $('fxBenchmarkSource').textContent=last?`${snapshot.source} · ${last.date}`:'데이터 미연결';
    $('fxBenchmarkMetrics').innerHTML=metric('최근 환율',fmt(last?.spot),pair?.spotUnit??'')+metric(`${final?.label??''} 중앙값`,fmt(final?.median),'로그 드리프트 0')+metric(`${final?.label??''} 조건부 평균`,fmt(final?.mean),'로그정규 평균')+metric('최근 1년 실현 σ',`${fmt(result.vol.sigma==null?null:result.vol.sigma*100,2)}%`,result.vol.incomplete?'결측 구간':result.vol.insufficient?'표본 부족':`${result.vol.observations}개 로그수익률 · 연환산`);
    $('fxBenchmarkChart').innerHTML=renderConsensusChart(pair,result,{width:$('fxBenchmarkChart').clientWidth,years:benchmarkYears,benchmark:true});
    $('fxBenchmarkTable').innerHTML=last?`<table><thead><tr><th>분기</th><th>중앙값</th><th>조건부 평균</th><th>${coverage}% 하한</th><th>${coverage}% 상한</th><th>누적 로그 σ</th></tr></thead><tbody>${result.rows.map(row=>`<tr><td>${row.label}</td><td>${fmt(row.median)}</td><td class="fxc-salmon">${fmt(row.mean)}</td><td>${fmt(row.lower)}</td><td>${fmt(row.upper)}</td><td>${fmt(row.sigmaLog==null?null:row.sigmaLog*100,2)}%</td></tr>`).join('')}</tbody></table>`:'';
  }
  $('fxConsensusCurrency').onchange=event=>{currency=event.target.value;renderConsensus();};
  $('fxConsensusHistory').onchange=event=>{years=Number(event.target.value);renderConsensus(false);};
  $('fxConsensusQuarters').onchange=event=>{count=Number(event.target.value);renderConsensus();};
  $('fxConsensusRange').onchange=event=>{multiplier=Number(event.target.value);renderConsensus(false);};
  $('fxConsensusInputs').onchange=event=>{
    const input=event.target,index=Number(input.dataset?.provider);if(!Number.isInteger(index)||index<0||index>=names.length)return;
    if(!input.dataset.quarter){names[index]=input.value.trim().slice(0,40)||`기관 ${index+1}`;input.value=names[index];return;}
    const value=input.value.trim()===''?null:Number(input.value);
    if(value!==null&&(!Number.isFinite(value)||value<=0||value>1e8)){$('fxConsensusError').textContent='컨센서스 환율은 0보다 큰 숫자여야 합니다.';$('fxConsensusError').hidden=false;input.setAttribute?.('aria-invalid','true');return;}
    const date=input.dataset.quarter;estimates[currency][date]??=Array(names.length).fill(null);estimates[currency][date][index]=value;
    $('fxConsensusError').hidden=true;input.setAttribute?.('aria-invalid','false');renderConsensus(false);
  };
  $('fxConsensusAdd').onclick=()=>{if(names.length>=12)return;names.push(`기관 ${names.length+1}`);$('fxConsensusAdd').disabled=names.length>=12;renderConsensus();};
  $('fxConsensusClear').onclick=()=>{estimates[currency]={};$('fxConsensusError').hidden=true;renderConsensus();};
  $('fxConsensusCSV').onclick=()=>{
    const pair=pairFor(currency),result=summarizeConsensus(pair,estimates[currency],count,multiplier);if(!result.last)return;
    const url=URL.createObjectURL(new Blob([consensusCSV(pair,result,estimates[currency],names)],{type:'text/csv;charset=utf-8;'}));
    const a=documentRoot.createElement('a');a.href=url;a.download=`${currency}_Consensus_${result.last.date}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  if(benchmarkHost){
    $('fxBenchmarkCurrency').onchange=event=>{benchmarkCurrency=event.target.value;renderBenchmark();};
    $('fxBenchmarkHistory').onchange=event=>{benchmarkYears=Number(event.target.value);renderBenchmark();};
    $('fxBenchmarkQuarters').onchange=event=>{benchmarkCount=Number(event.target.value);renderBenchmark();};
    $('fxBenchmarkCoverage').onchange=event=>{coverage=Number(event.target.value);renderBenchmark();};
  }
  function install(raw){const next=normalizeHedgeFx(raw?.hedgeFx??raw);snapshot=next;renderConsensus();renderBenchmark();return snapshot;}
  if(typeof ResizeObserver!=='undefined'){
    let previous=0;new ResizeObserver(entries=>{const width=entries[0].contentRect.width;if(width>0&&width!==previous){previous=width;renderConsensus(false);}}).observe($('fxConsensusChart'));
    if(benchmarkHost){let previousBenchmark=0;new ResizeObserver(entries=>{const width=entries[0].contentRect.width;if(width>0&&width!==previousBenchmark){previousBenchmark=width;renderBenchmark();}}).observe($('fxBenchmarkChart'));}
  }
  renderConsensus();renderBenchmark();
  return {install,getSnapshot:()=>snapshot,getConsensus:()=>JSON.parse(JSON.stringify({names,estimates}))};
}
