import { mountFxModel } from './fx-model-ui.mjs';

const SPOTS = Object.freeze([
  {id:'usdkrw',label:'USD/KRW',unit:'원/달러',color:'#69b3ed'},
  {id:'jpykrw',label:'JPY/KRW',unit:'원/100엔',color:'#d5afcb'},
  {id:'eurkrw',label:'EUR/KRW',unit:'원/유로',color:'#b9c88b'},
  {id:'audkrw',label:'AUD/KRW',unit:'원/호주달러',color:'#cfa775'},
  {id:'dxy',label:'DXY',unit:'지수',color:'#b1b8cb'}
]);
const DAY = 86400000;
const stamp = value => Date.parse(`${value}T00:00:00Z`);
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = (value,digits=2) => Number.isFinite(value) ? value.toLocaleString('ko-KR',{minimumFractionDigits:digits,maximumFractionDigits:digits}) : '—';
const fail = field => {throw Error(`FX ${field} 형식을 확인하십시오.`);};
function text(value,field,fallback='') {if(value==null)return fallback;if(typeof value!=='string'||value.length>500)fail(field);return value;}
function date(value,field) {if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(stamp(value))||new Date(stamp(value)).toISOString().slice(0,10)!==value)fail(field);return value;}
function freeze(value) {if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
function yearStart(end,years) {const d=new Date(stamp(end));d.setUTCFullYear(d.getUTCFullYear()-years);return d.valueOf();}
function validYears(years) {return [0,1,3,5].includes(Number(years))?Number(years):3;}

/** Copy and validate the spot subset before the active snapshot is changed. */
export function normalizeFxAnalyticsSpots(raw) {
  if(!raw||raw.schemaVersion!==1||!Array.isArray(raw.spots)||raw.spots.length>5)fail('스냅샷 버전·통화 목록');
  const asOf=date(raw.asOf,'기준일'),seen=new Set();
  const spots=raw.spots.map(item=>{
    const spec=SPOTS.find(s=>s.id===item?.id);
    if(!spec||seen.has(spec.id))fail('통화 코드');seen.add(spec.id);
    if(!Array.isArray(item.history)||!item.history.length||item.history.length>30000)fail(`${spec.label} 표본`);
    const history=item.history.map((row,i)=>{
      const d=date(row?.date,`${spec.label} 관측일`);
      if(d>asOf||(i&&d<=item.history[i-1].date))fail(`${spec.label} 날짜 순서`);
      if(typeof row.value!=='number'||!Number.isFinite(row.value)||row.value<1e-8||row.value>1e8)fail(`${spec.label} 환율`);
      return {date:d,value:row.value};
    });
    return {id:spec.id,label:text(item.label,'통화 이름',spec.label),unit:text(item.unit,'단위',spec.unit),source:text(item.source,'출처',text(raw.source,'출처','data_info')),history};
  });
  return freeze({schemaVersion:1,asOf,source:text(raw.source,'출처','data_info'),spots});
}

export function selectFxSpotWindow(spot,years=3) {
  if(!spot?.history?.length)return [];
  const period=validYears(years),cutoff=period?yearStart(spot.history.at(-1).date,period):-Infinity;
  return spot.history.filter(row=>stamp(row.date)>=cutoff);
}

/** Annualized sample deviation, restricted to consecutive weekday quotes. */
export function fxSpotStatistics(spot,years=3) {
  const history=spot.history,last=history.at(-1),selected=selectFxSpotWindow(spot,years),first=selected[0];
  const cutoff=yearStart(last.date,1),end=stamp(last.date),returns=[];
  let expected=0;
  for(let t=cutoff+DAY;t<=end;t+=DAY){const w=new Date(t).getUTCDay();if(w!==0&&w!==6)expected++;}
  const weekdays=history.filter(row=>{const day=new Date(stamp(row.date)).getUTCDay();return day!==0&&day!==6;});
  for(let i=1;i<weekdays.length;i++){
    const prev=weekdays[i-1],row=weekdays[i],t=stamp(row.date),gap=(t-stamp(prev.date))/DAY;
    if(t<=cutoff)continue;
    const day=new Date(t).getUTCDay();
    if(gap===1||(gap===3&&day===1))returns.push(Math.log(row.value/prev.value));
  }
  const coverage=expected?returns.length/expected:0,coveredYear=stamp(history[0].date)<=cutoff+7*DAY;
  let volatility=null;
  if(coveredYear&&coverage>=.8&&returns.length>=2){
    const mean=returns.reduce((s,r)=>s+r,0)/returns.length;
    volatility=Math.sqrt(returns.reduce((s,r)=>s+(r-mean)**2,0)/(returns.length-1)*252)*100;
  }
  return {latest:last.value,date:last.date,firstDate:first.date,changePct:(last.value/first.value-1)*100,observations:selected.length,volatility,volatilityObservations:returns.length,volatilityCoverage:coverage,volatilityStart:new Date(cutoff).toISOString().slice(0,10),volatilityEnd:last.date};
}

function chartRows(rows,max=1500) {
  if(rows.length<=max)return rows;
  const selected=[rows[0]],step=(rows.length-2)/(max/2-1);
  for(let start=1;start<rows.length-1;start+=step){
    const bucket=rows.slice(Math.floor(start),Math.min(rows.length-1,Math.floor(start+step)));
    if(!bucket.length)continue;
    const min=bucket.reduce((a,b)=>a.value<b.value?a:b),maxRow=bucket.reduce((a,b)=>a.value>b.value?a:b);
    selected.push(...(min===maxRow?[min]:[min,maxRow].sort((a,b)=>a.date.localeCompare(b.date))));
  }
  selected.push(rows.at(-1));return selected;
}
function bounds(rows){let lo=Infinity,hi=-Infinity;for(const row of rows){lo=Math.min(lo,row.value);hi=Math.max(hi,row.value);}const gap=Math.max(hi-lo,Math.abs(lo)*.015,1e-8);return [Math.max(0,lo-gap*.1),hi+gap*.1];}
export function renderFxSpotChart(spot,years=3,width=1040) {
  const rows=selectFxSpotWindow(spot,years);if(!rows.length)return '<div class="empty-chart">환율 데이터 없음</div>';
  const spec=SPOTS.find(s=>s.id===spot.id),W=Math.max(360,Math.min(1800,Number.isFinite(width)?width:1040)),H=W<650?320:405,pad={l:65,r:25,t:22,b:45};
  const [lo,hi]=bounds(rows),t0=stamp(rows[0].date),t1=Math.max(t0+DAY,stamp(rows.at(-1).date));
  const x=t=>pad.l+(t-t0)/(t1-t0)*(W-pad.l-pad.r),y=v=>H-pad.b-(v-lo)/(hi-lo)*(H-pad.t-pad.b);
  let svg=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="fxSpotChartTitle"><title id="fxSpotChartTitle">${esc(spot.label)} · ${esc(spot.unit)} · ${rows[0].date} ~ ${rows.at(-1).date}</title>`;
  for(let i=0;i<=5;i++){const v=lo+(hi-lo)*i/5;svg+=`<line x1="${pad.l}" x2="${W-pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="#2c3934"/><text x="${pad.l-10}" y="${y(v)+4}" text-anchor="end">${fmt(v,spot.id==='dxy'?2:0)}</text>`;}
  const ticks=W<650?3:6;
  for(let i=0;i<=ticks;i++){const t=t0+(t1-t0)*i/ticks;svg+=`<text x="${x(t)}" y="${H-15}" text-anchor="${i===0?'start':i===ticks?'end':'middle'}">${new Date(t).toISOString().slice(0,10).replaceAll('-','.')}</text>`;}
  const visible=chartRows(rows),path=visible.map((r,i)=>`${i?'L':'M'}${x(stamp(r.date)).toFixed(2)},${y(r.value).toFixed(2)}`).join(' ');
  const last=rows.at(-1);svg+=`<path d="${path}" fill="none" stroke="${spec.color}" stroke-width="2" stroke-linejoin="round"/><circle cx="${x(stamp(last.date))}" cy="${y(last.value)}" r="3" fill="${spec.color}"/></svg>`;
  return svg;
}
function sparkline(spot,years) {
  const rows=selectFxSpotWindow(spot,years),sample=chartRows(rows,120),[lo,hi]=bounds(rows),first=stamp(rows[0].date),span=Math.max(DAY,stamp(rows.at(-1).date)-first);
  const path=sample.map((r,i)=>`${i?'L':'M'}${(2+196*(stamp(r.date)-first)/span).toFixed(2)},${(40-36*(r.value-lo)/(hi-lo)).toFixed(2)}`).join(' ');
  return `<svg viewBox="0 0 200 44" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`;
}
function csvCell(value) {const text=String(value??'');return /[",\r\n]/.test(text)?`"${text.replaceAll('"','""')}"`:text;}
export function fxSpotCSV(snapshot,id='usdkrw',years=3) {
  const spot=snapshot?.spots.find(s=>s.id===id);if(!spot)return '';
  const rows=[['date','series','unit','value'],...selectFxSpotWindow(spot,years).map(r=>[r.date,spot.id,spot.unit,r.value])];
  return '\ufeff'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n');
}
function periodLabel(years){return years?`${years}Y`:'전체';}

export function mountFxWorkspace(documentRoot=document) {
  const host=documentRoot.getElementById('fxWorkspaceHost');if(!host)return null;
  const $=id=>documentRoot.getElementById(id);let analytics=null,selected='usdkrw',years=3,tab='monitor';
  host.innerHTML=`<div class="fx-workspace-tabs" role="tablist" aria-label="FX 모듈"><button id="fxMonitorTab" role="tab" aria-selected="true" aria-controls="fxMonitorPanel" tabindex="0">모니터링</button><button id="fxModelTab" role="tab" aria-selected="false" aria-controls="fxModelPanel" tabindex="-1">환율모형A</button></div><section id="fxMonitorPanel" role="tabpanel" aria-labelledby="fxMonitorTab"><div class="fx-spot-header"><h2>FX Monitor</h2><span id="fxSpotSource" class="small">데이터 미연결</span></div><div id="fxSpotCards" class="fx-spot-grid"></div><article class="panel fx-spot-panel"><div class="fx-spot-toolbar"><div class="fx-spot-selectors"><label>통화 <select id="fxSpotCurrency">${SPOTS.map(s=>`<option value="${s.id}">${s.label}</option>`).join('')}</select></label><label>기간 <select id="fxSpotYears"><option value="1">1년</option><option value="3" selected>3년</option><option value="5">5년</option><option value="0">전체</option></select></label></div><button id="fxSpotCSV" class="button secondary" disabled>CSV</button></div><div class="fx-spot-chart-heading"><h3 id="fxSpotChartHeading">USD/KRW</h3><span id="fxSpotChartUnit" class="small">원/달러</span></div><div id="fxSpotChart" class="chart-wrap fx-spot-chart"><div class="empty-chart">환율 데이터 미연결</div></div><div class="fx-spot-meta"><span id="fxSpotPeriod"></span><span id="fxSpotCount"></span></div></article></section><section id="fxModelPanel" role="tabpanel" aria-labelledby="fxModelTab" hidden><div id="fxModelHost"></div></section>`;
  const modelViewer=mountFxModel(documentRoot);
  function render(){
    $('fxSpotSource').textContent=analytics?`${analytics.source} · ${analytics.asOf}`:'데이터 미연결';
    $('fxSpotCards').innerHTML=SPOTS.map(spec=>{
      const spot=analytics?.spots.find(s=>s.id===spec.id),stats=spot?fxSpotStatistics(spot,years):null;
      return `<button class="fx-spot-card${selected===spec.id?' selected':''}" type="button" id="fxSpotCard-${spec.id}" aria-pressed="${selected===spec.id}" style="--fx-spot-color:${spec.color}"><span class="fx-spot-card-title">${spec.label}<small>${esc(spot?.unit??spec.unit)}</small></span><strong class="fx-spot-value">${fmt(stats?.latest,spec.id==='dxy'?2:0)}</strong><span class="fx-spot-date">${stats?.date??'데이터 없음'}</span><span class="fx-spot-spark">${spot?sparkline(spot,years):''}</span><span class="fx-spot-stat"><span>등락률 (${periodLabel(years)})</span><b>${stats?.changePct>0?'+':''}${fmt(stats?.changePct)}%</b></span><span class="fx-spot-stat"><span>연속 평일 σ (1Y, %)</span><b>${fmt(stats?.volatility)}</b></span><span class="fx-spot-coverage">${stats?`n=${stats.volatilityObservations} · 평일 ${fmt(stats.volatilityCoverage*100,0)}%`:'—'}</span></button>`;
    }).join('');
    for(const spec of SPOTS)$(`fxSpotCard-${spec.id}`).onclick=()=>{selected=spec.id;$('fxSpotCurrency').value=selected;render();};
    const spot=analytics?.spots.find(s=>s.id===selected),spec=SPOTS.find(s=>s.id===selected);
    $('fxSpotChartHeading').textContent=spec.label;$('fxSpotChartUnit').textContent=spot?.unit??spec.unit;
    $('fxSpotChart').innerHTML=spot?renderFxSpotChart(spot,years,$('fxSpotChart').clientWidth||1040):'<div class="empty-chart">환율 데이터 없음</div>';
    $('fxSpotCSV').disabled=!spot;
    const rows=spot?selectFxSpotWindow(spot,years):[];
    $('fxSpotPeriod').textContent=rows.length?`${rows[0].date} ~ ${rows.at(-1).date}`:'';
    $('fxSpotCount').textContent=rows.length?`${fmt(rows.length,0)}개 관측`:'';
  }
  function selectTab(next){
    if(!['monitor','model'].includes(next))return;tab=next;
    for(const [key,button,panel] of [['monitor','fxMonitorTab','fxMonitorPanel'],['model','fxModelTab','fxModelPanel']]){const active=tab===key;$(button).setAttribute('aria-selected',String(active));$(button).setAttribute('tabindex',active?'0':'-1');$(panel).hidden=!active;}
    if(tab==='monitor')render();
  }
  $('fxMonitorTab').onclick=()=>selectTab('monitor');$('fxModelTab').onclick=()=>selectTab('model');
  for(const button of ['fxMonitorTab','fxModelTab'])$(button).onkeydown=event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?'monitor':event.key==='End'?'model':tab==='monitor'?'model':'monitor';selectTab(next);$(next==='monitor'?'fxMonitorTab':'fxModelTab').focus?.();};
  $('fxSpotCurrency').onchange=event=>{if(!SPOTS.some(s=>s.id===event.target.value))return;selected=event.target.value;render();};
  $('fxSpotYears').onchange=event=>{years=validYears(event.target.value);render();};
  $('fxSpotCSV').onclick=()=>{const csv=fxSpotCSV(analytics,selected,years);if(!csv)return;const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8;'})),link=documentRoot.createElement('a');link.href=url;link.download=`FX_${selected}_${analytics.asOf}_${periodLabel(years)}.csv`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  if(typeof ResizeObserver!=='undefined'){let previous=0;new ResizeObserver(entries=>{const width=entries[0].contentRect.width;if(width>0&&width!==previous){previous=width;render();}}).observe($('fxSpotChart'));}
  function installAnalytics(raw){const next=raw==null?null:normalizeFxAnalyticsSpots(raw);analytics=next;render();return analytics;}
  function installModel(raw){return raw==null?modelViewer.clear():modelViewer.install(raw);}
  function clear(){installAnalytics(null);installModel(null);}
  render();
  return {installAnalytics,installModel,clear,selectTab,getAnalytics:()=>analytics,getModelSnapshot:()=>modelViewer.getSnapshot()};
}
