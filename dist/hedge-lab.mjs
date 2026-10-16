/** Hedge histories and user-controlled scenarios. Source units are never inferred. */
const CURRENCIES = ['USDKRW', 'JPYKRW', 'AUDKRW', 'EURKRW'];
const TENORS = [['PR','krPr','usPr'],['3M','kr3m','us3m'],['1Y','kr1y','us1y'],['2Y','kr2y','us2y'],['3Y','kr3y','us3y']];
const HISTORY_KEYS = ['spot','hedge3m','hedge6m','hedge12m','hedgeMean'];
const COLORS = ['#67b7e8','#d5bd83','#bb92d3','#7fc5ac'];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = value => Number.isFinite(value) ? value.toLocaleString('ko-KR',{minimumFractionDigits:2,maximumFractionDigits:2}) : '—';
const stamp = value => Date.parse(`${value}T00:00:00Z`);
const mean = values => values.length ? values.reduce((s,v)=>s+v,0)/values.length : null;
const fail = label => { throw Error(`${label} 값을 확인하십시오.`); };
function date(value,label) {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(stamp(value))||new Date(stamp(value)).toISOString().slice(0,10)!==value)fail(label);
  return value;
}
function number(value,label,nullable=true,min=-1e10,max=1e10) {
  if(value==null&&nullable)return null;
  if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)fail(label);
  return value;
}
function text(value,fallback='') { if(value==null)return fallback;if(typeof value!=='string'||value.length>500)fail('문자열');return value; }
function freeze(value) { if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value; }
/** Validate/copy a snapshot atomically, accepting sparse but strictly ordered histories. */
export function normalizeHedgeFx(raw) {
  if(raw==null)return freeze({schemaVersion:1,source:'데이터 미연결',asOf:null,unit:'source_value',unitVerified:false,pairs:[],usdRates:[]});
  if(typeof raw!=='object'||raw.schemaVersion!==1||!['source_value','annual_percent'].includes(raw.unit)||!Array.isArray(raw.pairs)||!Array.isArray(raw.usdRates)||raw.pairs.length>4||raw.usdRates.length>30000)fail('Hedge·FX 스냅샷');
  const asOf=date(raw.asOf,'Hedge·FX 기준일'),seen=new Set();
  if(raw.unitVerified!=null&&typeof raw.unitVerified!=='boolean')fail('단위 확인');
  const pairs=raw.pairs.map(pair=>{
    const currency=CURRENCIES.includes(pair?.currency)?pair.currency:`${pair?.currency}KRW`;
    if(!CURRENCIES.includes(currency)||seen.has(currency)||!Array.isArray(pair.history)||pair.history.length>30000)fail('통화·관측값');
    seen.add(currency);
    const pairAsOf=pair.asOf==null?asOf:date(pair.asOf,`${currency} 기준일`);
    if(pairAsOf>asOf)fail(`${currency} 기준일`);
    const history=pair.history.map((row,i)=>{
      if(!row||typeof row!=='object')fail(`${currency} 관측값`);
      const d=date(row.date,`${currency} 관측일`);
      if(d>asOf||(i&&d<=pair.history[i-1].date))fail(`${currency} 날짜 순서`);
      const next={date:d};
      for(const key of HISTORY_KEYS)next[key]=number(row[key],`${currency} ${key}`,true,key==='spot'?Number.MIN_VALUE:-1e10);
      if(next.hedgeMean!=null){
        const tenors=[next.hedge3m,next.hedge6m,next.hedge12m];
        if(!tenors.every(Number.isFinite)||Math.abs(next.hedgeMean-mean(tenors))>1e-8*Math.max(1,Math.abs(next.hedgeMean)))fail(`${currency} 평균 프리미엄`);
      }
      return next;
    });
    return {currency,asOf:pairAsOf,spotUnit:text(pair.spotUnit,currency==='JPYKRW'?'KRW/100JPY':`KRW/${currency.slice(0,3)}`),source:text(pair.source,text(raw.source)),spotSource:text(pair.spotSource),history};
  });
  const usdRates=raw.usdRates.map((row,i)=>{
    if(!row||typeof row!=='object')fail('금리 관측값');
    const d=date(row.date,'금리 관측일');if(d>asOf||(i&&d<=raw.usdRates[i-1].date))fail('금리 날짜 순서');
    const next={date:d};for(const key of TENORS.flatMap(t=>t.slice(1)))next[key]=number(row[key],key);
    return next;
  });
  return freeze({schemaVersion:1,source:text(raw.source,'사용자 데이터'),asOf,unit:raw.unit,unitVerified:raw.unitVerified===true,pairs,usdRates});
}
export function annualPremiumEnabled(snapshot,assumption='') {
  return (snapshot.unit==='annual_percent'&&snapshot.unitVerified===true)||assumption==='annual_percent';
}
export function alignHedgeRates(snapshot,tenor='3M',start='') {
  const fields=TENORS.find(t=>t[0]===tenor);if(!fields)fail('금리 만기');
  const history=new Map((snapshot.pairs.find(p=>p.currency==='USDKRW')?.history??[]).map(r=>[r.date,r]));
  return snapshot.usdRates.filter(r=>r.date>=start&&Number.isFinite(r[fields[1]])&&Number.isFinite(r[fields[2]])&&Number.isFinite(history.get(r.date)?.hedgeMean)).map(r=>({date:r.date,kr:r[fields[1]],us:r[fields[2]],difference:r[fields[1]]-r[fields[2]],premium:history.get(r.date).hedgeMean}));
}
export function hedgeDiagnostics(rows,annualPercent=false) {
  const n=rows.length;
  if(!n)return {n:0,correlation:null,rmse:null,gap:null,zScore:null};
  const x=rows.map(r=>r.difference),y=rows.map(r=>r.premium),mx=mean(x),my=mean(y);
  const xx=x.reduce((s,v)=>s+(v-mx)**2,0),yy=y.reduce((s,v)=>s+(v-my)**2,0);
  const xy=x.reduce((s,v,i)=>s+(v-mx)*(y[i]-my),0);
  const correlation=n>=3&&xx>0&&yy>0?Math.max(-1,Math.min(1,xy/Math.sqrt(xx*yy))):null;
  if(!annualPercent)return {n,correlation,rmse:null,gap:null,zScore:null};
  const gaps=rows.map(r=>r.premium-r.difference),m=mean(gaps),gap=gaps.at(-1);
  const sd=n>=3?Math.sqrt(gaps.reduce((s,v)=>s+(v-m)**2,0)/(n-1)):null;
  return {n,correlation,rmse:Math.sqrt(mean(gaps.map(v=>v*v))),gap,zScore:sd>1e-12?(gap-m)/sd:null};
}
/** Percent inputs and outputs. First-order additive local/FX return approximation. */
export function hedgeScenario({muAsset,volAsset,muFx,volFx,correlation,hedgeRatio,premium=null,horizonMonths=12}) {
  for(const [key,value,min,max] of [['자산수익률',muAsset,-1000,1000],['자산변동성',volAsset,0,1000],['환수익률',muFx,-1000,1000],['환변동성',volFx,0,1000],['상관계수',correlation,-1,1],['헤지비율',hedgeRatio,0,1],['기간',horizonMonths,1,120]])number(value,key,false,min,max);
  if(premium!=null)number(premium,'프리미엄',false);
  const exposure=1-hedgeRatio,years=horizonMonths/12;
  const variance=volAsset**2+exposure**2*volFx**2+2*exposure*correlation*volAsset*volFx;
  const annualReturn=hedgeRatio===0?muAsset+muFx:premium==null?null:muAsset+exposure*muFx+hedgeRatio*premium;
  const annualVol=Math.sqrt(Math.max(0,variance));
  return {annualReturn,annualVol,periodReturn:annualReturn==null?null:annualReturn*years,periodVol:annualVol*Math.sqrt(years),hedgeRatio,premium};
}
export function realizedFxVol(history,asOf=null) {
  const rows=history.filter(r=>asOf==null||r.date<=asOf).slice(-253);
  if(rows.length!==253||rows.some(r=>!Number.isFinite(r.spot)||r.spot<=0))return null;
  const returns=rows.slice(1).map((r,i)=>Math.log(r.spot/rows[i].spot));
  const m=mean(returns);return Math.sqrt(returns.reduce((s,v)=>s+(v-m)**2,0)/(returns.length-1)*252)*100;
}
function lineChart(series,{title='',unit='',height=235}={}) {
  const all=series.flatMap(s=>s.rows.filter(r=>Number.isFinite(r.value)));
  if(!all.length)return '<div class="hl-empty">데이터 없음</div>';
  const W=1000,H=height,p={l:67,r:24,t:28,b:38};
  const times=all.map(r=>stamp(r.date)),values=all.map(r=>r.value);
  const xMin=Math.min(...times),xMax=Math.max(...times),low=Math.min(...values),high=Math.max(...values),gap=Math.max(high-low,Math.abs(low)*.05,.1),yMin=low-gap*.1,yMax=high+gap*.1;
  const x=t=>p.l+(t-xMin)/Math.max(86400000,xMax-xMin)*(W-p.l-p.r),y=v=>H-p.b-(v-yMin)/(yMax-yMin)*(H-p.t-p.b);
  let svg=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title><text x="${p.l}" y="15" class="hl-svg-unit">${esc(unit)}</text>`;
  for(let i=0;i<=4;i++){const value=yMin+(yMax-yMin)*i/4;svg+=`<line x1="${p.l}" x2="${W-p.r}" y1="${y(value)}" y2="${y(value)}" class="hl-gridline"/><text x="${p.l-10}" y="${y(value)+4}" text-anchor="end">${fmt(value)}</text>`;}
  const ticks=xMin===xMax?1:5;
  for(let i=0;i<ticks;i++){const time=xMin+(xMax-xMin)*i/Math.max(1,ticks-1);svg+=`<text x="${x(time)}" y="${H-12}" text-anchor="${i===0?'start':i===ticks-1?'end':'middle'}">${new Date(time).toISOString().slice(0,10)}</text>`;}
  for(const [index,s] of series.entries()){
    let started=false;const path=s.rows.map(row=>{if(!Number.isFinite(row.value)){started=false;return '';}const part=`${started?'L':'M'}${x(stamp(row.date)).toFixed(2)},${y(row.value).toFixed(2)}`;started=true;return part;}).join(' ');
    svg+=`<path d="${path}" fill="none" stroke="${s.color??COLORS[index%COLORS.length]}" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
    const last=s.rows.filter(r=>Number.isFinite(r.value)).at(-1);if(last)svg+=`<circle cx="${x(stamp(last.date))}" cy="${y(last.value)}" r="3.3" fill="${s.color??COLORS[index%COLORS.length]}"/>`;
  }
  return svg+'</svg>';
}
function unitSelect(id,snapshot,assumption) {
  const verified=annualPremiumEnabled(snapshot)&&snapshot.unitVerified;
  return `<label>프리미엄 단위<select id="${id}" data-hl-unit${verified?' disabled':''}>${verified?'<option value="">연율 % · 확인됨</option>':`<option value=""${!assumption?' selected':''}>원자료 · 단위 확인</option><option value="annual_percent"${assumption?' selected':''}>연율 % · 사용자 가정</option>`}</select></label>`;
}
function legend(items) { return `<div class="hl-legend">${items.map(([label,color])=>`<span><i style="--hl-color:${color}"></i>${esc(label)}</span>`).join('')}</div>`; }
function meta(snapshot,rows) { return `<div class="hl-meta"><span>${esc(snapshot.source)}</span><span>${rows.length?`${rows[0].date} — ${rows.at(-1).date} · ${rows.length.toLocaleString('ko-KR')}개`:'데이터 없음'}</span></div>`; }
function metric(label,value,unit='',className='') { return `<div class="${className}"><dt>${esc(label)}${unit?` <span>(${esc(unit)})</span>`:''}</dt><dd>${fmt(value)}</dd></div>`; }
export function renderHedgeModelA(snapshot,{start='2015-01-01',assumption=''}={}) {
  const annual=annualPremiumEnabled(snapshot,assumption);
  const data=TENORS.map(([tenor])=>{const rows=alignHedgeRates(snapshot,tenor,start);return {tenor,rows,latest:rows.at(-1),stats:hedgeDiagnostics(rows,annual)};});
  const cards=`<div class="hl-rate-cards">${data.map(({tenor,latest,stats})=>`<article class="hl-rate-card"><div class="hl-card-head"><h3>${tenor}</h3><small>${latest?.date??'데이터 없음'}</small></div><dl>${metric('한국',latest?.kr,'%','hl-source')}${metric('미국',latest?.us,'%','hl-source')}${metric('금리차',latest?.difference,'%p','hl-source')}${metric('헤지 평균',latest?.premium,annual?'%':'원자료','hl-source')}${metric('상관계수',stats.correlation,'','hl-divider')}${metric('RMSE',stats.rmse,'%p')}${metric('현재 괴리',stats.gap,'%p')}${metric('Z-score',stats.zScore)}</dl><div class="hl-card-status">${annual?`${stats.n.toLocaleString('ko-KR')}개`:'단위 확인'}</div></article>`).join('')}</div>`;
  const charts=data.map(({tenor,rows})=>{
    const rate={rows:rows.map(r=>({date:r.date,value:r.difference})),color:COLORS[0]},premium={rows:rows.map(r=>({date:r.date,value:r.premium})),color:COLORS[1]};
    const chart=annual?lineChart([rate,premium],{title:`${tenor} 한미 금리차 및 헤지 프리미엄`,unit:'% / %p',height:280}):`<div class="hl-split-chart">${lineChart([rate],{title:`${tenor} 한미 금리차`,unit:'한미 금리차 (%p)',height:200})}${lineChart([premium],{title:`${tenor} 헤지 프리미엄 원자료`,unit:'헤지 평균 (원자료)',height:200})}</div>`;
    return `<article class="panel hl-comparison"><div class="hl-heading"><h3>${tenor}</h3>${legend([['한미 금리차',COLORS[0]],['헤지 평균',COLORS[1]]])}</div><div class="hl-chart">${chart}</div>${meta(snapshot,rows)}</article>`;
  }).join('');
  return cards+`<div class="hl-comparison-grid">${charts}</div>`;
}
function csvDownload(document,name,rows) {
  const blob=new Blob(['\ufeff'+rows.map(row=>row.map(cell=>`"${String(cell??'').replaceAll('"','""')}"`).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function latestPremium(pair,key) { return pair?.history.findLast(row=>Number.isFinite(row[key]))??null; }
function renderScenarioCurve(inputs,premium) {
  const rows=Array.from({length:101},(_,i)=>({ratio:i,...hedgeScenario({...inputs,premium,hedgeRatio:i/100})}));
  const W=1000,H=290,p={l:64,r:64,t:24,b:40},maxVol=Math.max(...rows.map(r=>r.annualVol),1)*1.15;
  const returns=rows.map(r=>r.annualReturn).filter(Number.isFinite),lo=returns.length?Math.min(...returns):0,hi=returns.length?Math.max(...returns):1,gap=Math.max(hi-lo,.5),rMin=lo-gap*.15,rMax=hi+gap*.15;
  const x=h=>p.l+h*(W-p.l-p.r),vY=v=>H-p.b-v/maxVol*(H-p.t-p.b),rY=v=>H-p.b-(v-rMin)/(rMax-rMin)*(H-p.t-p.b);
  let out=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="헤지비율별 연간 수익률 근사와 변동성"><title>헤지비율별 연간 수익률 근사와 변동성</title>`;
  for(let i=0;i<=4;i++){const v=maxVol*i/4,py=vY(v);out+=`<line x1="${p.l}" x2="${W-p.r}" y1="${py}" y2="${py}" class="hl-gridline"/><text x="${p.l-10}" y="${py+4}" text-anchor="end">${fmt(v)}</text>`;if(premium!=null)out+=`<text x="${W-p.r+10}" y="${py+4}">${fmt(rMin+(rMax-rMin)*i/4)}</text>`;}
  for(let i=0;i<=4;i++)out+=`<text x="${x(i/4)}" y="${H-12}" text-anchor="${i===0?'start':i===4?'end':'middle'}">${i*25}%</text>`;
  out+=`<text x="${p.l}" y="15" class="hl-svg-unit">변동성 (연 %)</text>${premium==null?'':`<text x="${W-p.r}" y="15" text-anchor="end" class="hl-svg-unit">기대수익 (연 %)</text>`}`;
  out+=`<path d="${rows.map((r,i)=>`${i?'L':'M'}${x(r.ratio/100)},${vY(r.annualVol)}`).join(' ')}" stroke="${COLORS[0]}" stroke-width="2.2" fill="none"/>`;
  if(premium!=null)out+=`<path d="${rows.map((r,i)=>`${i?'L':'M'}${x(r.ratio/100)},${rY(r.annualReturn)}`).join(' ')}" stroke="${COLORS[1]}" stroke-width="2.2" fill="none"/>`;
  out+=`<line x1="${x(inputs.hedgeRatio)}" x2="${x(inputs.hedgeRatio)}" y1="${p.t}" y2="${H-p.b}" stroke="#dbe2dc" stroke-dasharray="4 5"/>`;
  return out+'</svg>';
}
function bControls(snapshot,assumption) {
  const input=(id,label,value,min,max,step='.1')=>`<label>${label}<input id="${id}" type="number" value="${value}" min="${min}" max="${max}" step="${step}" required>${id==='hlVolFx'?'<small id="hlVolFxStatus" class="hl-input-status">직접입력</small>':''}</label>`;
  return `<div class="hl-toolbar"><h2>헤지비율 시나리오 <span class="hl-status">사용자 가정</span></h2>${unitSelect('hlBUnit',snapshot,assumption)}</div><div class="hl-scenario-controls"><label>통화<select id="hlCurrency">${CURRENCIES.map(c=>`<option>${c}</option>`).join('')}</select></label><label>프리미엄 만기<select id="hlTenor"><option value="hedgeMean">평균</option><option value="hedge3m">3M</option><option value="hedge6m">6M</option><option value="hedge12m">12M</option></select></label><label>투자기간<select id="hlHorizon"><option value="3">3개월</option><option value="6">6개월</option><option value="12" selected>12개월</option></select></label>${input('hlMuAsset','자산 기대수익 (연 %)',4,-1000,1000)}${input('hlVolAsset','자산 변동성 (연 %)',8,0,1000)}${input('hlMuFx','환 기대수익 (연 %)',0,-1000,1000)}${input('hlVolFx','환 변동성 가정 (연 %)','',0,1000)}${input('hlCorrelation','자산·환 상관계수',0,-1,1,'.05')}</div><div class="hl-hedge-ratio"><label for="hlHedgeRatio">헤지비율</label><input id="hlHedgeRatio" type="range" min="0" max="100" step="1" value="50"><output id="hlRatioOutput" for="hlHedgeRatio">50%</output></div><div id="hlScenarioError" class="hl-error" role="alert" hidden></div><div id="hlScenarioResults"></div>`;
}
/** Mount once; install validated snapshots without replacing the active data on errors. */
export function mountHedgeLab(document) {
  const a=document.getElementById('hedgeModelAHost'),b=document.getElementById('hedgeModelBHost'),monitor=document.getElementById('hedgeHistoryHost');
  let snapshot=normalizeHedgeFx(null),assumption='',start='2015-01-01';
  const q=id=>document.getElementById(id);
  if(a)a.innerHTML=`<div class="hl-toolbar"><h2>금리차 · 헤지 프리미엄</h2><div class="hl-control-row"><label>시작기간<input id="hlStart" type="date" value="${start}"></label><span id="hlAUnitHost"></span><button id="hlExport" class="button">CSV</button></div></div><div id="hlModelAContent"></div>`;
  if(b)b.innerHTML=bControls(snapshot,assumption);
  if(monitor)monitor.innerHTML='<div class="hl-toolbar"><h2>프리미엄 시계열</h2><div class="hl-control-row"><label>만기<select id="hlHistoryTenor"><option value="hedgeMean">평균</option><option value="hedge3m">3M</option><option value="hedge6m">6M</option><option value="hedge12m">12M</option></select></label><label>기간<select id="hlHistoryYears"><option value="1">1년</option><option value="3" selected>3년</option><option value="5">5년</option><option value="all">전체</option></select></label></div></div><div id="hlHistoryContent" class="hl-history-grid"></div>';
  function refreshUnits() {
    if(a)q('hlAUnitHost').innerHTML=unitSelect('hlAUnit',snapshot,assumption);
    if(b){const current=q('hlBUnit'),verified=snapshot.unit==='annual_percent'&&snapshot.unitVerified;current.innerHTML=verified?'<option value="">연율 % · 확인됨</option>':'<option value="">원자료 · 단위 확인</option><option value="annual_percent">연율 % · 사용자 가정</option>';current.disabled=verified;current.value=assumption;}
  }
  function renderA(){if(a)q('hlModelAContent').innerHTML=renderHedgeModelA(snapshot,{start,assumption});}
  function renderMonitor(){
    if(!monitor)return;
    const key=q('hlHistoryTenor').value,years=q('hlHistoryYears').value,cutoff=new Date(stamp(snapshot.asOf??'2000-01-01'));cutoff.setUTCFullYear(cutoff.getUTCFullYear()-(Number(years)||1000));
    q('hlHistoryContent').innerHTML=CURRENCIES.map((currency,i)=>{
      const pair=snapshot.pairs.find(p=>p.currency===currency),rows=(pair?.history??[]).filter(r=>stamp(r.date)>=cutoff.valueOf()),last=rows.findLast(r=>Number.isFinite(r[key]));
      const annual=snapshot.unit==='annual_percent'&&snapshot.unitVerified;
      return `<article class="panel hl-history-panel"><div class="hl-heading"><h3>${currency}</h3><strong>${fmt(last?.[key])}${annual?'%':''}</strong></div><div class="hl-chart">${lineChart([{rows:rows.map(r=>({date:r.date,value:r[key]})),color:COLORS[i]}],{title:`${currency} ${key} 프리미엄`,unit:annual?'연 %':'원자료'})}</div>${meta(snapshot,rows)}</article>`;
    }).join('');
  }
  function updateFxVol(){
    if(!b)return;const pair=snapshot.pairs.find(p=>p.currency===q('hlCurrency').value),vol=realizedFxVol(pair?.history??[],pair?.asOf);
    q('hlVolFx').value=vol==null?'':vol.toFixed(2);
    q('hlVolFxStatus').textContent=vol==null?'직접입력':'자동 · 252관측';
  }
  function renderB(){
    if(!b)return;
    const ratio=Number(q('hlHedgeRatio').value)/100;q('hlRatioOutput').textContent=`${Math.round(ratio*100)}%`;
    const inputLabels={hlMuAsset:'자산 기대수익',hlVolAsset:'자산 변동성',hlMuFx:'환 기대수익',hlVolFx:'환 변동성 가정',hlCorrelation:'상관계수',hlHorizon:'투자기간'};
    const read=id=>{const value=q(id).value;if(value.trim()==='')fail(inputLabels[id]??'입력');return Number(value);};
    try{
      const inputs={muAsset:read('hlMuAsset'),volAsset:read('hlVolAsset'),muFx:read('hlMuFx'),volFx:read('hlVolFx'),correlation:read('hlCorrelation'),horizonMonths:read('hlHorizon'),hedgeRatio:ratio};
      const pair=snapshot.pairs.find(p=>p.currency===q('hlCurrency').value),last=latestPremium(pair,q('hlTenor').value),raw=last?.[q('hlTenor').value]??null,annual=annualPremiumEnabled(snapshot,assumption),premium=annual?raw:null;
      const cases=[['미헤지',0],['선택',ratio],['전액헤지',1]].map(([label,hedgeRatio])=>({label,...hedgeScenario({...inputs,hedgeRatio,premium})}));
      q('hlScenarioResults').innerHTML=`<div class="hl-scenario-source"><span>${esc(pair?.currency??'USDKRW')} · ${last?.date??'데이터 없음'}</span><span>프리미엄 ${fmt(raw)}${annual?'%':' · 단위 확인'}</span><span>${inputs.horizonMonths}개월 · 가산 근사</span></div><div class="hl-scenario-cards">${cases.map(c=>`<article class="hl-scenario-card${c.label==='선택'?' is-selected':''}"><div class="hl-card-head"><h3>${c.label}</h3><small>${fmt(c.hedgeRatio*100)}%</small></div><dl>${metric('기대수익',c.periodReturn,'%')}${metric('변동성',c.periodVol,'%')}${metric('기대수익',c.annualReturn,'연 %')}${metric('변동성',c.annualVol,'연 %')}</dl></article>`).join('')}</div><div class="panel hl-scenario-chart">${legend([['변동성',COLORS[0]],...(premium==null?[]:[['기대수익',COLORS[1]]])])}<div class="hl-chart">${renderScenarioCurve(inputs,premium)}</div></div>`;
      q('hlScenarioError').hidden=true;
    }catch(error){q('hlScenarioError').textContent=error.message;q('hlScenarioError').hidden=false;q('hlScenarioResults').innerHTML='';}
  }
  function unitChanged(value){assumption=value==='annual_percent'?'annual_percent':'';refreshUnits();renderA();renderB();}
  a?.addEventListener('change',event=>{if(event.target.id==='hlAUnit')unitChanged(event.target.value);if(event.target.id==='hlStart'){start=event.target.value||'2015-01-01';renderA();}});
  b?.addEventListener('change',event=>{if(event.target.id==='hlBUnit'){unitChanged(event.target.value);return;}if(event.target.id==='hlCurrency')updateFxVol();if(event.target.id==='hlVolFx')q('hlVolFxStatus').textContent='직접입력';renderB();});
  b?.addEventListener('input',event=>{if(event.target.id==='hlHedgeRatio')renderB();});
  monitor?.addEventListener('change',renderMonitor);
  q('hlExport')?.addEventListener('click',()=>{
    const annual=annualPremiumEnabled(snapshot,assumption),rows=[['tenor','date','kr_rate_pct','us_rate_pct','rate_difference_pp','hedge_premium_source_value','source_unit','user_unit_assumption','gap_pp']];
    for(const [tenor] of TENORS)for(const r of alignHedgeRates(snapshot,tenor,start))rows.push([tenor,r.date,r.kr,r.us,r.difference,r.premium,snapshot.unit,assumption,annual?r.premium-r.difference:'']);
    csvDownload(document,`BJE_Hedge_USD_${snapshot.asOf??'snapshot'}.csv`,rows);
  });
  function install(raw){const next=normalizeHedgeFx(raw);snapshot=next;assumption='';refreshUnits();updateFxVol();renderA();renderB();renderMonitor();return snapshot;}
  install(null);
  return {install,getSnapshot:()=>snapshot};
}
