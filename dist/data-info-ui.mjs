import { normalizeFxHedge } from './fx-hedge.mjs';
import { normalizeHedgeAnalytics } from './hedge-analytics.mjs';
import { normalizeFxAnalyticsSpots } from './fx-workspace.mjs';
import { normalizeFxModel } from './fx-model-ui.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = (value, digits=2) => Number.isFinite(value) ? value.toLocaleString('ko-KR', {minimumFractionDigits:digits, maximumFractionDigits:digits}) : '—';
const dateOK = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
const currencies = ['USDKRW','JPYKRW','AUDKRW','EURKRW'];
const marketNames = {rates:'금리', risk:'시장 위험', fx:'환율'};
const empty = label => `<div class="info-empty">${label}</div>`;
const optionalNumber = (value, label, min=-Infinity) => { if (value != null && (!Number.isFinite(value) || value < min)) throw Error(`${label} 값을 확인하십시오.`); return value ?? null; };
function textValue(value, label, maximum=160) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw Error(`${label}를 확인하십시오.`);
  return value;
}
function checkDate(value, label, cutoff, nullable=false) {
  if (nullable && value == null) return null;
  if (!dateOK(value) || (cutoff && value > cutoff)) throw Error(`${label}를 확인하십시오.`);
  return value;
}

export function normalizeDataInfo(raw) {
  if (!raw || raw.kind !== 'bje_data_info' || raw.schemaVersion !== 1 || !raw.meta || !raw.market) throw Error('시장자료 형식(bje_data_info v1)을 확인하십시오.');
  const asOf = checkDate(raw.meta.asOf,'시장자료 기준일');
  const meta = {
    ...raw.meta,
    source:textValue(raw.meta.source,'자료 출처'),
    asOf,
    latestObservation:checkDate(raw.meta.latestObservation,'최근 관측일',asOf),
  };
  if (typeof meta.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(meta.sha256)) throw Error('시장자료 원본 해시를 확인하십시오.');
  if (!meta.units || meta.units.hedge !== 'source_value') throw Error('시장자료 프리미엄의 원자료 단위를 확인하십시오.');
  const seen = new Set();
  const market = {};
  for (const category of Object.keys(marketNames)) {
    if (!Array.isArray(raw.market[category]) || raw.market[category].length > 80) throw Error(`${marketNames[category]} 배열을 확인하십시오.`);
    market[category] = raw.market[category].map(metric => {
      if (!metric || typeof metric !== 'object') throw Error('시장 지표를 확인하십시오.');
      const id = textValue(metric.id,'지표 ID',80);
      if (seen.has(id)) throw Error('시장 지표 ID가 중복되었습니다.');
      seen.add(id);
      const value = optionalNumber(metric.value,'현재값');
      const previous = optionalNumber(metric.previous,'직전값');
      const change = optionalNumber(metric.change,'변화량');
      const currentDate = checkDate(metric.asOf,'지표 기준일',meta.latestObservation,true);
      const previousDate = checkDate(metric.previousDate,'직전 관측일',currentDate || meta.latestObservation,true);
      if ((value == null) !== (currentDate == null) || (previous == null) !== (previousDate == null) || (previousDate && previousDate >= currentDate)) throw Error('시장 지표의 값과 관측일이 일치하지 않습니다.');
      if (value == null || previous == null) {
        if (change != null) throw Error('비교 관측값이 없는 변화량입니다.');
      } else if (change == null || Math.abs(value - previous - change) > 1e-8 * Math.max(1, Math.abs(value), Math.abs(previous))) throw Error('시장 지표의 변화량이 일치하지 않습니다.');
      return {id,label:textValue(metric.label,'지표명',80),value,previous,change,asOf:currentDate,previousDate,unit:textValue(metric.unit,'지표 단위',30),source:textValue(metric.source,'지표 출처')};
    });
  }
  let bond = null;
  const emptyBond=raw.bond != null && raw.bond.asOf == null;
  if(emptyBond && (!Array.isArray(raw.bond.monthly) || raw.bond.monthly.length || raw.bond.observations !== 0 || ['index','duration','convexity','totalReturnYtd','totalReturn1y','annualMean','annualVol','annualGeometricReturn','maxDrawdown','periodStart','periodEnd'].some(key=>raw.bond[key]!=null))) throw Error('채권지수 미연결 상태를 확인하십시오.');
  if (raw.bond != null && !emptyBond) {
    const source = raw.bond;
    bond = {name:textValue(source.name,'채권지수명'),source:textValue(source.source,'채권지수 출처'),asOf:checkDate(source.asOf,'채권지수 기준일',meta.latestObservation)};
    for (const key of ['index','duration','convexity','totalReturnYtd','totalReturn1y','annualMean','annualVol','annualGeometricReturn','maxDrawdown']) bond[key] = optionalNumber(source[key],`채권지수 ${key}`, ['index','duration','annualVol'].includes(key) ? 0 : -Infinity);
    if (bond.index === 0 || (bond.maxDrawdown != null && bond.maxDrawdown > 0)) throw Error('채권지수·최대낙폭 값을 확인하십시오.');
    if (!Array.isArray(source.monthly) || source.monthly.length > 61) throw Error('채권지수 월말 관측값을 확인하십시오.');
    bond.monthly = source.monthly.map((row,index) => {
      if (!row || !Number.isFinite(row.index) || row.index <= 0) throw Error('채권지수 월말 관측값을 확인하십시오.');
      const date = checkDate(row.date,'채권지수 월말 관측일',bond.asOf);
      if (date.slice(0,7) >= asOf.slice(0,7) || (index && date.slice(0,7) <= source.monthly[index-1].date.slice(0,7))) throw Error('채권지수 월별 날짜 순서를 확인하십시오.');
      const observed=new Date(date),monthEnd=new Date(Date.UTC(observed.getUTCFullYear(),observed.getUTCMonth()+1,0));
      if((monthEnd-observed)/86400000>7)throw Error('채권지수 월말 관측값의 시차를 확인하십시오.');
      if (index) {
        const previousMonth = new Date(source.monthly[index-1].date);
        const currentMonth = new Date(date);
        if ((currentMonth.getUTCFullYear()-previousMonth.getUTCFullYear())*12+currentMonth.getUTCMonth()-previousMonth.getUTCMonth() !== 1) throw Error('채권지수 월별 관측값이 누락되었습니다.');
      }
      return {date,index:row.index};
    });
    bond.periodStart = checkDate(source.periodStart,'채권지수 기간 시작일',bond.asOf,true);
    bond.periodEnd = checkDate(source.periodEnd,'채권지수 기간 종료일',bond.asOf,true);
    bond.observations = source.observations;
    if (!Number.isInteger(bond.observations) || bond.observations < 0 || bond.observations !== Math.max(0,bond.monthly.length-1)) throw Error('채권지수 월별 수익률 관측수를 확인하십시오.');
    if (bond.monthly.length) {
      if (bond.periodStart !== bond.monthly[0].date || bond.periodEnd !== bond.monthly.at(-1).date) throw Error('채권지수 산출 기간이 일치하지 않습니다.');
    } else if (bond.periodStart != null || bond.periodEnd != null || ['annualMean','annualVol','annualGeometricReturn','maxDrawdown'].some(key => bond[key] != null)) throw Error('채권지수 산출 기간과 통계를 확인하십시오.');
  }
  const fxHedge = normalizeFxHedge(raw.fxHedge);
  if (fxHedge.unit !== 'source_value') throw Error('시장자료 프리미엄의 원자료 단위를 확인하십시오.');
  for (const pair of fxHedge.pairs) {
    checkDate(pair.asOf,'프리미엄 관측일',meta.latestObservation);
    checkDate(pair.volAsOf,'환 변동성 관측일',meta.latestObservation);
  }
  let fxAnalytics=null,fxModel=null;
  if(raw.fxAnalytics!=null){
    const hedge=normalizeHedgeAnalytics(raw.fxAnalytics),fx=normalizeFxAnalyticsSpots(raw.fxAnalytics);
    if(hedge.asOf!==asOf)throw Error('Hedge·FX 분석자료 기준일이 일치하지 않습니다.');
    fxAnalytics={...hedge,spots:fx.spots};
    for(const pair of hedge.ratePairs)for(const row of pair.history)if(row.date>meta.latestObservation)throw Error('금리차 비교의 관측일을 확인하십시오.');
    for(const spot of fx.spots)for(const row of spot.history)if(row.date>meta.latestObservation)throw Error('FX 모니터링의 관측일을 확인하십시오.');
  }
  if(raw.fxModel!=null){
    fxModel=normalizeFxModel(raw.fxModel);
    if(fxModel.meta.asOf>meta.latestObservation)throw Error('FX 모형의 기준일을 확인하십시오.');
    const modelHash=raw.fxModel.meta.provenance?.primary?.sha256;
    if(modelHash!=null&&modelHash!==meta.sha256)throw Error('FX 모형과 시장자료의 원본 해시가 일치하지 않습니다.');
    const usd=new Map((fxAnalytics?.spots.find(s=>s.id==='usdkrw')?.history??[]).map(r=>[r.date,r.value]));
    for(const row of fxModel.history)if(usd.size&&(!usd.has(row.date)||Math.abs(usd.get(row.date)-row.spot)>1e-8))throw Error('FX 모형과 모니터링의 원/달러 관측값이 일치하지 않습니다.');
  }
  return {kind:'bje_data_info',schemaVersion:1,meta,market,bond,fxHedge,fxAnalytics,fxModel};
}

export function renderMarketMarkup(snapshot) {
  if (!snapshot) return empty('시장자료 미연결');
  return Object.entries(marketNames).map(([key,title]) => `<section class="info-market-section"><div class="section-heading"><h2>${title}</h2></div><div class="info-metric-grid">${snapshot.market[key].length ? snapshot.market[key].map(metric => {
    const deltaUnit = metric.unit === '%' ? '%p' : metric.unit;
    const delta = metric.change == null ? '—' : `${metric.change > 0 ? '+' : ''}${fmt(metric.change)} ${esc(deltaUnit)}`;
    return `<article class="info-metric"><span>${esc(metric.label)}</span><strong>${fmt(metric.value)}<small>${esc(metric.unit)}</small></strong><div class="info-change ${metric.change < 0 ? 'is-negative' : metric.change > 0 ? 'is-positive' : ''}">${delta}<small>${metric.previousDate ? `${esc(metric.previousDate)} 대비` : '비교값 없음'}</small></div><div class="info-meta">${esc(metric.asOf || '관측값 없음')}<br>${esc(metric.source)}</div></article>`;
  }).join('') : empty('관측값 없음')}</div></section>`).join('');
}

export function renderBondMarkup(bond) {
  if (!bond) return empty('KIS 종합채권 자료 미연결');
  const stats = [
    ['총수익지수',bond.index,''],['듀레이션',bond.duration,'년'],['컨벡시티',bond.convexity,''],
    ['연초 이후',bond.totalReturnYtd,'%'],['최근 1년',bond.totalReturn1y,'%'],
    ['연율 산술평균',bond.annualMean,'%'],['연율 변동성',bond.annualVol,'%'],
    ['연율 기하평균',bond.annualGeometricReturn,'%'],['최대낙폭 · 월말',bond.maxDrawdown,'%'],
  ];
  const monthly = bond.monthly;
  let chart = empty('월말 시계열 없음');
  if (monthly.length > 1) {
    const values = monthly.map(row => row.index / monthly[0].index * 100);
    const W=1000,H=290,L=65,R=35,T=25,B=42;
    const lo=Math.min(...values),hi=Math.max(...values),span=hi-lo||1,min=lo-span*.13,max=hi+span*.13;
    const x=i=>L+i/(monthly.length-1)*(W-L-R),y=v=>H-B-(v-min)/(max-min)*(H-T-B);
    let svg='';
    for(let i=0;i<=4;i++) {const value=min+(max-min)*i/4;svg+=`<line x1="${L}" x2="${W-R}" y1="${y(value)}" y2="${y(value)}" stroke="#2a3a2f"/><text x="${L-10}" y="${y(value)+5}" text-anchor="end" font-size="15">${fmt(value,1)}</text>`;}
    for(let i=0;i<=4;i++) {const j=Math.round((monthly.length-1)*i/4);svg+=`<text x="${x(j)}" y="${H-10}" text-anchor="middle" font-size="15">${esc(monthly[j].date.slice(0,7))}</text>`;}
    const points=values.map((v,i)=>`${i?'L':'M'}${x(i)},${y(v)}`).join(' ');
    svg+=`<path d="${points} L${x(values.length-1)},${H-B} L${L},${H-B} Z" fill="#d7bb86" fill-opacity=".06"/><path d="${points}" fill="none" stroke="#d7bb86" stroke-width="2.5"/>`;
    chart=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(bond.name)} 월말 총수익지수, 시작값 100">${svg}</svg>`;
  }
  return `<article class="panel info-bond-panel"><div class="panel-heading"><h2>${esc(bond.name)} <span class="pill">과거 실적</span></h2><span class="small">${esc(bond.asOf)} · ${esc(bond.source)}</span></div><div class="info-bond-grid">${stats.map(([label,value,unit])=>`<div class="info-bond-metric"><span>${label}</span><strong>${fmt(value)}<small>${unit}</small></strong></div>`).join('')}</div><div class="info-bond-chart chart-wrap">${chart}</div><div class="info-chart-meta"><span>${esc(bond.periodStart || '—')} ~ ${esc(bond.periodEnd || '—')} · ${bond.observations}개월 수익률</span><span>월말 · 시작값 100</span></div></article>`;
}

export function buildHistogram(history, current=null, years='5', asOf=history.at(-1)?.date) {
  if (!dateOK(asOf)) return {rows:[],bins:[],current,min:0,max:1};
  let cutoff = '0000-01-01';
  if (years !== 'all') {
    if (!['1','3','5'].includes(String(years))) throw Error('분포 조회 기간을 확인하십시오.');
    const date = new Date(asOf);date.setUTCFullYear(date.getUTCFullYear()-Number(years));cutoff=date.toISOString().slice(0,10);
  }
  const rows=history.filter(row=>row.date>=cutoff&&row.date<=asOf);
  if(!rows.length)return {rows,bins:[],current,min:0,max:1};
  const values=rows.map(row=>row.value),bound=Number.isFinite(current)?[...values,current]:values;
  let min=Math.min(...bound),max=Math.max(...bound);
  if(max-min<1e-10) { const pad=Math.max(.05,Math.abs(min)*.05);min-=pad;max+=pad; }
  else {const pad=(max-min)*.06;min-=pad;max+=pad;}
  const count=Math.min(24,Math.max(6,Math.ceil(Math.sqrt(values.length))));
  const width=(max-min)/count,bins=Array.from({length:count},(_,i)=>({lower:min+i*width,upper:min+(i+1)*width,count:0}));
  for(const value of values)bins[Math.max(0,Math.min(count-1,Math.floor((value-min)/width)))].count++;
  const percentile=Number.isFinite(current)?100*values.filter(v=>v<=current).length/values.length:null;
  return {rows,bins,current,min,max,percentile};
}

export function renderHistogramMarkup(snapshot, years='5') {
  return currencies.map(currency=> {
    const pair=snapshot?.pairs.find(row=>row.currency===currency);
    const tenors=pair?[pair.hedge3m,pair.hedge6m,pair.hedge12m]:[];
    const current=tenors.length===3&&tenors.every(Number.isFinite)?tenors.reduce((sum,value)=>sum+value/3,0):null;
    const result=buildHistogram(pair?.history??[],current,years,pair?.asOf);
    const suffix=snapshot?.unit==='source_value'?'':'%';
    let chart=empty('과거 관측값 없음');
    if(result.bins.length) {
      const W=520,H=245,L=45,R=20,T=32,B=42;
      const x=v=>L+(v-result.min)/(result.max-result.min)*(W-L-R);
      const peak=Math.max(...result.bins.map(bin=>bin.count));
      const y=v=>H-B-v/peak*(H-T-B);
      let svg='';
      for(let i=0;i<=3;i++) { const count=peak*i/3;svg+=`<line x1="${L}" x2="${W-R}" y1="${y(count)}" y2="${y(count)}" stroke="#2b3b30"/><text x="${L-8}" y="${y(count)+4}" text-anchor="end" font-size="13">${fmt(count,0)}</text>`; }
      svg+=result.bins.map(bin=>`<rect x="${x(bin.lower)+1}" y="${y(bin.count)}" width="${Math.max(0,x(bin.upper)-x(bin.lower)-2)}" height="${H-B-y(bin.count)}" fill="#7fa69b" opacity=".85"><title>${fmt(bin.lower)} ~ ${fmt(bin.upper)}${suffix}: ${bin.count}일</title></rect>`).join('');
      for(let i=0;i<=4;i++) { const value=result.min+(result.max-result.min)*i/4;svg+=`<text x="${x(value)}" y="${H-13}" text-anchor="middle" font-size="13">${fmt(value,1)}</text>`; }
      if(Number.isFinite(current))svg+=`<line x1="${x(current)}" x2="${x(current)}" y1="${T-5}" y2="${H-B}" stroke="#e8c78c" stroke-width="2" stroke-dasharray="5 3"/><circle cx="${x(current)}" cy="${T-5}" r="4" fill="#e8c78c"/>`;
      svg+=`<text x="${L}" y="17" font-size="13">관측일 수</text>`;
      chart=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${currency} 3만기 평균 프리미엄 분포">${svg}</svg>`;
    }
    return `<article class="panel info-histogram"><div class="panel-heading"><h3>${currency}</h3><span class="info-current">최근 ${fmt(current)}${suffix}</span></div><div class="chart-wrap">${chart}</div><div class="info-chart-meta"><span>${result.rows.length?`${esc(result.rows[0].date)} ~ ${esc(result.rows.at(-1).date)}`:'관측기간 없음'} · ${result.rows.length.toLocaleString('ko-KR')}일</span><span>이하 비율 ${fmt(result.percentile)}%</span></div><div class="info-meta">${esc(pair?.source||'자료 미연결')} · 최근 ${esc(pair?.asOf||'—')}</div></article>`;
  }).join('');
}

export function initDataInfoUI({document:doc=globalThis.document,onHedge=()=>{},onAnalytics=()=>{},onModel=()=>{}}={}) {
  const $=id=>doc.getElementById(id);
  let snapshot=null,hedge=normalizeFxHedge(null),years='5';
  function renderHedge(next) {
    hedge=next;
    $('hedgeUnit').textContent=next.unit==='source_value'?'프리미엄 · 원자료 단위':'연 % · + 수취 / − 지급';
    $('hedgeHistoryUnit').textContent=next.unit==='source_value'?'3M·6M·12M 평균 · 원자료 단위':'3M·6M·12M 평균 · 연 %';
    $('hedgeHistograms').innerHTML=renderHistogramMarkup(next,years);
  }
  function apply(raw) {
    const next=normalizeDataInfo(raw);
    const marketMarkup=renderMarketMarkup(next),bondMarkup=renderBondMarkup(next.bond);
    // Validate and render all fragments before replacing the prior loaded snapshot.
    renderHistogramMarkup(next.fxHedge,years);
    snapshot=next;
    $('dataInfoSource').textContent=`${next.meta.source} · 기준 ${next.meta.asOf} · 최근 ${next.meta.latestObservation}`;
    $('marketSnapshot').innerHTML=marketMarkup;
    $('bondReference').innerHTML=bondMarkup;
    onHedge(next.fxHedge);
    renderHedge(next.fxHedge);
    onAnalytics(next.fxAnalytics);
    onModel(next.fxModel);
    $('dataInfoError').hidden=true;
    return next;
  }
  $('dataInfoImportFile').onchange=async event=>{
    const file=event.target.files[0];if(!file)return;
    try {
      if(file.size>10e6)throw Error('시장자료 JSON은 10MB 이하여야 합니다.');
      apply(JSON.parse(await file.text()));
    } catch(error) {
      $('dataInfoError').textContent=`시장자료 불러오기 오류 · ${error.message}`;
      $('dataInfoError').hidden=false;
    } finally {event.target.value='';}
  };
  $('hedgeHistoryPeriod').onchange=()=>{
    const next=$('hedgeHistoryPeriod').value;
    if(!['1','3','5','all'].includes(next))return;
    years=next;renderHedge(hedge);
  };
  $('marketSnapshot').innerHTML=renderMarketMarkup(null);
  $('bondReference').innerHTML=renderBondMarkup(null);
  renderHedge(hedge);
  return {apply,renderHedge,getSnapshot:()=>snapshot};
}
