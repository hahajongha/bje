import { covariance, stats, optimize, validateInputs } from './portfolio.mjs';
import { demoData } from './demo-data.mjs';
import { normalizeFxHedge, renderHedgeMarkup } from './fx-hedge.mjs';
import { renderRiskMarkup } from './risk.mjs';
import { defaultPolicy, validatePolicy, satisfiesPolicy, optimizeAllocation, samplePortfolios } from './allocation.mjs';
import { frontierTarget } from './frontier-target.mjs';
import { initDataInfoUI } from './data-info-ui.mjs';
import { mountHedgeAnalytics } from './hedge-analytics.mjs';
import { mountFxWorkspace } from './fx-workspace.mjs';

const $ = id => document.getElementById(id);
const colors = ['#bddb9c','#80b6a5','#d7bb86','#87a6c0','#b5a5c7','#b68e81','#7ec9cf'];
const names = { current:'현재 비중', minVol:'최소 변동성', target:'목표수익률', maxSharpe:'최대 Sharpe' };
const selectionNames = {...names,taa1:'비중1',taa2:'비중2',explored:'탐색 조합',asset:'개별 자산'};
const groupNames = {bond:'채권',equity:'주식',alternative:'대체투자'};
const zValues = {'.68':0.994457883,'.9':1.644853627,'.95':1.959963985,'.99':2.575829304};
const fmt = (x,n=2) => Number.isFinite(x) ? x.toLocaleString('ko-KR',{minimumFractionDigits:n,maximumFractionDigits:n}) : '—';
const esc = x => String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let data, initial, state, results, cov, chosen='current', period=60, toastTimer, cacheKey, fxSnapshot=normalizeFxHedge(null), cloud=[], exploredIndex=0, selectedAssetIndex=null, frontierMode='same-risk', frontierComparison=null, frontierAxes={};
const hedgeAnalytics=mountHedgeAnalytics(document),fxWorkspace=mountFxWorkspace(document);
const dataInfoUI=initDataInfoUI({document,onHedge:next=>{fxSnapshot=next;renderHedge();},onAnalytics:next=>{hedgeAnalytics?.install(next);fxWorkspace?.installAnalytics(next);},onModel:(next,options)=>fxWorkspace?.installModel(next,options)});

function normalizeData(raw) {
  if(!raw || !Array.isArray(raw.assets) || raw.assets.length<2 || raw.assets.length>8) throw Error('자산 수는 2~8개여야 합니다.');
  const assets = raw.assets.map((a,i)=>({ ...a, id:String(a.id||i), name:String(a.name||a.id||i), mu:a.mu ?? a.annualMean*100, vol:a.vol ?? a.annualVol*100, weight:a.weight ?? a.currentWeight, group:a.group??({kr_bond:'bond',us_treasury:'bond',us_credit:'bond',usd_bills:'bond',kr_equity:'equity',us_equity:'equity'})[a.id]??null, color:colors[i%colors.length] }));
  validateInputs(assets,raw.correlation);
  const initialCov=covariance(assets,raw.correlation);
  stats(assets.map(a=>a.weight),assets,initialCov,2.5);
  optimize(assets,initialCov,2.5,6);
  const meta={...(raw.meta||{})};
  meta.sampleStart=meta.sampleStart||meta.periodStart;meta.sampleEnd=meta.sampleEnd||meta.periodEnd;
  const monthly=raw.monthly?{...raw.monthly,dates:raw.monthly.baseDates||raw.monthly.dates}:null;
  if(monthly) {
    if(!Array.isArray(monthly.dates)||!Array.isArray(monthly.base100)||monthly.base100.length!==monthly.dates.length||monthly.dates.length<2||monthly.dates.length>1200) throw Error('월별 날짜와 지수 행 개수를 확인하십시오.');
    if(monthly.dates.some((d,i)=>!/^\d{4}-\d{2}(?:-\d{2})?$/.test(d)||(i>0&&d<=monthly.dates[i-1]))) throw Error('월별 날짜는 중복 없이 오름차순이어야 합니다.');
    if(monthly.base100.some(r=>!Array.isArray(r)||r.length!==assets.length||r.some(v=>!Number.isFinite(v)||v<=0))) throw Error('총수익지수는 양의 유한수여야 합니다.');
  }
  normalizeFxHedge(raw.fxHedge);
  return {...raw,assets,meta,monthly};
}
function clone(x){return JSON.parse(JSON.stringify(x));}
function message(text,error=false){if(error){$('alert').textContent=text;$('alert').hidden=false;}else{$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,3200);}}
function clearError(){$('alert').hidden=true;}
function numberInput(el,name){if(el.value.trim()==='')throw Error(`${name}을 입력하십시오.`);const v=Number(el.value);if(!Number.isFinite(v))throw Error(`${name}은 유한한 숫자여야 합니다.`);return v;}
function storageSave(){try{localStorage.setItem(cacheKey,JSON.stringify(state));$('saveStatus').textContent='이 브라우저에 저장되었습니다.';}catch{$('saveStatus').textContent='브라우저 저장이 차단되었습니다. 현재 화면에는 적용되었습니다.';}}
function validateState(next){
  if(!Array.isArray(next.saaPresets)||next.saaPresets.length!==2||!Array.isArray(next.taaPresets)||next.taaPresets.length!==2)throw Error('저장된 SAA·TAA 형식을 확인하십시오.');
  validateInputs(next.assets,next.correlation);
  const matrix=covariance(next.assets,next.correlation);
  stats(next.assets.map(a=>a.weight),next.assets,matrix,next.rf);
  stats(next.taa1,next.assets,matrix,next.rf);stats(next.taa2,next.assets,matrix,next.rf);
  validatePolicy(next.assets,next.policy);
  if(!Number.isFinite(next.target))throw Error('목표수익률을 확인하십시오.');
  return optimizeAllocation(next.assets,matrix,next.rf,next.target,next.policy);
}
function install(raw,restore=true){
  const nextData=normalizeData(raw);
  const weights=nextData.assets.map(a=>a.weight);
  const nextInitial={assets:clone(nextData.assets),correlation:clone(nextData.correlation),rf:2.5,target:6,edited:false,policy:defaultPolicy(nextData.assets),taa1:[...weights],taa2:[...weights],saaPresets:[null,null],taaPresets:[null,null]};
  let nextState=clone(nextInitial);
  const nextKey=`bje-portfolio-v2:${nextData.meta.dataFingerprint||JSON.stringify([nextData.meta,nextData.assets.map(a=>[a.id,a.mu,a.vol])])}`;
  if(restore)try{const saved=JSON.parse(localStorage.getItem(nextKey));if(saved){
    if(JSON.stringify(saved.assets.map(a=>a.id))!==JSON.stringify(nextData.assets.map(a=>a.id)))throw Error();
    validateState(saved);nextState=saved;
  }}catch{/* incompatible saved state is ignored */}
  validateState(nextState);
  data=nextData;initial=nextInitial;state=nextState;cacheKey=nextKey;
  if(Object.hasOwn(data,'fxHedge') || !dataInfoUI.getSnapshot()){fxSnapshot=normalizeFxHedge(data.fxHedge);hedgeAnalytics?.install(null);}
  chosen='current';selectedAssetIndex=null;renderInputs();recalculate();renderAllocationInputs();renderHistory();renderHedge();
}
function recalculate(){
  const optimized=validateState(state);cov=covariance(state.assets,state.correlation);
  results={current:stats(state.assets.map(a=>a.weight),state.assets,cov,state.rf),...optimized,taa1:stats(state.taa1,state.assets,cov,state.rf),taa2:stats(state.taa2,state.assets,cov,state.rf)};
  cloud=samplePortfolios(state.assets,cov,state.rf,state.policy,{count:2400,seed:42719}).sort((a,b)=>a.sharpe-b.sharpe);
  exploredIndex=Math.min(exploredIndex,Math.max(0,cloud.length-1));
  if(selectedAssetIndex!==null && state.assets[selectedAssetIndex])results.asset=stats(state.assets.map((_,i)=>+(i===selectedAssetIndex)),state.assets,cov,state.rf);
  if(chosen==='explored')chosen='current';
  if(!results[chosen])chosen='current';
  $('targetInput').value=String(state.target);$('riskFreeInput').value=String(state.rf);
  const range=results.returnRange||[Math.min(...state.assets.map(a=>a.mu)),Math.max(...state.assets.map(a=>a.mu))];
  $('feasibleRange').textContent=`달성 가능 범위 ${fmt(range[0])} ~ ${fmt(range[1])}%`;
  $('mixSlider').max=String(Math.max(0,cloud.length-1));$('mixSlider').value=String(exploredIndex);$('mixSlider').disabled=!cloud.length;
  renderSelection();
}
function renderSelection(){
  try{frontierComparison=frontierTarget({selected:results[chosen],assets:state.assets,cov,rf:state.rf,policy:state.policy,optimized:results,mode:frontierMode});}
  catch(error){frontierComparison={target:null,status:'error',condition:'이동 목표 계산 불가 · '+error.message};}
  renderCards();renderFrontier();renderAllocation();renderRisk();renderTaaSummary();
}
function renderRisk(){
  $('riskPortfolio').innerHTML=Object.entries(selectionNames).filter(([key])=>!['explored','asset'].includes(key)||results[key]).map(([key,name])=>`<option value="${key}" ${results[key]?'':'disabled'}>${esc(name)}${key==='target'&&!results[key]?' · 달성 불가':''}</option>`).join('');
  $('riskPortfolio').value=chosen;
  $('riskContent').innerHTML=renderRiskMarkup(results[chosen],state.assets,selectionNames[chosen]);
}
function renderHedge(){
  $('hedgeGrid').innerHTML=renderHedgeMarkup(fxSnapshot);
  $('hedgeSource').textContent=fxSnapshot.source;
  dataInfoUI.renderHedge(fxSnapshot);
}
function setHedgeTab(tab){
  if(!['monitor','modelA','modelB'].includes(tab))tab='monitor';
  document.querySelectorAll('.hedge-panel').forEach(el=>el.hidden=el.id!==`hedge-${tab}`);
  document.querySelectorAll('[data-hedge-tab]').forEach(button=>{
    const selected=button.dataset.hedgeTab===tab;
    button.classList.toggle('active',selected);
    button.setAttribute('aria-pressed',String(selected));
  });
}
function renderCards(){
  const z=zValues[String(Number($('coverage').value)).replace(/^0/,'')];
  $('portfolioCards').innerHTML=Object.entries(names).map(([key,name],i)=>{
    const p=results[key];
    if(!p)return `<button class="portfolio-card" disabled><div class="card-top">${name}<span class="card-number">0${i+1}</span></div><div class="card-unavailable">달성 불가</div><div class="small">목표 ${fmt(state.target)}%<br>가능 범위 내 목표를 입력하십시오.</div></button>`;
    return `<button class="portfolio-card ${chosen===key?'selected':''}" data-portfolio="${key}" aria-pressed="${chosen===key}"><div class="card-top"><span>${esc(name)}${key==='target'?` ${fmt(state.target,1)}%`:''}</span><span class="card-number">0${i+1}</span></div><div class="card-return">${fmt(p.mu)}<small> %</small></div><div class="metric-caption">${state.edited?'입력 기대수익률':'연간 수익률 가정'}${!satisfiesPolicy(p.weights,state.assets,state.policy)?' · SAA 제약 밖':''}</div><div class="card-metrics"><div><span>변동성</span>${fmt(p.vol)}%</div><div><span>Sharpe</span>${fmt(p.sharpe)}</div></div><div class="card-range"><span>${Math.round(Number($('coverage').value)*100)}% 수익률 범위</span><span class="range-value">${fmt(p.mu-z*p.vol,1)} ~ ${fmt(p.mu+z*p.vol,1)}%</span></div><div class="allocation-mini">${p.weights.map((w,j)=>`<span style="width:${w*100}%;background:${colors[j%colors.length]}"></span>`).join('')}</div></button>`;
  }).join('');
  document.querySelectorAll('[data-portfolio]').forEach(b=>b.onclick=()=>{chosen=b.dataset.portfolio;renderSelection();});
}
function chartScales(points,W,H,pad={l:58,r:30,t:35,b:55},bounds={}){
  let xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);let xmin=Math.min(...xs),xmax=Math.max(...xs),ymin=Math.min(...ys),ymax=Math.max(...ys);
  const dx=(xmax-xmin)||1,dy=(ymax-ymin)||1;xmin=Math.max(0,xmin-dx*.13);xmax+=dx*.1;ymin-=dy*.15;ymax+=dy*.13;
  xmin=bounds.xmin??xmin;xmax=bounds.xmax??xmax;ymin=bounds.ymin??ymin;ymax=bounds.ymax??ymax;
  return {xmin,xmax,ymin,ymax,pad,x:v=>pad.l+(v-xmin)/(xmax-xmin)*(W-pad.l-pad.r),y:v=>H-pad.b-(v-ymin)/(ymax-ymin)*(H-pad.t-pad.b)};
}
function sharpeColor(value,min,max){
  const stops=[[147,104,213],[65,164,198],[67,190,153],[205,216,72],[255,160,72]];
  const t=max-min<1e-12?.5:Math.max(0,Math.min(1,(value-min)/(max-min)));
  const f=t*(stops.length-1),i=Math.min(stops.length-2,Math.floor(f)),u=f-i;
  return `rgb(${stops[i].map((v,j)=>Math.round(v+(stops[i+1][j]-v)*u)).join(',')})`;
}
function selectMix(index){
  if(!cloud[index])return;
  exploredIndex=index;results.explored=cloud[index];chosen='explored';
  $('mixSlider').value=String(index);renderSelection();
}
function selectAsset(index){
  if(!state.assets[index])return;
  selectedAssetIndex=index;selectionNames.asset=state.assets[index].name;
  results.asset=stats(state.assets.map((_,i)=>+(i===index)),state.assets,cov,state.rf);
  chosen='asset';renderSelection();
}
function applyFrontierAxes(event){
  event.preventDefault();
  try{
    const next={};
    for(const [axis,label] of [['X','변동성 X축'],['Y','기대수익 Y축']]){
      const low=$(`frontier${axis}Min`),high=$(`frontier${axis}Max`);
      if(low.validity?.badInput||high.validity?.badInput)throw Error(`${label}에 유효한 숫자를 입력하십시오.`);
      const hasLow=low.value.trim()!=='',hasHigh=high.value.trim()!=='';
      if(!hasLow&&!hasHigh)continue;
      if(!hasLow||!hasHigh)throw Error(`${label}의 최소·최대를 모두 입력하거나 모두 비워 두십시오.`);
      const min=numberInput(low,`${label} 최소`),max=numberInput(high,`${label} 최대`),span=max-min;
      if(min>=max)throw Error(`${label}의 최대는 최소보다 커야 합니다.`);
      if(axis==='X'&&min<0)throw Error('변동성 X축은 0 이상이어야 합니다.');
      if(!Number.isFinite(span)||span<Math.max(1,Math.abs(min),Math.abs(max))*1e-10)throw Error(`${label} 범위를 더 넓게 설정하십시오.`);
      next[axis.toLowerCase()+'min']=min;next[axis.toLowerCase()+'max']=max;
    }
    frontierAxes=next;$('frontierAxisError').hidden=true;renderFrontier();
  }catch(error){$('frontierAxisError').textContent=error.message;$('frontierAxisError').hidden=false;}
}
function resetFrontierAxes(){
  frontierAxes={};
  for(const axis of ['X','Y'])for(const bound of ['Min','Max'])$(`frontier${axis}${bound}`).value='';
  $('frontierAxisError').hidden=true;renderFrontier();
}
function renderFrontier(){
  const chart=$('frontierChart'),W=Math.max(240,(chart.clientWidth||800)-14),H=W<500?370:460;
  const all=[...results.frontier,...cloud,...(frontierComparison?.target?[frontierComparison.target]:[]),...state.assets,...Object.keys(selectionNames).map(k=>results[k]).filter(Boolean)];
  const s=chartScales(all.map(p=>[p.vol,p.mu]),W,H,{l:62,r:30,t:28,b:50},frontierAxes);
  const visible=p=>p.vol>=s.xmin&&p.vol<=s.xmax&&p.mu>=s.ymin&&p.mu<=s.ymax;
  const tick=(value,span)=>fmt(value,Math.min(10,Math.max(2,1-Math.floor(Math.log10(span/4)))));
  let markup=`<defs><clipPath id="frontierPlotClip"><rect x="${s.pad.l}" y="${s.pad.t}" width="${W-s.pad.l-s.pad.r}" height="${H-s.pad.t-s.pad.b}"/></clipPath></defs>`;
  for(let i=0;i<=4;i++){
    const yy=s.ymin+(s.ymax-s.ymin)*(i/4),y=s.y(yy),xx=s.xmin+(s.xmax-s.xmin)*(i/4),x=s.x(xx);
    markup+=`<line x1="${s.pad.l}" y1="${y}" x2="${W-s.pad.r}" y2="${y}" stroke="#2c3a30"/><line x1="${x}" y1="${s.pad.t}" x2="${x}" y2="${H-s.pad.b}" stroke="#2c3a30"/><text x="${s.pad.l-9}" y="${y+4}" text-anchor="end" font-size="13">${tick(yy,s.ymax-s.ymin)}</text><text x="${x}" y="${H-27}" text-anchor="middle" font-size="13">${tick(xx,s.xmax-s.xmin)}</text>`;
  }
  markup+=`<text x="5" y="16" font-size="13">기대수익 (%)</text><text x="${W-s.pad.r}" y="${H-4}" text-anchor="end" font-size="13">변동성 (%)</text>`;
  const sharpes=[...cloud,...results.frontier,results.maxSharpe].map(p=>p.sharpe),min=Math.min(...sharpes),max=Math.max(...sharpes);
  markup+='<g clip-path="url(#frontierPlotClip)">';
  markup+=cloud.map((p,i)=>!visible(p)?'':`<circle data-mix="${i}" cx="${s.x(p.vol).toFixed(2)}" cy="${s.y(p.mu).toFixed(2)}" r="${W<500?2.2:2.5}" fill="${sharpeColor(p.sharpe,min,max)}" opacity=".72"><title>Sharpe ${fmt(p.sharpe)} · 수익 ${fmt(p.mu)}% · 변동성 ${fmt(p.vol)}%${state.assets.map((a,j)=>`\n${esc(a.name)} ${fmt(p.weights[j]*100)}%`).join('')}</title></circle>`).join('');
  markup+=`<path d="${results.frontier.map((p,i)=>`${i?'L':'M'}${s.x(p.vol)},${s.y(p.mu)}`).join(' ')}" fill="none" stroke="#b6dba7" stroke-width="2.5" pointer-events="none"/>`;
  markup+=state.assets.map((a,i)=>!visible(a)?'':`<g data-chart-asset="${i}" tabindex="0" role="button" aria-label="${esc(a.name)} 선택" aria-pressed="${chosen==='asset'&&selectedAssetIndex===i}"><circle cx="${s.x(a.vol)}" cy="${s.y(a.mu)}" r="12" fill="transparent"/><circle cx="${s.x(a.vol)}" cy="${s.y(a.mu)}" r="3.5" fill="${colors[i%colors.length]}"/>${W>=500?`<text x="${s.x(a.vol)+(s.x(a.vol)<W/2?7:-7)}" y="${s.y(a.mu)+(a.group==='bond'?(i%2?30:14):-14)}" text-anchor="${s.x(a.vol)<W/2?'start':'end'}" font-size="12">${esc(a.name)}</text>`:''}<title>${esc(a.name)} · 수익률 ${fmt(a.mu)}%, 변동성 ${fmt(a.vol)}%</title></g>`).join('');
  if(frontierComparison?.target){
    const from=results[chosen],to=frontierComparison.target;
    markup+=`<g class="frontier-move" pointer-events="none"><line x1="${s.x(from.vol)}" y1="${s.y(from.mu)}" x2="${s.x(to.vol)}" y2="${s.y(to.mu)}" stroke="#f1eee2" stroke-width="1.5" stroke-dasharray="5 4"/><circle cx="${s.x(to.vol)}" cy="${s.y(to.mu)}" r="6" fill="#111817" stroke="#f1eee2" stroke-width="2"/><title>이동 목표 · 기대수익 ${fmt(to.mu)}% · 변동성 ${fmt(to.vol)}%</title></g>`;
  }
  markup+=Object.keys(selectionNames).filter(k=>results[k]&&visible(results[k])).sort((a,b)=>Number(a===chosen)-Number(b===chosen)).map(k=>{
    const p=results[k],sel=k===chosen,c=k==='taa1'?'#7fc9dc':k==='taa2'?'#d7a6d8':sel?'#e8c78c':'#d5e0d0';
    return `<g data-chart-portfolio="${k}" tabindex="0" role="button" aria-label="${esc(selectionNames[k])} 선택"><circle cx="${s.x(p.vol)}" cy="${s.y(p.mu)}" r="${sel?7:5}" fill="${c}" stroke="#18211f" stroke-width="2"/>${sel?`<circle cx="${s.x(p.vol)}" cy="${s.y(p.mu)}" r="11" fill="none" stroke="${c}"/>`:''}<title>${esc(selectionNames[k])} · Sharpe ${fmt(p.sharpe)} · ${fmt(p.mu)}% / ${fmt(p.vol)}%${satisfiesPolicy(p.weights,state.assets,state.policy)?'':' · SAA 제약 밖'}</title></g>`;
  }).join('');
  markup+='</g>';
  $('frontierChart').innerHTML=`<svg viewBox="0 0 ${W} ${H}" role="group" aria-label="Sharpe 그라데이션 조합과 효율적 경계선">${markup}</svg>`;
  $('assetSelectors').innerHTML=state.assets.map((a,i)=>`<button data-select-asset="${i}" aria-pressed="${chosen==='asset'&&selectedAssetIndex===i}" style="--asset-color:${colors[i%colors.length]}">${esc(a.name)}</button>`).join('');
  for(const selector of ['[data-chart-asset]','[data-select-asset]'])document.querySelectorAll(selector).forEach(el=>{
    el.onclick=()=>selectAsset(Number(el.dataset.chartAsset??el.dataset.selectAsset));
    if(el.dataset.chartAsset!==undefined)el.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();el.onclick();}};
  });
  document.querySelectorAll('[data-mix]').forEach(el=>el.onclick=()=>selectMix(Number(el.dataset.mix)));
  document.querySelectorAll('[data-chart-portfolio]').forEach(el=>{
    el.onclick=()=>{chosen=el.dataset.chartPortfolio;renderSelection();};
    el.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();el.onclick();}};
  });
  $('sharpeMin').textContent=fmt(min);$('sharpeMax').textContent=fmt(max);$('mixCount').textContent=`${cloud.length.toLocaleString('ko-KR')}개 조합`;
  const p=results[chosen];$('mixMetric').textContent=`${selectionNames[chosen]} · Sharpe ${fmt(p.sharpe)} · 수익 ${fmt(p.mu)}% · 변동성 ${fmt(p.vol)}%`;
}
function renderAllocation(){
  const p=results[chosen];$('selectedLabel').textContent=selectionNames[chosen];let offset=0;const r=63,c=2*Math.PI*r;
  const circles=p.weights.map((w,i)=>{const str=`<circle cx="85" cy="85" r="${r}" fill="none" stroke="${colors[i%colors.length]}" stroke-width="14" stroke-dasharray="${Math.max(0,w*c-.8)} ${c}" stroke-dashoffset="${-offset}" transform="rotate(-90 85 85)"/>`;offset+=w*c;return str;}).join('');
  $('allocationDonut').innerHTML=`<svg viewBox="0 0 170 170" role="img" aria-label="선택 포트폴리오의 자산별 비중"><circle cx="85" cy="85" r="63" fill="none" stroke="#2a392e" stroke-width="14"/>${circles}<text x="85" y="83" text-anchor="middle" fill="#e4edda" font-size="30" font-family="inherit">100<tspan font-size="16">%</tspan></text><text x="85" y="104" text-anchor="middle" fill="#8ba184" font-size="10" letter-spacing=".2">FULLY INVESTED</text></svg>`;
  const target=frontierComparison?.target;
  const deltaText=value=>{const clean=Math.abs(value)<.005?0:value;return `${clean>0?'+':''}${fmt(clean)}`;};
  $('frontierMode').value=frontierMode;
  $('frontierCondition').textContent=frontierComparison?.condition||'';
  $('frontierCondition').classList.toggle('warn',!target);
  $('allocationLegend').innerHTML=`<table class="allocation-comparison"><thead><tr><th>자산</th><th>선택 %</th><th>목표 %</th><th>증감 %p</th></tr></thead><tbody>${state.assets.map((a,i)=>{
    const diff=target?(target.weights[i]-p.weights[i])*100:null;
    return `<tr><td><span style="color:${colors[i%colors.length]}">${esc(a.name)}</span></td><td>${fmt(p.weights[i]*100)}</td><td>${target?fmt(target.weights[i]*100):'—'}</td><td class="${diff!==null&&Math.abs(diff)>=.005?(diff>0?'delta-positive':'delta-negative'):''}">${diff===null?'—':deltaText(diff)}</td></tr>`;
  }).join('')}</tbody></table>`;
  $('selectedMetrics').innerHTML=`<div class="selection-metrics-title">${esc(selectionNames[chosen])}</div><div class="selected-metric-grid"><div><span>기대수익</span><strong id="selectedReturn">${fmt(p.mu)}<small>%</small></strong></div><div><span>변동성</span><strong id="selectedVolatility">${fmt(p.vol)}<small>%</small></strong></div></div>${target?`<div class="frontier-target-metrics"><span>이동 목표</span><span>기대수익 <strong>${fmt(target.mu)}%</strong></span><span>변동성 <strong>${fmt(target.vol)}%</strong></span></div>`:''}`;
  $('allocationTable').innerHTML=state.assets.map((a,i)=>{const diff=(p.weights[i]-a.weight)*100;return `<tr><td><i class="legend-dot" style="background:${colors[i%colors.length]}"></i>${esc(a.name)}</td><td>${fmt(a.weight*100)}%</td><td>${fmt(p.weights[i]*100)}%</td><td class="${Math.abs(diff)<.005?'':diff>0?'delta-positive':'delta-negative'}">${diff>0?'+':''}${fmt(diff)}</td><td>${fmt(p.riskShares[i]*100,1)}% <i class="risk-bar"><span style="width:${Math.min(100,Math.abs(p.riskShares[i]*100))}%;background:${p.riskShares[i]<0?'#e3a49c':colors[i%colors.length]}"></span></i></td></tr>`;}).join('');
}
function readPolicy(){
  const policy=clone(state.policy);
  document.querySelectorAll('[data-saa-group]').forEach(el=>{policy.groups[el.dataset.saaGroup][el.dataset.bound]=numberInput(el,'SAA 자산군 제약')/100;});
  document.querySelectorAll('[data-saa-asset]').forEach(el=>{policy.bounds[Number(el.dataset.saaAsset)][el.dataset.bound]=numberInput(el,'SAA 개별 자산 제약')/100;});
  validatePolicy(state.assets,policy);return policy;
}
function readTaa(){
  const next=clone(state);
  document.querySelectorAll('[data-taa]').forEach(el=>{next[el.dataset.taa][Number(el.dataset.asset)]=numberInput(el,'TAA 비중')/100;});
  document.querySelectorAll('[data-taa-moment]').forEach(el=>{if(el.value!==el.dataset.baseline)next.assets[Number(el.dataset.asset)][el.dataset.taaMoment]=numberInput(el,'TAA 투자 가정');});
  validateState(next);return next;
}
function renderAllocationInputs(policy=state.policy,taa=state,section='all'){
  const input=(value,attributes,label)=>`<input type="number" min="0" max="100" step=".01" value="${fmtInput(value*100)}" ${attributes} aria-label="${esc(label)}">`;
  if(section!=='taa'){
  $('saaGroups').innerHTML=Object.entries(groupNames).map(([group,name])=>`<tr><td>${name}</td>${['min','max'].map(bound=>`<td>${input(policy.groups[group][bound],`data-saa-group="${group}" data-bound="${bound}"`,`${name} ${bound==='min'?'최소':'최대'} 비중`)}</td>`).join('')}</tr>`).join('');
  $('saaAssets').innerHTML=state.assets.map((a,i)=>`<tr><td>${esc(a.name)}</td>${['min','max'].map(bound=>`<td>${input(policy.bounds[i][bound],`data-saa-asset="${i}" data-bound="${bound}"`,`${a.name} ${bound==='min'?'최소':'최대'} 비중`)}</td>`).join('')}</tr>`).join('');
  }
  if(section!=='saa'){
  $('taaAssets').innerHTML=state.assets.map((a,i)=>`<tr><td><i class="legend-dot" style="background:${colors[i%colors.length]}"></i>${esc(a.name)}</td>${['taa1','taa2'].map(key=>`<td>${input(taa[key][i],`data-taa="${key}" data-asset="${i}"`,`${a.name} ${selectionNames[key]}`)}</td>`).join('')}${['mu','vol'].map(key=>`<td><input type="number" step=".01" value="${fmtInput(taa.assets[i][key])}" data-baseline="${fmtInput(state.assets[i][key])}" data-taa-moment="${key}" data-asset="${i}" aria-label="${esc(a.name)} ${key==='mu'?'기대수익률':'변동성'}"></td>`).join('')}<td id="taa-delta-${i}">${fmt((taa.taa2[i]-taa.taa1[i])*100)}</td></tr>`).join('');
  document.querySelectorAll('[data-taa]').forEach(el=>el.oninput=updateTaaDraft);
  updateTaaDraft();
  }
  $('saaStatus').textContent=`적용 중 · 채권 ${fmt(state.policy.groups.bond.min*100,0)}~${fmt(state.policy.groups.bond.max*100,0)}% · 주식 ${fmt(state.policy.groups.equity.min*100,0)}~${fmt(state.policy.groups.equity.max*100,0)}% · 대체 ${fmt(state.policy.groups.alternative.min*100,0)}~${fmt(state.policy.groups.alternative.max*100,0)}%`;
  renderTaaSummary();
}
function fmtInput(value){return String(Number(value.toFixed(10)));}
function updateTaaDraft(){
  const totals={taa1:0,taa2:0},weights={taa1:[],taa2:[]};
  document.querySelectorAll('[data-taa]').forEach(el=>{const value=Number(el.value);totals[el.dataset.taa]+=value;weights[el.dataset.taa][Number(el.dataset.asset)]=value;});
  state.assets.forEach((a,i)=>{if($(`taa-delta-${i}`))$(`taa-delta-${i}`).textContent=fmt(weights.taa2[i]-weights.taa1[i]);});
  $('taaDraftStatus').textContent=`입력 합계 · 비중1 ${fmt(totals.taa1)}% / 비중2 ${fmt(totals.taa2)}%`;
  $('taaDraftStatus').classList.toggle('warn',Object.values(totals).some(v=>!Number.isFinite(v)||Math.abs(v-100)>1e-6));
}
function renderTaaSummary(){
  for(const [key,id] of [['taa1','selectTaa1'],['taa2','selectTaa2']]){
    if(!results?.[key])continue;
    const p=results[key],valid=satisfiesPolicy(p.weights,state.assets,state.policy);
    $(id).innerHTML=`<strong>${selectionNames[key]}</strong><span>수익 ${fmt(p.mu)}% · 변동성 ${fmt(p.vol)}% · Sharpe ${fmt(p.sharpe)}</span><span class="${valid?'accent':'warn'}">${valid?'SAA 충족':'SAA 제약 밖'}</span>`;
    $(id).classList.toggle('selected',chosen===key);$(id).setAttribute('aria-pressed',String(chosen===key));
  }
}
function applyPolicy(policy){
  const next={...clone(state),policy};validateState(next);
  state=next;recalculate();renderAllocationInputs(state.policy,state,'saa');storageSave();
}
function setupAllocationEvents(){
  $('frontierAxisForm').onsubmit=applyFrontierAxes;
  $('frontierAxisReset').onclick=resetFrontierAxes;
  $('frontierMode').onchange=()=>{frontierMode=$('frontierMode').value==='same-return'?'same-return':'same-risk';renderSelection();};
  $('mixSlider').oninput=()=>selectMix(Number($('mixSlider').value));
  $('saaApply').onclick=()=>{clearError();try{applyPolicy(readPolicy());message('SAA 제약을 적용했습니다.');}catch(e){message(e.message,true);}};
  $('saaReset').onclick=()=>{clearError();try{applyPolicy(defaultPolicy(state.assets));message('SAA 제약을 해제했습니다.');}catch(e){message(e.message,true);}};
  $('taaApply').onclick=()=>{clearError();try{const next=readTaa();next.edited=true;state=next;chosen='taa1';recalculate();renderInputs();renderAllocationInputs(state.policy,state,'taa');storageSave();message('TAA 비중과 가정을 적용했습니다.');}catch(e){message(e.message,true);}};
  $('selectTaa1').onclick=()=>{chosen='taa1';renderSelection();};$('selectTaa2').onclick=()=>{chosen='taa2';renderSelection();};
  $('saaSave').onclick=()=>{clearError();try{const policy=readPolicy();state.saaPresets[Number($('saaPreset').value)||0]=clone(policy);storageSave();message('SAA 입력을 저장했습니다.');}catch(e){message(e.message,true);}};
  $('saaLoad').onclick=()=>{clearError();try{const saved=state.saaPresets[Number($('saaPreset').value)||0];if(!saved)throw Error('저장된 SAA가 없습니다.');validatePolicy(state.assets,saved);renderAllocationInputs(saved,state,'saa');message('SAA 입력을 불러왔습니다. 제약 적용으로 반영하십시오.');}catch(e){message(e.message,true);}};
  $('taaSave').onclick=()=>{clearError();try{const next=readTaa();state.taaPresets[Number($('taaPreset').value)||0]={taa1:next.taa1,taa2:next.taa2,assets:next.assets.map(a=>({mu:a.mu,vol:a.vol}))};storageSave();message('TAA 입력을 저장했습니다.');}catch(e){message(e.message,true);}};
  $('taaLoad').onclick=()=>{clearError();try{const saved=state.taaPresets[Number($('taaPreset').value)||0];if(!saved)throw Error('저장된 TAA가 없습니다.');const next={...clone(state),taa1:saved.taa1,taa2:saved.taa2,assets:state.assets.map((a,i)=>({...a,...saved.assets[i]}))};validateState(next);renderAllocationInputs(state.policy,next,'taa');message('TAA 입력을 불러왔습니다. 비중·가정 적용으로 반영하십시오.');}catch(e){message(e.message,true);}};
}

function renderInputs(){
  $('assetInputs').innerHTML=state.assets.map((a,i)=>`<tr><td><i class="legend-dot" style="background:${colors[i%colors.length]}"></i>${esc(a.name)}</td>${['mu','vol','weight'].map(f=>{const value=(f==='weight'?a[f]*100:a[f]).toFixed(2);return `<td><input type="number" data-i="${i}" data-field="${f}" data-baseline="${value}" step=".01" value="${value}" aria-label="${esc(a.name)} ${f==='mu'?'수익률':f==='vol'?'변동성':'현재 비중'}"></td>`;}).join('')}</tr>`).join('');
  $('correlationInputs').innerHTML=`<table><thead><tr><th>자산</th>${state.assets.map((a,i)=>`<th>${i+1}</th>`).join('')}</tr></thead><tbody>${state.assets.map((a,i)=>`<tr><td>${i+1}. ${esc(a.name)}</td>${state.assets.map((b,j)=>`<td>${i===j?'1.00':j>i?`<input type="number" step=".001" min="-1" max="1" data-corr="${i},${j}" data-baseline="${state.correlation[i][j].toFixed(3)}" value="${state.correlation[i][j].toFixed(3)}" aria-label="${esc(a.name)} / ${esc(b.name)} 상관계수">`:`<span id="corr-${i}-${j}" class="small">${fmt(state.correlation[i][j],3)}</span>`}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  document.querySelectorAll('[data-corr]').forEach(el=>el.oninput=()=>{const [i,j]=el.dataset.corr.split(',');$(`corr-${j}-${i}`).textContent=el.value;});
  document.querySelectorAll('[data-field=weight]').forEach(el=>el.oninput=updateWeightSum);
  $('riskFreeInput').value=state.rf;updateWeightSum();
}
function updateWeightSum(){const sum=[...document.querySelectorAll('[data-field=weight]')].reduce((s,el)=>s+Number(el.value),0);$('weightSum').textContent=`비중 합계 ${fmt(sum)}%`;$('weightSum').classList.toggle('warn',Math.abs(sum-100)>.00001);}
function applyInputs(){
  clearError();try{
    const next=clone(state);document.querySelectorAll('[data-field]').forEach(el=>{if(el.value===el.dataset.baseline)return;let v=numberInput(el,el.getAttribute('aria-label'));if(el.dataset.field==='weight')v/=100;next.assets[Number(el.dataset.i)][el.dataset.field]=v;});
    document.querySelectorAll('[data-corr]').forEach(el=>{if(el.value===el.dataset.baseline)return;const[i,j]=el.dataset.corr.split(',').map(Number);const v=numberInput(el,'상관계수');next.correlation[i][j]=next.correlation[j][i]=v;});
    next.rf=numberInput($('riskFreeInput'),'무위험금리');next.edited=true;validateInputs(next.assets,next.correlation);stats(next.assets.map(a=>a.weight),next.assets,covariance(next.assets,next.correlation),next.rf);
    validateState(next);
    state=next;recalculate();renderInputs();renderAllocationInputs(state.policy,state,'taa');storageSave();setTab('overview');message('투자 가정을 적용했습니다.');
  }catch(e){message(e.message,true);}
}
function renderHistory(){
  const monthly=data.monthly;
  if(!monthly||!monthly.dates?.length){$('historyChart').innerHTML='<div class="empty-chart">실제 시계열이 없는 예시 데이터입니다.<br>데이터 스냅샷을 불러오면 총수익 추이가 표시됩니다.</div>';$('historyLegend').innerHTML='';return;}
  const dates=monthly.dates.slice(-(period+1)),base=monthly.base100.slice(-(period+1)),n=base.length;
  const v=base.map(row=>row.map((x,i)=>x/base[0][i]*100));const W=Math.max(320,$('historyChart').clientWidth||1030),H=250,pad={l:58,r:35,t:20,b:42};
  const ys=v.flat();let min=Math.min(...ys),max=Math.max(...ys);const dy=max-min||1;min-=dy*.1;max+=dy*.1;
  const x=i=>pad.l+i/(n-1)*(W-pad.l-pad.r),y=a=>H-pad.b-(a-min)/(max-min)*(H-pad.t-pad.b);let svg='';
  for(let i=0;i<=3;i++){const val=min+(max-min)*i/3;svg+=`<line x1="${pad.l}" x2="${W-pad.r}" y1="${y(val)}" y2="${y(val)}" stroke="#2a3a2f" stroke-dasharray="3 5"/><text x="${pad.l-10}" y="${y(val)+4}" fill="#7e9684" text-anchor="end" font-size="14">${fmt(val,0)}</text>`;}
  const ticks=W<500?2:W<800?3:5;
  for(let i=0;i<=ticks;i++){const j=Math.round((n-1)*i/ticks);svg+=`<text x="${x(j)}" y="${H-12}" text-anchor="middle" fill="#7e9684" font-size="14">${esc(dates[j].slice(0,7).replace('-','.'))}</text>`;}
  svg+=data.assets.map((a,j)=>`<path d="${v.map((row,i)=>`${i?'L':'M'}${x(i)},${y(row[j])}`).join(' ')}" fill="none" stroke="${colors[j%colors.length]}" stroke-width="1.8"/>`).join('');
  $('historyChart').innerHTML=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="원화 기준 자산별 과거 누적 총수익지수">${svg}</svg>`;
  $('historyLegend').innerHTML=data.assets.map((a,i)=>`<span><i class="legend-dot" style="background:${colors[i%colors.length]}"></i>${esc(a.name)} <strong>${fmt((v.at(-1)[i]/100-1)*100,1)}%</strong></span>`).join('');
}
function setTab(tab){
  if(!['overview','assumptions','risk','hedge','fxmodel'].includes(tab))tab='overview';
  document.querySelectorAll('.tab-panel').forEach(el=>el.hidden=el.id!==tab);
  document.querySelectorAll('[data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
  const titles={overview:'포트폴리오 대시보드<span>.</span>',assumptions:'Capital Market Assumption',risk:'리스크',hedge:'환헤지',fxmodel:'Currency'};
  $('pageTitle').innerHTML=titles[tab];
  if(tab==='overview'){renderFrontier();renderHistory();}
}
setupAllocationEvents();
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>setTab(b.dataset.tab));
document.querySelectorAll('[data-hedge-tab]').forEach(b=>b.onclick=()=>setHedgeTab(b.dataset.hedgeTab));
$('riskPortfolio').onchange=()=>{if(results[$('riskPortfolio').value]){chosen=$('riskPortfolio').value;renderSelection();}};
$('hedgeImportButton').onclick=()=>$('hedgeImportFile').click();
$('hedgeImportFile').onchange=async event=>{
  clearError();const file=event.target.files[0];if(!file)return;
  try{
    if(file.size>5e6)throw Error('JSON 파일은 5MB 이하여야 합니다.');
    const raw=JSON.parse(await file.text());
    if(raw.kind==='bje_data_info')dataInfoUI.apply(raw);
    else{const next=normalizeFxHedge(raw.fxHedge??raw);fxSnapshot=next;renderHedge();hedgeAnalytics?.install(null);}
    message('환헤지 데이터 적용 · 새로고침 시 초기화');
  }catch(error){message('환헤지 데이터를 불러오지 못했습니다: '+error.message,true);}
  finally{event.target.value='';}
};
document.querySelector('.brand').onclick=e=>{e.preventDefault();setTab('overview');};
$('coverage').onchange=renderCards;
$('applyButton').onclick=applyInputs;
$('targetApply').onclick=()=>{clearError();try{const nextTarget=numberInput($('targetInput'),'목표수익률');optimizeAllocation(state.assets,cov,state.rf,nextTarget,state.policy);state.target=nextTarget;recalculate();storageSave();if(results.target){chosen='target';renderSelection();message('목표 포트폴리오를 계산했습니다.');}else message('목표수익률이 달성 가능 범위를 벗어났습니다.',true);}catch(e){message(e.message,true);}};
$('normalizeButton').onclick=()=>{try{const fields=[...document.querySelectorAll('[data-field=weight]')],v=fields.map(el=>numberInput(el,'비중'));const sum=v.reduce((a,b)=>a+b,0);if(sum<=0||v.some(x=>x<0))throw Error('0 이상의 비중을 입력하고 합계가 양수인지 확인하십시오.');fields.forEach((el,i)=>el.value=String(v[i]/sum*100));updateWeightSum();}catch(e){message(e.message,true);}};
$('resetButton').onclick=()=>{clearError();state=clone(initial);renderInputs();recalculate();renderAllocationInputs();storageSave();message('초기 가정을 복원했습니다.');};
document.querySelectorAll('[data-period]').forEach(b=>b.onclick=()=>{period=Number(b.dataset.period);document.querySelectorAll('[data-period]').forEach(p=>p.classList.toggle('active',p===b));renderHistory();});
$('importFile').onchange=async e=>{clearError();const file=e.target.files[0];if(!file)return;try{if(file.size>5e6)throw Error('JSON 파일은 5MB 이하여야 합니다.');const raw=JSON.parse(await file.text());normalizeData(raw);install(raw,false);message('새 데이터 스냅샷을 적용했습니다. 새로고침 시 원래 스냅샷으로 돌아갑니다.');}catch(err){message('데이터를 불러오지 못했습니다: '+err.message,true);}finally{e.target.value='';}};
try{const response=await fetch('./data.json',{cache:'no-store'});if(!response.ok)throw Error('data');install(await response.json());}catch(e){install(demoData);message('데이터 스냅샷을 읽지 못해 예시 가정으로 시작합니다.',true);}
const embeddedInfo=$('dataInfoEmbedded');
if(embeddedInfo?.textContent){try{dataInfoUI.apply(JSON.parse(embeddedInfo.textContent));}catch(error){$('dataInfoError').textContent='시장자료 초기화 오류 · '+error.message;$('dataInfoError').hidden=false;}}

if(typeof ResizeObserver!=='undefined'){
  const widths=new WeakMap();
  const observer=new ResizeObserver(entries=>entries.forEach(({target,contentRect})=>{
    const previous=widths.get(target);
    widths.set(target,contentRect.width);
    if(!contentRect.width||previous===contentRect.width)return;
    if(target.id==='frontierChart')renderFrontier();else renderHistory();
  }));
  observer.observe($('frontierChart'));observer.observe($('historyChart'));
}
