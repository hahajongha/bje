/** USDKRW Markov three-state snapshot viewer. No network requests or persistence. */
import { simulateFx } from './fx-simulation.mjs';
const COLORS = ['#6cafdc', '#c8b480', '#dd918b'];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const fmt = (value, decimals=0) => Number.isFinite(value) ? value.toLocaleString('ko-KR', {minimumFractionDigits:decimals, maximumFractionDigits:decimals}) : '—';
const stamp = date => Date.parse(`${date}T00:00:00Z`);
const fieldError = label => { throw Error(`${label} 형식을 확인하십시오.`); };
function finite(value, label, min=-Infinity, max=Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value<min || value>max) fieldError(label);
  return value;
}
function date(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(stamp(value)) || new Date(stamp(value)).toISOString().slice(0,10)!==value) fieldError(label);
  return value;
}
function text(value, label, fallback='') {
  if(value == null) return fallback;
  if(typeof value!=='string'||value.length>500)fieldError(label);
  return value;
}
function probs(value, label) {
  if(!Array.isArray(value)||value.length!==3)fieldError(label);
  const out=value.map(v=>finite(v,label,0,1));
  if(Math.abs(out.reduce((sum,p)=>sum+p,0)-1)>1e-5)fieldError(`${label} 합계`);
  return out;
}
function freeze(value) {
  if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}
  return value;
}
/** Validate first, then copy only supported fields; failed imports never replace the active snapshot. */
export function normalizeFxModel(raw) {
  if(!raw||raw.schemaVersion!==1||raw.pair!=='USDKRW')fieldError('USDKRW 스냅샷 버전');
  const m=raw.meta, model=raw.model;
  if(!m||!model||!Array.isArray(raw.history)||raw.history.length<2||raw.history.length>30000||!Array.isArray(raw.forecast)||raw.forecast.length<63||raw.forecast.length>504)fieldError('표본·전망 길이');
  const history=raw.history.map((row,i)=>{
    if(!row||typeof row!=='object')fieldError('과거 관측값');
    const d=date(row.date,'과거 관측일');
    if(i&&d<=raw.history[i-1].date)fieldError('과거 날짜 순서');
    return {date:d,spot:finite(row.spot,'과거 환율',Number.MIN_VALUE,1e8),...(row.probs==null?{}:{probs:probs(row.probs,'과거 국면 확률')})};
  });
  const asOf=date(m.asOf,'기준일');
  if(asOf!==history.at(-1).date)fieldError('기준일과 최근 관측일');
  const forecast=raw.forecast.map((row,i)=>{
    if(!row||typeof row!=='object')fieldError('전망값');
    const d=date(row.date,'전망일');
    if(d<=(i?raw.forecast[i-1].date:asOf))fieldError('전망 날짜 순서');
    const out={date:d,probs:probs(row.probs,'전망 국면 확률')};
    for(const key of ['mean','median','lower68','upper68','lower90','upper90','lower95','upper95'])out[key]=finite(row[key],key,Number.MIN_VALUE,1e8);
    out.sigmaLog=finite(row.sigmaLog,'누적 로그 표준편차',0,100);
    for(const key of ['analyticMean','meanSE','analyticSigmaLog'])if(row[key]!=null)out[key]=finite(row[key],key,0,1e100);
    const ordered=['lower95','lower90','lower68','median','upper68','upper90','upper95'];
    if(ordered.some((key,j)=>j&&out[key]<out[ordered[j-1]]))fieldError('예측구간 순서');
    return out;
  });
  if(!Array.isArray(model.regimes)||model.regimes.length!==3||!Array.isArray(model.transition)||model.transition.length!==3)fieldError('3개 국면');
  const transition=model.transition.map((row,i)=>probs(row,`국면 ${i+1} 전이확률`));
  const regimes=model.regimes.map((r,i)=>{
    if(!r||typeof r!=='object')fieldError('국면 추정치');
    const p=finite(r.persistence,'잔류확률',0,1);
    if(Math.abs(p-transition[i][i])>1e-5)fieldError('잔류확률·전이행렬 일치');
    return {label:text(r.label,'국면 이름',`국면 ${i+1}`),meanDailyPct:finite(r.meanDailyPct,'일평균 로그수익률',-100,100),volDailyPct:finite(r.volDailyPct,'일 변동성',0,100),persistence:p};
  });
  const currentProbs=probs(model.currentProbs,'현재 국면 확률');
  if(history.at(-1).probs?.some((p,i)=>Math.abs(p-currentProbs[i])>1e-5))fieldError('최근 국면 확률 일치');
  const start=date(m.start,'표본 시작일'),end=date(m.end,'표본 종료일');
  if(start>history[0].date||end!==asOf)fieldError('표본 기간');
  const n=finite(m.n,'표본 수',1,30000);if(!Number.isInteger(n))fieldError('표본 수');
  const sourceComparison={};
  if(m.sourceComparison!=null){
    const comparison=m.sourceComparison;if(typeof comparison!=='object'||Array.isArray(comparison))fieldError('자료 비교');
    for(const key of ['commonObservations','primaryLastCommon','midpointLastCommon','medianAbsoluteDifference','maxAbsoluteDifference'])if(comparison[key]!=null)sourceComparison[key]=finite(comparison[key],`자료 비교 ${key}`,0,1e8);
    if(comparison.lastCommonDate!=null)sourceComparison.lastCommonDate=date(comparison.lastCommonDate,'비교 기준일');
    if(comparison.note!=null)sourceComparison.note=text(comparison.note,'비교 정보');
  }
  let warnings=[];
  if(m.warnings!=null){if(!Array.isArray(m.warnings)||m.warnings.length>20)fieldError('추정 경고');warnings=m.warnings.map(v=>text(v,'추정 경고'));}
  const diagnostics={};
  if(model.diagnostics?.converged!=null){if(typeof model.diagnostics.converged!=='boolean')fieldError('수렴 상태');diagnostics.converged=model.diagnostics.converged;}
  const validation={};
  if(raw.validation!=null){
    if(typeof raw.validation!=='object'||Array.isArray(raw.validation))fieldError('검증 정보');
    for(const key of ['summary','status','method','note'])if(raw.validation[key]!=null)validation[key]=text(raw.validation[key],'검증 정보');
    for(const key of ['horizonDays','observations','modelRmse','randomWalkRmse','coverage68','coverage90','coverage95'])if(raw.validation[key]!=null)validation[key]=finite(raw.validation[key],`검증 ${key}`,0);
  }
  if(raw.validation?.outOfSample!=null){
    const o=raw.validation.outOfSample;if(typeof o!=='object'||Array.isArray(o))fieldError('표본외 검증');
    const out={method:text(o.method,'표본외 검증 방법'),observations:finite(o.observations,'표본외 관측수',1,30000)};
    if(!Number.isInteger(out.observations))fieldError('표본외 관측수');
    for(const key of ['trainingStart','trainingEnd','testStart','testEnd'])out[key]=date(o[key],`표본외 ${key}`);
    if(out.trainingStart>out.trainingEnd||out.trainingEnd>=out.testStart||out.testStart>out.testEnd||out.testEnd>asOf)fieldError('표본외 기간 순서');
    for(const key of ['modelRMSE','randomWalkRMSE'])out[key]=finite(o[key],`표본외 ${key}`,0,1e8);
    for(const key of ['coverage68','coverage90','coverage95'])out[key]=finite(o[key],`표본외 ${key}`,0,1);
    if(o.trainingConverged!=null){if(typeof o.trainingConverged!=='boolean')fieldError('표본외 추정 수렴');out.trainingConverged=o.trainingConverged;}
    validation.outOfSample=out;
  }
  if(raw.validation?.momentCheck!=null){
    const c=raw.validation.momentCheck;if(typeof c!=='object'||Array.isArray(c))fieldError('수치 검증');
    const check={};for(const key of ['paths','horizon','meanAgreementSE','varianceAgreementSE'])if(c[key]!=null)check[key]=finite(c[key],`수치 검증 ${key}`,0,1e8);
    validation.momentCheck=check;
  }
  let simulation=null,samplePaths=[];
  if(raw.simulation!=null){
    const s=raw.simulation;if(typeof s!=='object'||Array.isArray(s))fieldError('시뮬레이션');
    simulation={};
    for(const key of ['engine','rng','meanEstimator','meanMethod','intervalMethod'])if(s[key]!=null)simulation[key]=text(s[key],`시뮬레이션 ${key}`);
    for(const key of ['version','paths','seed','horizon','samplePathCount'])if(s[key]!=null){simulation[key]=finite(s[key],`시뮬레이션 ${key}`,0,4294967295);if(!Number.isInteger(s[key]))fieldError(`시뮬레이션 ${key}`);}
    if(simulation.horizon!==forecast.length||simulation.paths<1000)fieldError('시뮬레이션 길이·경로 수');
  }
  if(raw.samplePaths!=null){
    if(!Array.isArray(raw.samplePaths)||raw.samplePaths.length>64)fieldError('표본 경로');
    samplePaths=raw.samplePaths.map((p,i)=>{
      if(!p||!Array.isArray(p.values)||p.values.length!==forecast.length+1)fieldError('표본 경로 길이');
      const values=p.values.map(v=>finite(v,'표본 환율',Number.MIN_VALUE,1e100));
      if(Math.abs(values[0]-history.at(-1).spot)>1e-8)fieldError('표본 경로 시작점');
      return {id:i,values};
    });
  }
  return freeze({schemaVersion:1,pair:'USDKRW',meta:{asOf,source:text(m.source,'출처','사용자 스냅샷'),n,start,end,sourceComparison,warnings},history,forecast,model:{regimes,transition,currentProbs,diagnostics},validation,simulation,samplePaths});
}
export function prepareFxSimulation(raw,options={}) {
  const base=normalizeFxModel(raw),result=simulateFx(base,options);
  return freeze({...base,...result});
}
export function selectFxWindow(snapshot, months=12, years=3) {
  const last=snapshot.history.at(-1),start=new Date(stamp(last.date));
  start.setUTCFullYear(start.getUTCFullYear()-(Number(years)||1000));
  return {history:snapshot.history.filter(row=>stamp(row.date)>=start.valueOf()),forecast:snapshot.forecast.slice(0,Math.round(months*21))};
}
function quarterRows(rows) {
  const buckets=new Map();
  for(const row of rows){const d=new Date(stamp(row.date));buckets.set(`${d.getUTCFullYear()}Q${Math.floor(d.getUTCMonth()/3)+1}`,row);}
  return [...buckets.entries()];
}
function quarterDisplay(key,row){const d=new Date(stamp(row.date)),last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();return key+((d.getUTCMonth()%3!==2||d.getUTCDate()<last-2)?'*':'');}
const linePath=(rows,key,x,y)=>rows.map((row,i)=>`${i?'L':'M'}${x(stamp(row.date)).toFixed(2)},${y(row[key]).toFixed(2)}`).join(' ');
export function renderFxChart(snapshot, months=12, years=3, width=1040, coverage=95, center='both', showPaths=false) {
  if(![68,90,95].includes(coverage))coverage=95;
  const {history,forecast}=selectFxWindow(snapshot,months,years);
  if(!forecast.length)return '';
  const W=Math.max(420,Math.min(1600,width||1040)),H=W<650?365:425,pad={l:64,r:28,t:38,b:51};
  const last=history.at(-1),end=forecast.at(-1),anchor={date:last.date,mean:last.spot,median:last.spot,lower68:last.spot,upper68:last.spot,lower90:last.spot,upper90:last.spot,lower95:last.spot,upper95:last.spot};
  const f=[anchor,...forecast],paths=showPaths?(snapshot.samplePaths??[]).map(p=>p.values.slice(0,f.length)):[];
  const values=[...history.map(r=>r.spot),...f.flatMap(r=>[r[`lower${coverage}`],r[`upper${coverage}`],r.mean,r.median]),...paths.flat()];
  const lo=Math.min(...values),hi=Math.max(...values),gap=Math.max(hi-lo,lo*.025),min=Math.max(0,lo-gap*.1),max=hi+gap*.13;
  const t0=stamp(history[0].date),t1=stamp(end.date),x=t=>pad.l+(t-t0)/(t1-t0)*(W-pad.l-pad.r),y=v=>H-pad.b-(v-min)/(max-min)*(H-pad.t-pad.b);
  let out=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="fxChartTitle fxChartDesc"><title id="fxChartTitle">USDKRW 과거 환율과 3국면 Markov 전망</title><desc id="fxChartDesc">기준일 ${esc(last.date)}. 파란색은 과거 관측, 붉은 실선은 평균, 황금 점선은 중앙값. 음영은 ${[68,90,95].filter(b=>b<=coverage).join(', ')}% 모형 예측구간. ${showPaths?'가는 회색 선은 개별 시뮬레이션 경로.':''}</desc>`;
  for(let j=0;j<=5;j++){const v=min+(max-min)*j/5;out+=`<line x1="${pad.l}" x2="${W-pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="#2c3632"/><text x="${pad.l-10}" y="${y(v)+4}" text-anchor="end" font-size="13">${fmt(v)}</text>`;}
  const count=W<650?3:7;
  for(let j=0;j<=count;j++){const t=t0+(t1-t0)*j/count,d=new Date(t).toISOString().slice(0,7).replace('-','.');out+=`<line x1="${x(t)}" x2="${x(t)}" y1="${pad.t}" y2="${H-pad.b}" stroke="#27312d"/><text x="${x(t)}" y="${H-18}" text-anchor="${j===0?'start':j===count?'end':'middle'}" font-size="13">${d}</text>`;}
  for(const [band,opacity] of [[95,.10],[90,.15],[68,.23]]){
    if(band>coverage)continue;
    const upper=linePath(f,`upper${band}`,x,y),lower=[...f].reverse().map(row=>`L${x(stamp(row.date)).toFixed(2)},${y(row[`lower${band}`]).toFixed(2)}`).join(' ');
    out+=`<path d="${upper} ${lower} Z" fill="#df928f" fill-opacity="${opacity}"/>`;
  }
  for(const values of paths)out+=`<path data-simulation-path="true" d="${linePath(f.map((r,i)=>({date:r.date,value:values[i]})),'value',x,y)}" fill="none" stroke="#b9c9c0" stroke-width=".8" stroke-opacity=".22"/>`;
  out+=`<path d="${linePath(history,'spot',x,y)}" fill="none" stroke="#55a9ed" stroke-width="1.9" stroke-linejoin="round"/>`;
  if(center!=='median')out+=`<path data-series="mean" d="${linePath(f,'mean',x,y)}" fill="none" stroke="#efaaa3" stroke-width="2.4"/>`;
  if(center!=='mean')out+=`<path data-series="median" d="${linePath(f,'median',x,y)}" fill="none" stroke="#e8c78c" stroke-width="2.2" stroke-dasharray="6 4"/>`;
  out+=`<line x1="${x(stamp(last.date))}" x2="${x(stamp(last.date))}" y1="${pad.t-6}" y2="${H-pad.b}" stroke="#b0b5ac" stroke-dasharray="4 5"/><text x="${x(stamp(last.date))+7}" y="${pad.t-13}" text-anchor="${x(stamp(last.date))>W-100?'end':'start'}" font-size="12">전망 →</text>`;
  const quarters=quarterRows(forecast);let nextLabelLeft=Infinity;
  if(center!=='median')[...quarters].reverse().forEach(([label,row])=>{
    const px=x(stamp(row.date)),py=y(row.mean),nearEnd=px>W-65,align=nearEnd?'end':'middle',dx=nearEnd?-5:0;
    const labelWidth=Math.max(quarterDisplay(label,row).slice(2).length,fmt(row.mean).length)*7.5;
    const labelLeft=px+dx-labelWidth*(nearEnd?1:.5),labelRight=px+dx+labelWidth*(nearEnd?0:.5);
    if(labelRight>nextLabelLeft-14)return;
    nextLabelLeft=labelLeft;
    out+=`<circle cx="${px}" cy="${py}" r="3.2" fill="#f1b7b0"/><text x="${px+dx}" y="${py-24}" text-anchor="${align}" font-size="12" style="fill:#edaaa2">${quarterDisplay(label,row).slice(2)}</text><text x="${px+dx}" y="${py-9}" text-anchor="${align}" font-size="12" style="fill:#edaaa2">${fmt(row.mean)}</text>`;
  });
  out+=`<circle cx="${x(stamp(last.date))}" cy="${y(last.spot)}" r="3" fill="#dfe9f0"/></svg>`;
  return out;
}
export function renderFxRegimes(snapshot) {
  const {regimes,currentProbs,transition}=snapshot.model;
  const cards=regimes.map((r,i)=>`<article class="fx-regime-card" style="--regime-color:${COLORS[i]}"><div class="fx-regime-top"><h3>${esc(r.label)}</h3><span>국면 ${i+1}</span></div><strong class="fx-regime-prob">${fmt(currentProbs[i]*100,2)}<small>%</small></strong><div class="fx-prob-track"><i style="width:${currentProbs[i]*100}%"></i></div><dl><div><dt>일평균 로그수익률</dt><dd>${fmt(r.meanDailyPct,3)}%</dd></div><div><dt>일 변동성</dt><dd>${fmt(r.volDailyPct,3)}%</dd></div><div><dt>잔류확률</dt><dd>${fmt(r.persistence*100,2)}%</dd></div><div><dt>평균 지속기간</dt><dd>${r.persistence===1?'∞':fmt(1/(1-r.persistence),1)}일</dd></div></dl></article>`).join('');
  const matrix=`<table class="fx-transition"><thead><tr><th>현재 → 다음 관측</th>${regimes.map(r=>`<th>${esc(r.label)}</th>`).join('')}</tr></thead><tbody>${transition.map((row,i)=>`<tr><th>${esc(regimes[i].label)}</th>${row.map(v=>`<td style="background:rgba(125,169,163,${(.03+.30*v).toFixed(3)})">${fmt(v*100,2)}%</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  return {cards,matrix};
}
export function renderFxProbabilities(snapshot, years=3, width=1040) {
  const {history}=selectFxWindow(snapshot,12,years);
  const hasProbs=row=>Array.isArray(row.probs)&&row.probs.length===3&&row.probs.every(p=>typeof p==='number'&&Number.isFinite(p)&&p>=0&&p<=1)&&Math.abs(row.probs.reduce((sum,p)=>sum+p,0)-1)<=1e-5;
  if(!history.some(hasProbs))return '<div class="fx-probability-empty small" role="status">확률 데이터 미연결</div>';
  const numericWidth=Number(width),W=Math.max(420,Math.min(1600,Number.isFinite(numericWidth)&&numericWidth>0?numericWidth:1040)),H=280,pad={l:58,r:24,t:20,b:42};
  const start=stamp(history[0].date),end=Math.max(start+86400000,stamp(history.at(-1).date));
  const x=t=>pad.l+(t-start)/(end-start)*(W-pad.l-pad.r),y=p=>H-pad.b-p*(H-pad.t-pad.b);
  let out=`<div class="fx-chart-legend">${snapshot.model.regimes.map((r,i)=>`<span><i style="background:${COLORS[i]}"></i>${esc(r.label)}</span>`).join('')}</div><svg viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="fxProbabilitiesTitle fxProbabilitiesDesc"><title id="fxProbabilitiesTitle">과거 3국면 필터 확률</title><desc id="fxProbabilitiesDesc">${esc(history[0].date)} ~ ${esc(history.at(-1).date)}. 전체 추정표본 모수의 필터 확률. 확률 누락 구간은 연결하지 않음.</desc>`;
  for(let j=0;j<=4;j++){const p=j/4;out+=`<line x1="${pad.l}" x2="${W-pad.r}" y1="${y(p)}" y2="${y(p)}" stroke="#2c3632"/><text x="${pad.l-9}" y="${y(p)+4}" text-anchor="end" font-size="12">${fmt(p*100)}%</text>`;}
  const ticks=W<650?3:6;
  for(let j=0;j<=ticks;j++){const t=start+(end-start)*j/ticks;out+=`<text x="${x(t)}" y="${H-13}" text-anchor="${j===0?'start':j===ticks?'end':'middle'}" font-size="12">${new Date(t).toISOString().slice(0,7).replace('-','.')}</text>`;}
  const segments=[];let segment=[];
  for(const row of history){if(hasProbs(row))segment.push(row);else if(segment.length){segments.push(segment);segment=[];}}
  if(segment.length)segments.push(segment);
  for(let state=0;state<3;state++){
    const path=segments.filter(rows=>rows.length>1).map(rows=>rows.map((row,i)=>`${i?'L':'M'}${x(stamp(row.date)).toFixed(2)},${y(row.probs[state]).toFixed(2)}`).join(' ')).join(' ');
    if(path)out+=`<path data-state="${state+1}" d="${path}" fill="none" stroke="${COLORS[state]}" stroke-width="1.7" stroke-linejoin="round"/>`;
    for(const rows of segments.filter(rows=>rows.length===1)){const row=rows[0];out+=`<circle data-state="${state+1}" cx="${x(stamp(row.date)).toFixed(2)}" cy="${y(row.probs[state]).toFixed(2)}" r="2.5" fill="${COLORS[state]}"><title>${esc(row.date)} · ${esc(snapshot.model.regimes[state].label)} ${fmt(row.probs[state]*100,2)}%</title></circle>`;}
  }
  return out+'</svg>';
}
export function renderFxTable(snapshot, months=12) {
  const forecast=snapshot.forecast.slice(0,Math.round(months*21));
  return `<table><thead><tr><th>전망일</th><th>평균</th><th>중앙값</th><th>68% 범위</th><th>90% 범위</th><th>95% 범위</th><th>누적 로그 σ</th></tr></thead><tbody>${quarterRows(forecast).map(([q,r])=>`<tr><td>${quarterDisplay(q,r)} <span class="small">${r.date}</span></td><td class="fx-emphasis">${fmt(r.mean)}</td><td>${fmt(r.median)}</td><td>${fmt(r.lower68)} ~ ${fmt(r.upper68)}</td><td>${fmt(r.lower90)} ~ ${fmt(r.upper90)}</td><td>${fmt(r.lower95)} ~ ${fmt(r.upper95)}</td><td>${fmt(r.sigmaLog*100,2)}%</td></tr>`).join('')}</tbody></table>`;
}
export function fxModelCSV(snapshot, months=12, years=3) {
  const {history,forecast}=selectFxWindow(snapshot,months,years);
  const rows=[['type','date','spot_krw_per_usd','mean','median','lower68','upper68','lower90','upper90','lower95','upper95','sigma_log','prob_state1','prob_state2','prob_state3','analytic_mean','mean_mc_se','simulation_paths','simulation_seed','simulation_engine','simulation_rng']];
  history.forEach(r=>rows.push(['history',r.date,r.spot,'','','','','','','','', '',...(r.probs??['','','']),'','','','','','']));
  forecast.forEach(r=>rows.push(['forecast',r.date,'',r.mean,r.median,r.lower68,r.upper68,r.lower90,r.upper90,r.lower95,r.upper95,r.sigmaLog,...r.probs,r.analyticMean??'',r.meanSE??'',snapshot.simulation?.paths??'',snapshot.simulation?.seed??'',snapshot.simulation?.engine??'',snapshot.simulation?.rng??'']));
  const cell=value=>{let s=String(value);if(typeof value==='string'&&/^[=+@\-\t\r]/.test(s))s="'"+s;return /[\",\r\n]/.test(s)?'\"'+s.replace(/\"/g,'\"\"')+'\"':s;};
  return '\ufeff'+rows.map(row=>row.map(cell).join(',')).join('\r\n');
}
function validationMarkup(snapshot) {
  const v=snapshot.validation;
  let markup=`<div><dt>모형</dt><dd>Gaussian Markov Switching · 3 states</dd></div><div><dt>추정 상태</dt><dd>${snapshot.model.diagnostics.converged===true?'수렴 확인':snapshot.model.diagnostics.converged===false?'미수렴':'정보 없음'}</dd></div><div><dt>대상</dt><dd>일별 USDKRW 로그수익률 · 원/달러</dd></div><div><dt>국면 확률</dt><dd>전체 추정표본 모수의 필터 확률 · 실시간 OOS 아님</dd></div><div><dt>음영</dt><dd>국면 전환·국면별 충격을 반영한 조건부 예측 분위수</dd></div><div><dt>불확실성 프록시</dt><dd>전망기간 누적 로그수익률 표준편차</dd></div><div><dt>범위 제외</dt><dd>모수 추정·모형 선택·구조 변화 불확실성</dd></div><div><dt>전망 간격</dt><dd>21 관측일/월 · 월~금 날짜 · 휴일 미반영</dd></div>`;
  const sim=snapshot.simulation;
  if(sim)markup+=`<div><dt>현재 시뮬레이션</dt><dd>${fmt(sim.paths)}경로 · 시드 ${sim.seed} · ${esc(sim.engine)} v${sim.version}</dd></div><div><dt>중심경로</dt><dd>환율수준 표본 산술평균 · 시점별 중앙값</dd></div>`;
  const c=snapshot.meta.sourceComparison;
  if(c?.lastCommonDate&&c.primaryLastCommon!=null&&c.midpointLastCommon!=null)markup+=`<div><dt>자료 대조 · ${esc(c.lastCommonDate)}</dt><dd>data_bb PX_LAST ${fmt(c.primaryLastCommon,2)} / data_info 중간값 ${fmt(c.midpointLastCommon,2)} · 호가 정의·시점 상이</dd></div>`;
  if(v.summary)markup+=`<div><dt>검증</dt><dd>${esc(v.summary)}</dd></div>`;
  if(v.modelRmse!=null)markup+=`<div><dt>검증 RMSE · 원</dt><dd>모형 ${fmt(v.modelRmse,2)} / Random walk ${fmt(v.randomWalkRmse,2)}</dd></div>`;
  const o=v.outOfSample;
  if(o){
    markup+=`<div><dt>1기간 OOS</dt><dd>${o.testStart} ~ ${o.testEnd} · ${fmt(o.observations)}개 관측 · 모수 고정</dd></div><div><dt>OOS RMSE · 원</dt><dd>Markov ${fmt(o.modelRMSE,3)} / Random walk ${fmt(o.randomWalkRMSE,3)}</dd></div><div><dt>OOS 구간 포함률</dt><dd>68%: ${fmt(o.coverage68*100,2)}% · 90%: ${fmt(o.coverage90*100,2)}% · 95%: ${fmt(o.coverage95*100,2)}%</dd></div><div><dt>장기 예측구간</dt><dd>3~24개월 포함률 미검증</dd></div>`;
    if(o.trainingConverged===false)markup+='<div><dt>OOS 추정 상태</dt><dd class="warn">미수렴</dd></div>';
  }
  const c0=v.momentCheck;
  if(c0?.meanAgreementSE!=null&&c0.varianceAgreementSE!=null)markup+=`<div><dt>원본 수치 검증 · MC</dt><dd>평균 ${fmt(c0.meanAgreementSE,2)} SE / 분산 ${fmt(c0.varianceAgreementSE,2)} SE · ${fmt(c0.paths)}경로</dd></div>`;
  markup+='<div><dt>불러온 데이터</dt><dd>브라우저 메모리 · 새로고침 시 초기화</dd></div>';
  return markup;
}
export function mountFxModel(documentRoot=document) {
  const host=documentRoot.getElementById('fxModelHost');if(!host)return null;
  const $=id=>documentRoot.getElementById(id);let snapshot=null,months=12,years=3,coverage=95,showTable=false,center='both',showPaths=false,paths=10000,seed=20261020,runToken=0;
  host.innerHTML=`<div class="fx-model-toolbar"><div><h2>USDKRW <span class="pill">MARKOV · MONTE CARLO</span></h2><span id="fxModelSource" class="small">데이터 미연결</span></div><div class="fx-toolbar-actions"><button id="fxModelImport" class="button secondary">데이터 불러오기</button><input type="file" id="fxModelFile" accept=".json,application/json" hidden></div></div><div id="fxModelError" class="fx-model-error" role="alert" hidden></div><div id="fxModelWarning" class="fx-model-error" role="status" hidden></div><div id="fxModelMetrics" class="fx-model-metrics"></div><article class="panel fx-forecast-panel"><div class="fx-chart-toolbar"><div class="fx-chart-selectors"><label>과거 <select id="fxModelHistory" aria-label="과거 표시기간"><option value="1">1년</option><option value="3" selected>3년</option><option value="5">5년</option><option value="0">전체</option></select></label><label>전망 <select id="fxModelHorizon" aria-label="전망 표시기간"><option value="3">3개월</option><option value="6">6개월</option><option value="12" selected>12개월</option><option value="24">24개월</option></select></label><label>예측구간 <select id="fxModelCoverage" aria-label="예측구간 표시 범위"><option value="68">68%</option><option value="90">90%</option><option value="95" selected>95%</option></select></label></div><div class="fx-toolbar-actions"><button id="fxModelTableButton" class="button secondary" aria-expanded="false" aria-controls="fxModelTable" disabled>표</button><button id="fxModelCSV" class="button secondary" disabled>CSV</button></div></div><div class="fx-simulation-controls"><label>중심경로 <select id="fxModelCenter"><option value="both">평균 + 중앙값</option><option value="mean">평균</option><option value="median">중앙값</option></select></label><label>시뮬레이션 <select id="fxModelPaths"><option value="2000">2,000경로</option><option value="10000" selected>10,000경로</option><option value="40000">40,000경로</option></select></label><label>시드 <input id="fxModelSeed" type="number" min="0" max="4294967295" step="1" value="20261020" aria-label="시뮬레이션 시드"></label><button id="fxModelRun" class="button secondary" disabled>재실행</button><button id="fxModelShowPaths" class="button secondary" aria-pressed="false" disabled>개별 경로</button><span id="fxSimulationStatus" role="status" class="small"></span></div><div class="fx-chart-legend"><span><i class="fx-line-history"></i>원/달러</span><span id="fxLegendMean"><i class="fx-line-mean"></i>MC 평균</span><span id="fxLegendMedian"><i class="fx-line-median"></i>MC 중앙값</span><span><i class="fx-band-68"></i>68%</span><span id="fxLegend90"><i class="fx-band-90"></i>90%</span><span id="fxLegend95"><i class="fx-band-95"></i>95% 예측구간</span></div><div id="fxModelChart" class="chart-wrap fx-model-chart"><div class="fx-model-empty"><span>USDKRW</span><strong>전망 데이터 미연결</strong></div></div><div id="fxModelTable" class="table-scroll fx-model-table" hidden></div><div class="fx-chart-meta"><span id="fxModelPeriod">원/달러 · 조건부 예측구간</span><span id="fxModelSample"></span></div></article><div id="fxModelDetails" hidden><div class="section-heading fx-regime-heading"><h2>현재 국면 확률</h2><span class="small" id="fxModelRegimeDate"></span></div><div id="fxModelRegimes" class="fx-regime-grid"></div><article class="panel fx-probability-panel"><div class="panel-heading"><h2>국면 확률 추이</h2><span class="small">필터 확률 · 전체표본 모수</span></div><div id="fxModelProbabilities" class="chart-wrap fx-probability-chart"></div></article><article class="panel fx-transition-panel"><div class="panel-heading"><h2>국면 전이확률</h2><span class="small">다음 관측일 · 행 → 열</span></div><div id="fxModelTransition" class="table-scroll"></div></article><details class="fx-method"><summary>모형·불확실성·검증</summary><dl id="fxModelMethod"></dl></details></div>`;
  function render(){
    if(!snapshot)return;
    const last=snapshot.history.at(-1),end=selectFxWindow(snapshot,months,years).forecast.at(-1);
    const warnings=[...snapshot.meta.warnings];if(snapshot.model.diagnostics.converged===false&&!warnings.length)warnings.push('모형 추정 미수렴');$('fxModelWarning').textContent=warnings.join(' · ');$('fxModelWarning').hidden=!warnings.length;
    $('fxModelSource').textContent=`${snapshot.meta.source} · ${snapshot.meta.asOf}`;
    $('fxModelMetrics').innerHTML=`<div><span>최근</span><strong>${fmt(last.spot)}<small> 원</small></strong><small>${last.date}</small></div><div><span>${months}개월 평균 전망</span><strong class="fx-salmon">${fmt(end.mean)}<small> 원</small></strong><small>${end.date}</small></div><div><span>${months}개월 중앙값 전망</span><strong>${fmt(end.median)}<small> 원</small></strong><small>${end.date}</small></div><div><span>누적 로그 σ</span><strong>${fmt(end.sigmaLog*100,2)}<small>%</small></strong><small>전환·충격 불확실성</small></div>`;
    $('fxModelChart').innerHTML=renderFxChart(snapshot,months,years,$('fxModelChart').clientWidth||1040,coverage,center,showPaths);
    $('fxLegendMean').hidden=center==='median';$('fxLegendMedian').hidden=center==='mean';
    $('fxModelRun').disabled=false;$('fxModelShowPaths').disabled=false;
    $('fxSimulationStatus').textContent=`${fmt(snapshot.simulation.paths)}경로 · 시드 ${snapshot.simulation.seed}`;
    $('fxLegend90').hidden=coverage<90;$('fxLegend95').hidden=coverage<95;
    $('fxModelTable').innerHTML=renderFxTable(snapshot,months);$('fxModelTable').hidden=!showTable;
    $('fxModelTableButton').disabled=false;$('fxModelCSV').disabled=false;
    $('fxModelPeriod').textContent=`최근 ${fmt(last.spot)} · ${last.date} · 원/달러 · * 전망기간 말`;
    $('fxModelSample').textContent=`추정 ${snapshot.meta.start} ~ ${snapshot.meta.end} · ${fmt(snapshot.meta.n)}개 환율관측`;
    const regime=renderFxRegimes(snapshot);$('fxModelRegimes').innerHTML=regime.cards;$('fxModelTransition').innerHTML=regime.matrix;
    $('fxModelProbabilities').innerHTML=renderFxProbabilities(snapshot,years,$('fxModelProbabilities').clientWidth||1040);
    $('fxModelRegimeDate').textContent=snapshot.meta.asOf;$('fxModelMethod').innerHTML=validationMarkup(snapshot);$('fxModelDetails').hidden=false;
  }
  function clear(){
    snapshot=null;showTable=false;runToken++;
    $('fxModelRun').disabled=true;$('fxModelShowPaths').disabled=true;$('fxSimulationStatus').textContent='';
    $('fxModelSource').textContent='데이터 미연결';
    for(const id of ['fxModelMetrics','fxModelTable','fxModelRegimes','fxModelProbabilities','fxModelTransition','fxModelMethod'])$(id).innerHTML='';
    for(const id of ['fxModelError','fxModelWarning']){$(id).textContent='';$(id).hidden=true;}
    $('fxModelChart').innerHTML='<div class="fx-model-empty"><span>USDKRW</span><strong>전망 데이터 미연결</strong></div>';
    $('fxModelDetails').hidden=true;$('fxModelTable').hidden=true;
    $('fxModelTableButton').disabled=true;$('fxModelTableButton').setAttribute('aria-expanded','false');$('fxModelCSV').disabled=true;
    $('fxModelPeriod').textContent='원/달러 · 조건부 예측구간';$('fxModelSample').textContent='';$('fxModelRegimeDate').textContent='';
    [...$('fxModelHorizon').options].forEach(option=>option.disabled=false);
    return null;
  }
  function install(raw,{prepared=false}={}){
    if(raw===null)return clear();
    const next=prepared?raw:prepareFxSimulation(raw,{paths,seed});
    snapshot=next;runToken++;paths=next.simulation.paths;seed=next.simulation.seed;
    $('fxModelPaths').value=String(paths);$('fxModelSeed').value=String(seed);
    const options=[...$('fxModelHorizon').options];options.forEach(option=>option.disabled=Number(option.value)*21>next.forecast.length);
    if(months*21>next.forecast.length){const available=options.filter(option=>!option.disabled);months=available.length?Number(available.at(-1).value):next.forecast.length/21;}
    $('fxModelHorizon').value=String(months);$('fxModelError').hidden=true;render();return snapshot;
  }
  $('fxModelImport').onclick=()=>$('fxModelFile').click();
  $('fxModelFile').onchange=async event=>{
    const file=event.target.files?.[0];if(!file)return;
    try{if(file.size>12e6)throw Error('JSON 파일은 12MB 이하여야 합니다.');const raw=JSON.parse(await file.text());install(raw.fxModel??raw);}
    catch(error){$('fxModelError').textContent=`환율모형 데이터를 불러오지 못했습니다: ${error.message}`;$('fxModelError').hidden=false;}
    finally{event.target.value='';}
  };
  $('fxModelCenter').onchange=event=>{center=event.target.value;render();};
  $('fxModelShowPaths').onclick=()=>{showPaths=!showPaths;$('fxModelShowPaths').setAttribute('aria-pressed',String(showPaths));render();};
  $('fxModelPaths').value=String(paths);$('fxModelSeed').value=String(seed);
  $('fxModelRun').onclick=async()=>{
    if(!snapshot)return;
    const token=++runToken,previous=snapshot;
    $('fxModelRun').disabled=true;$('fxSimulationStatus').textContent='계산 중';
    await new Promise(resolve=>setTimeout(resolve,20));
    if(token!==runToken)return;
    try{
      if($('fxModelSeed').value.trim()==='')throw Error('시드를 입력하십시오.');
      const nextPaths=Number($('fxModelPaths').value),nextSeed=Number($('fxModelSeed').value);
      const next=prepareFxSimulation(previous,{paths:nextPaths,seed:nextSeed});
      if(token!==runToken)return;
      snapshot=next;paths=nextPaths;seed=nextSeed;$('fxModelError').hidden=true;render();
    }catch(error){$('fxModelError').textContent=`시뮬레이션 오류 · ${error.message}`;$('fxModelError').hidden=false;render();}
    finally{if(token===runToken)$('fxModelRun').disabled=false;}
  };
  $('fxModelHistory').onchange=event=>{years=Number(event.target.value);render();};
  $('fxModelCoverage').onchange=event=>{coverage=Number(event.target.value);render();};
  $('fxModelHorizon').onchange=event=>{months=Number(event.target.value);render();};
  $('fxModelTableButton').onclick=()=>{showTable=!showTable;$('fxModelTable').hidden=!showTable;$('fxModelTableButton').setAttribute('aria-expanded',String(showTable));};
  $('fxModelCSV').onclick=()=>{if(!snapshot)return;const url=URL.createObjectURL(new Blob([fxModelCSV(snapshot,months,years)],{type:'text/csv;charset=utf-8;'}));const a=documentRoot.createElement('a');a.href=url;a.download=`USDKRW_MC_${snapshot.meta.asOf}_${months}M_seed${snapshot.simulation.seed}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  if(typeof ResizeObserver!=='undefined'){let previous=0;new ResizeObserver(entries=>{const width=entries[0].contentRect.width;if(width>0&&width!==previous){previous=width;render();}}).observe($('fxModelChart'));}
  return {install,clear,getSnapshot:()=>snapshot};
}
