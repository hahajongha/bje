const TENORS=['PR','3M','1Y','2Y','3Y'];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=v=>Number.isFinite(v)?v.toLocaleString('ko-KR',{minimumFractionDigits:2,maximumFractionDigits:2}):'—';
const dateOK=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
const mean=a=>a.reduce((s,v)=>s+v,0)/a.length;
export function normalizeHedgeAnalytics(raw){
  if(raw==null)return null;
  if(raw.schemaVersion!==1||!dateOK(raw.asOf)||raw.hedgeUnit!=='source_value'||!Array.isArray(raw.ratePairs)||raw.ratePairs.length>5||typeof raw.source!=='string')throw Error('Hedge·FX 분석자료 형식을 확인하십시오.');
  const seen=new Set();
  const ratePairs=raw.ratePairs.map(pair=>{
    if(!pair||!TENORS.includes(pair.tenor)||seen.has(pair.tenor)||!Array.isArray(pair.history)||pair.history.length>30000)throw Error('금리 만기·관측값을 확인하십시오.');
    seen.add(pair.tenor);
    for(const key of ['krSource','usSource'])if(typeof pair[key]!=='string'||pair[key].length>200)throw Error('금리 출처를 확인하십시오.');
    const history=pair.history.map((row,i)=>{
      if(!row||!dateOK(row.date)||row.date>raw.asOf||(i&&row.date<=pair.history[i-1].date)||['kr','us','hedge'].some(k=>!Number.isFinite(row[k])))throw Error('금리·프리미엄의 공통 관측일과 값을 확인하십시오.');
      return {date:row.date,kr:row.kr,us:row.us,hedge:row.hedge};
    });
    return {tenor:pair.tenor,krSource:pair.krSource,usSource:pair.usSource,history};
  });
  return {schemaVersion:1,asOf:raw.asOf,source:raw.source,hedgeUnit:'source_value',ratePairs};
}
export function correlation(x,y){
  if(x.length<2||x.length!==y.length)return null;
  const mx=mean(x),my=mean(y);let xx=0,yy=0,xy=0;
  x.forEach((v,i)=>{xx+=(v-mx)**2;yy+=(y[i]-my)**2;xy+=(v-mx)*(y[i]-my);});
  return xx>1e-20&&yy>1e-20?Math.max(-1,Math.min(1,xy/Math.sqrt(xx*yy))):null;
}
export function rateStatistics(history,annualPercent=false,start='',end='9999-12-31'){
  const rows=history.filter(r=>r.date>=start&&r.date<=end),latest=rows.at(-1);
  const spreads=rows.map(r=>r.kr-r.us),hedge=rows.map(r=>r.hedge);
  const result={rows,latest,n:rows.length,correlation:correlation(spreads,hedge),gap:null,rmse:null,z:null};
  if(!annualPercent||!rows.length)return result;
  const gaps=rows.map((r,i)=>r.hedge-spreads[i]),avg=mean(gaps);
  const sd=rows.length>1?Math.sqrt(gaps.reduce((s,v)=>s+(v-avg)**2,0)/(rows.length-1)):0;
  return {...result,gap:gaps.at(-1),rmse:Math.sqrt(mean(gaps.map(v=>v*v))),z:sd>1e-12?(gaps.at(-1)-avg)/sd:null};
}
function lineChart(rows,annualPercent,width=900){
  if(rows.length<2)return '<div class="info-empty">공통 관측값 부족</div>';
  const W=Math.max(400,Math.min(1400,width)),H=annualPercent?285:375,L=65,R=24,T=30,B=34;
  const from=Date.parse(rows[0].date),to=Date.parse(rows.at(-1).date);
  const x=d=>L+(Date.parse(d)-from)/(to-from)*(W-L-R);
  const spread=rows.map(r=>r.kr-r.us),premium=rows.map(r=>r.hedge);
  let svg='';
  function panel(series,top,bottom,label){
    const values=series.flatMap(s=>s.values),lo=Math.min(...values),hi=Math.max(...values),pad=Math.max((hi-lo)*.12,.05);
    const min=lo-pad,max=hi+pad,y=v=>bottom-(v-min)/(max-min)*(bottom-top);
    svg+=`<text x="${L}" y="${top-12}" font-size="13">${label}</text>`;
    for(let i=0;i<=3;i++){const v=min+(max-min)*i/3;svg+=`<line x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}" stroke="#344239"/><text x="${L-9}" y="${y(v)+4}" text-anchor="end" font-size="13">${fmt(v)}</text>`;}
    if(min<0&&max>0)svg+=`<line x1="${L}" x2="${W-R}" y1="${y(0)}" y2="${y(0)}" stroke="#819589" stroke-dasharray="3 4"/>`;
    for(const s of series)svg+=`<path d="${rows.map((r,i)=>`${i?'L':'M'}${x(r.date).toFixed(2)},${y(s.values[i]).toFixed(2)}`).join(' ')}" fill="none" stroke="${s.color}" stroke-width="1.8"/>`;
  }
  if(annualPercent)panel([{values:spread,color:'#80b6a5'},{values:premium,color:'#d7bb86'}],T,H-B,'금리차 %p · 프리미엄 연 % 가정');
  else{panel([{values:spread,color:'#80b6a5'}],T,160,'한국 − 미국 · %p');panel([{values:premium,color:'#d7bb86'}],220,H-B,'프리미엄 평균 · 원자료 단위');}
  const ticks=W<600?2:4;
  for(let i=0;i<=ticks;i++){const j=Math.round((rows.length-1)*i/ticks);svg+=`<text x="${x(rows[j].date)}" y="${H-9}" text-anchor="${i===0?'start':i===ticks?'end':'middle'}" font-size="13">${rows[j].date}</text>`;}
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="한국 미국 금리차와 USD 헤지 프리미엄 시계열">${svg}</svg>`;
}
export function renderRateCards(snapshot,annualPercent=false,start='',end='9999-12-31'){
  return TENORS.map(tenor=>{
    const pair=snapshot?.ratePairs.find(p=>p.tenor===tenor),s=rateStatistics(pair?.history??[],annualPercent,start,end),last=s.latest;
    const metrics=[['한국 (%)',last?.kr],['미국 (%)',last?.us],['금리차 (%p)',last?last.kr-last.us:null],[`헤지 평균 (${annualPercent?'연 % 가정':'원자료'})`,last?.hedge],['상관계수',s.correlation],['현재 괴리 (%p)',s.gap],['RMSE (%p)',s.rmse],['괴리 Z-score',s.z]];
    return `<article class="ha-card"><div class="ha-card-title"><h3>${tenor}</h3><span>${esc(last?.date??'자료 미연결')}</span></div><dl>${metrics.map(([label,value])=>`<div><dt>${label}</dt><dd>${fmt(value)}</dd></div>`).join('')}</dl><div class="ha-sources">${esc(pair?.krSource??'한국 자료 없음')}<br>${esc(pair?.usSource??'미국 자료 없음')}<br>DailyRate!HW/HX/HY · 3M·6M·12M</div><div class="ha-sample">공통 ${s.n.toLocaleString('ko-KR')}일${!annualPercent?' · 괴리 단위 미확정':''}</div></article>`;
  }).join('');
}
export function renderRateCharts(snapshot,annualPercent=false,start='',end='9999-12-31',width=900,lastWidth=width){
  return TENORS.map(tenor=>{
    const pair=snapshot?.ratePairs.find(p=>p.tenor===tenor),s=rateStatistics(pair?.history??[],annualPercent,start,end);
    return `<article class="panel ha-chart"><div class="panel-heading"><h3>${tenor} · 금리차 / 프리미엄</h3><span class="small">${s.n.toLocaleString('ko-KR')}일</span></div><div class="chart-wrap">${lineChart(s.rows,annualPercent,tenor==='3Y'?lastWidth:width)}</div><div class="ha-chart-key"><span>금리차</span><span>헤지 평균</span><small>${s.rows[0]?.date??'—'} ~ ${s.latest?.date??'—'}</small></div></article>`;
  }).join('');
}
export function hedgeAnalyticsCSV(snapshot,annualPercent=false,start='',end='9999-12-31'){
  const lines=['tenor,date,kr_percent,us_percent,kr_minus_us_pp,hedge_average,hedge_unit_assumption,gap_pp'];
  for(const pair of snapshot?.ratePairs??[])for(const r of rateStatistics(pair.history,annualPercent,start,end).rows)lines.push([pair.tenor,r.date,r.kr,r.us,r.kr-r.us,r.hedge,annualPercent?'annual_percent_assumed':'source_value',annualPercent?r.hedge-(r.kr-r.us):''].join(','));
  return '\ufeff'+lines.join('\r\n')+'\r\n';
}
export function mountHedgeAnalytics(doc=globalThis.document){
  const $=id=>doc.getElementById(id),host=$('hedgeAnalyticsHost');if(!host)return null;
  let snapshot=null,start='',end='9999-12-31',annualPercent=false;
  host.innerHTML='<div class="ha-toolbar"><div><h2>USD · 금리차 비교</h2><span class="small">CIP 대용지표 · 한국 − 미국</span></div><div class="ha-controls"><label>프리미엄 단위<select id="haUnit"><option value="source_value">원자료</option><option value="annual_percent">연율 % 가정</option></select></label><label>조회 기간<select id="haPeriod"><option value="1">1Y</option><option value="3">3Y</option><option value="5" selected>5Y</option><option value="all">전체</option></select></label><label>시작일<input id="haStart" type="date"></label><button id="haCSV" class="button secondary" disabled>CSV</button></div></div><div id="haError" class="fx-model-error" role="alert" hidden></div><div id="haCards" class="ha-cards"></div><div id="haCharts" class="ha-charts"></div>';
  function render(){
    $('haCards').innerHTML=renderRateCards(snapshot,annualPercent,start,end);
    const columns=typeof matchMedia==='function'&&matchMedia('(max-width:1050px)').matches?1:2;
    $('haCharts').innerHTML=renderRateCharts(snapshot,annualPercent,start,end,Math.max(400,(host.clientWidth||1600)/columns-50),Math.max(400,(host.clientWidth||1600)-50));
    $('haCSV').disabled=!snapshot?.ratePairs.some(p=>rateStatistics(p.history,annualPercent,start,end).n);
  }
  function period(){
    const years=$('haPeriod').value||'5';end=snapshot?.asOf??'9999-12-31';start='';
    if(years!=='all'&&snapshot){const d=new Date(end);d.setUTCFullYear(d.getUTCFullYear()-Number(years));start=d.toISOString().slice(0,10);}
    $('haStart').value=start;render();
  }
  function install(raw){const next=normalizeHedgeAnalytics(raw);snapshot=next;annualPercent=false;$('haUnit').value='source_value';$('haError').hidden=true;period();return next;}
  $('haUnit').onchange=()=>{annualPercent=$('haUnit').value==='annual_percent';render();};
  $('haPeriod').onchange=period;
  $('haStart').onchange=()=>{const value=$('haStart').value;if(value&&(!dateOK(value)||value>end)){$('haError').textContent='시작일을 자료 기준일 이전으로 지정하십시오.';$('haError').hidden=false;return;}start=value;$('haError').hidden=true;render();};
  $('haCSV').onclick=()=>{if(!snapshot)return;const url=URL.createObjectURL(new Blob([hedgeAnalyticsCSV(snapshot,annualPercent,start,end)],{type:'text/csv;charset=utf-8;'})),a=doc.createElement('a');a.href=url;a.download=`BJE_USD_Hedge_${snapshot.asOf}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  if(typeof ResizeObserver!=='undefined'){let width=0;new ResizeObserver(entries=>{const next=entries[0].contentRect.width;if(next>0&&next!==width){width=next;render();}}).observe(host);}
  render();return {install,getSnapshot:()=>snapshot};
}
