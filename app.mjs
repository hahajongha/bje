import { covariance, stats, optimize, validateInputs } from './portfolio.mjs';
import { demoData } from './demo-data.mjs';
import { normalizeFxHedge, renderHedgeMarkup } from './fx-hedge.mjs';
import { renderRiskMarkup } from './risk.mjs';

const $ = id => document.getElementById(id);
const colors = ['#bddb9c','#80b6a5','#d7bb86','#87a6c0','#b5a5c7','#b68e81'];
const names = { current:'현재 비중', minVol:'최소 변동성', target:'목표수익률', maxSharpe:'최대 Sharpe' };
const zValues = {'.68':0.994457883,'.9':1.644853627,'.95':1.959963985,'.99':2.575829304};
const fmt = (x,n=2) => Number.isFinite(x) ? x.toLocaleString('ko-KR',{minimumFractionDigits:n,maximumFractionDigits:n}) : '—';
const esc = x => String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let data, initial, state, results, cov, chosen='current', period=60, toastTimer, cacheKey, fxSnapshot=normalizeFxHedge(null);

function normalizeData(raw) {
  if(!raw || !Array.isArray(raw.assets) || raw.assets.length<2 || raw.assets.length>8) throw Error('자산 수는 2~8개여야 합니다.');
  const assets = raw.assets.map((a,i)=>({ ...a, id:String(a.id||i), name:String(a.name||a.id||i), mu:a.mu ?? a.annualMean*100, vol:a.vol ?? a.annualVol*100, weight:a.weight ?? a.currentWeight, color:colors[i%colors.length] }));
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
function install(raw,restore=true){
  data=normalizeData(raw);initial={assets:clone(data.assets),correlation:clone(data.correlation),rf:2.5,target:6,edited:false};
  state=clone(initial);cacheKey=`bje-portfolio-v1:${data.meta.dataFingerprint||JSON.stringify([data.meta, data.assets.map(a=>[a.id,a.mu,a.vol])])}`;
  if(restore)try{const s=JSON.parse(localStorage.getItem(cacheKey));if(s){validateInputs(s.assets,s.correlation);stats(s.assets.map(a=>a.weight),s.assets,covariance(s.assets,s.correlation),s.rf);if(!Number.isFinite(s.target))throw Error();state=s;}}catch{/* malformed local state is ignored */}
  fxSnapshot=normalizeFxHedge(data.fxHedge);
  chosen='current';renderInputs();recalculate();renderHistory();renderHedge();
}
function recalculate(){
  validateInputs(state.assets,state.correlation);cov=covariance(state.assets,state.correlation);
  const current=stats(state.assets.map(a=>a.weight),state.assets,cov,state.rf);
  results={current,...optimize(state.assets,cov,state.rf,state.target)};
  if(!results[chosen])chosen='current';
  $('targetInput').value=String(state.target);$('riskFreeInput').value=String(state.rf);
  const isDemo=!!data.meta.demo;
  $('sourceLabel').textContent=isDemo?'예시 가정 데이터':data.meta.mode==='private_actual'?'Google Drive · data_git':'사용자 데이터 스냅샷';
  $('dateLabel').textContent=data.meta.sampleStart&&data.meta.sampleEnd?`${data.meta.sampleStart} — ${data.meta.sampleEnd}`:'실제 시장 데이터 미적용';
  $('sampleLabel').textContent=data.meta.observations?`${data.meta.observations}개 월간 수익률 · KRW`:'KRW 기준 · 가상 입력';
  $('assumptionLabel').textContent=state.edited?'사용자 가정 적용':'과거 추정치 / 비중·무위험금리는 예시';
  if(isDemo)$('assumptionLabel').textContent=state.edited?'사용자 가정 적용':'데모 수치 · 투자 전망 아님';
  $('feasibleRange').textContent=`달성 가능 범위 ${fmt(Math.min(...state.assets.map(a=>a.mu)))} ~ ${fmt(Math.max(...state.assets.map(a=>a.mu)))}%`;
  renderSelection();
}
function renderSelection(){renderCards();renderFrontier();renderAllocation();renderRisk();}
function renderRisk(){
  $('riskPortfolio').innerHTML=Object.entries(names).map(([key,name])=>`<option value="${key}" ${results[key]?'':'disabled'}>${name}${key==='target'&&!results[key]?' · 달성 불가':''}</option>`).join('');
  $('riskPortfolio').value=chosen;
  $('riskContent').innerHTML=renderRiskMarkup(results[chosen],state.assets,names[chosen]);
}
function renderHedge(){
  $('hedgeGrid').innerHTML=renderHedgeMarkup(fxSnapshot);
  $('hedgeSource').textContent=fxSnapshot.source;
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
    return `<button class="portfolio-card ${chosen===key?'selected':''}" data-portfolio="${key}" aria-pressed="${chosen===key}"><div class="card-top"><span>${name}${key==='target'?` ${fmt(state.target,1)}%`:''}</span><span class="card-number">0${i+1}</span></div><div class="card-return">${fmt(p.mu)}<small> %</small></div><div class="metric-caption">${state.edited?'입력 기대수익률':'연간 수익률 가정'}</div><div class="card-metrics"><div><span>변동성</span>${fmt(p.vol)}%</div><div><span>Sharpe</span>${fmt(p.sharpe)}</div></div><div class="card-range"><span>${Math.round(Number($('coverage').value)*100)}% 수익률 범위</span><span class="range-value">${fmt(p.mu-z*p.vol,1)} ~ ${fmt(p.mu+z*p.vol,1)}%</span></div><div class="allocation-mini">${p.weights.map((w,j)=>`<span style="width:${w*100}%;background:${colors[j%colors.length]}"></span>`).join('')}</div></button>`;
  }).join('');
  document.querySelectorAll('[data-portfolio]').forEach(b=>b.onclick=()=>{chosen=b.dataset.portfolio;renderSelection();});
}
function chartScales(points,W,H,pad={l:58,r:30,t:35,b:55}){
  let xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);let xmin=Math.min(...xs),xmax=Math.max(...xs),ymin=Math.min(...ys),ymax=Math.max(...ys);
  const dx=(xmax-xmin)||1,dy=(ymax-ymin)||1;xmin=Math.max(0,xmin-dx*.13);xmax+=dx*.1;ymin-=dy*.15;ymax+=dy*.13;
  return {xmin,xmax,ymin,ymax,pad,x:v=>pad.l+(v-xmin)/(xmax-xmin)*(W-pad.l-pad.r),y:v=>H-pad.b-(v-ymin)/(ymax-ymin)*(H-pad.t-pad.b)};
}
function renderFrontier(){
  const W=Math.max(320,$('frontierChart').clientWidth||690),H=320;const all=[...results.frontier,...state.assets.map(a=>({vol:a.vol,mu:a.mu})),...Object.keys(names).map(k=>results[k]).filter(Boolean)];
  const s=chartScales(all.map(p=>[p.vol,p.mu]),W,H);let markup='';
  for(let i=0;i<=4;i++){const yy=s.ymin+(s.ymax-s.ymin)*i/4,y=s.y(yy),xx=s.xmin+(s.xmax-s.xmin)*i/4,x=s.x(xx);markup+=`<line x1="${s.pad.l}" y1="${y}" x2="${W-s.pad.r}" y2="${y}" stroke="#2c3a30" stroke-dasharray="3 5"/><text x="${s.pad.l-10}" y="${y+4}" text-anchor="end" fill="#7d9483" font-size="14">${fmt(yy,1)}</text><text x="${x}" y="${H-30}" text-anchor="middle" fill="#7d9483" font-size="14">${fmt(xx,1)}</text>`;}
  markup+=`<text x="5" y="17" fill="#8da18c" font-size="14">수익률 (%)</text><text x="${W-s.pad.r}" y="${H-5}" text-anchor="end" fill="#8da18c" font-size="14">변동성 (%)</text>`;
  markup+=`<path d="${results.frontier.map((p,i)=>`${i?'L':'M'}${s.x(p.vol)},${s.y(p.mu)}`).join(' ')}" fill="none" stroke="#b6dba7" stroke-width="2.5"/>`;
  markup+=state.assets.map((a,i)=>`<g><circle cx="${s.x(a.vol)}" cy="${s.y(a.mu)}" r="3.5" fill="${colors[i%colors.length]}" opacity=".65"/><text x="${s.x(a.vol)+(s.x(a.vol)<W/2?8:-8)}" y="${s.y(a.mu)-12}" text-anchor="${s.x(a.vol)<W/2?'start':'end'}" fill="#879f8b" font-size="12">${esc(a.name)}</text><title>${esc(a.name)} · 수익률 ${fmt(a.mu)}%, 변동성 ${fmt(a.vol)}%</title></g>`).join('');
  markup+=Object.keys(names).filter(k=>results[k]).sort(k=>k===chosen?1:-1).map(k=>{const p=results[k],sel=k===chosen;return `<g><circle cx="${s.x(p.vol)}" cy="${s.y(p.mu)}" r="${sel?7:4}" fill="${sel?'#e8c78c':'#d5e0d0'}" stroke="#18211f" stroke-width="2"/>${sel?`<circle cx="${s.x(p.vol)}" cy="${s.y(p.mu)}" r="12" fill="none" stroke="#e8c78c" opacity=".3"/>`:''}<title>${names[k]} · ${fmt(p.mu)}% / ${fmt(p.vol)}%</title></g>`;}).join('');
  $('frontierChart').innerHTML=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="연간 변동성과 수익률의 효율적 경계선">${markup}</svg>`;
  $('frontierStatus').textContent=state.edited?'사용자 가정 기준':'동일 표본 · 연율 기준';
}
function renderAllocation(){
  const p=results[chosen];$('selectedLabel').textContent=names[chosen];let offset=0;const r=63,c=2*Math.PI*r;
  const circles=p.weights.map((w,i)=>{const str=`<circle cx="85" cy="85" r="${r}" fill="none" stroke="${colors[i%colors.length]}" stroke-width="14" stroke-dasharray="${Math.max(0,w*c-.8)} ${c}" stroke-dashoffset="${-offset}" transform="rotate(-90 85 85)"/>`;offset+=w*c;return str;}).join('');
  $('allocationDonut').innerHTML=`<svg viewBox="0 0 170 170" role="img" aria-label="선택 포트폴리오의 자산별 비중"><circle cx="85" cy="85" r="63" fill="none" stroke="#2a392e" stroke-width="14"/>${circles}<text x="85" y="83" text-anchor="middle" fill="#e4edda" font-size="30" font-family="inherit">100<tspan font-size="16">%</tspan></text><text x="85" y="104" text-anchor="middle" fill="#8ba184" font-size="10" letter-spacing=".2">FULLY INVESTED</text></svg>`;
  $('allocationLegend').innerHTML=state.assets.map((a,i)=>`<div class="allocation-legend-row"><i class="legend-dot" style="background:${colors[i%colors.length]}"></i>${esc(a.name)}<strong>${fmt(p.weights[i]*100)}<small> %</small></strong></div>`).join('');
  $('allocationTable').innerHTML=state.assets.map((a,i)=>{const diff=(p.weights[i]-a.weight)*100;return `<tr><td><i class="legend-dot" style="background:${colors[i%colors.length]}"></i>${esc(a.name)}</td><td>${fmt(a.weight*100)}%</td><td>${fmt(p.weights[i]*100)}%</td><td class="${Math.abs(diff)<.005?'':diff>0?'delta-positive':'delta-negative'}">${diff>0?'+':''}${fmt(diff)}</td><td>${fmt(p.riskShares[i]*100,1)}% <i class="risk-bar"><span style="width:${Math.min(100,Math.abs(p.riskShares[i]*100))}%;background:${p.riskShares[i]<0?'#e3a49c':colors[i%colors.length]}"></span></i></td></tr>`;}).join('');
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
    optimize(next.assets,covariance(next.assets,next.correlation),next.rf,next.target);
    state=next;recalculate();renderInputs();storageSave();setTab('overview');message('투자 가정을 적용했습니다.');
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
  if(!['overview','assumptions','risk','hedge'].includes(tab))tab='overview';
  document.querySelectorAll('.tab-panel').forEach(el=>el.hidden=el.id!==tab);
  document.querySelectorAll('[data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
  const titles={overview:'포트폴리오 대시보드<span>.</span>',assumptions:'Capital Market Assumption',risk:'리스크',hedge:'환헤지'};
  $('pageTitle').innerHTML=titles[tab];
  document.querySelector('.data-strip').hidden=tab==='hedge';
  document.querySelector('.heading-actions').hidden=tab==='hedge';
  if(tab==='overview'){renderFrontier();renderHistory();}
}
function exportCsv(){
  const rows=[['portfolio','asset','weight_pct','annual_return_pct','annual_vol_pct','sharpe','risk_share_pct','assumption_mode','risk_free_pct','sample_start','sample_end']];
  Object.keys(names).forEach(k=>{const p=results[k];if(p)state.assets.forEach((a,i)=>rows.push([names[k],a.name,p.weights[i]*100,p.mu,p.vol,p.sharpe,p.riskShares[i]*100,state.edited?'user assumptions':data.meta.demo?'demo':'historical estimates',state.rf,data.meta.sampleStart||'',data.meta.sampleEnd||'']));});
  const safe=v=>{let s=String(v??'');if(typeof v==='string'&&/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
  const blob=new Blob(['\uFEFF'+rows.map(r=>r.map(safe).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='BJE-portfolio.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);message('포트폴리오 결과를 CSV로 내보냈습니다.');
}
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>setTab(b.dataset.tab));
document.querySelectorAll('[data-hedge-tab]').forEach(b=>b.onclick=()=>setHedgeTab(b.dataset.hedgeTab));
$('riskPortfolio').onchange=()=>{if(results[$('riskPortfolio').value]){chosen=$('riskPortfolio').value;renderSelection();}};
$('hedgeImportButton').onclick=()=>$('hedgeImportFile').click();
$('hedgeImportFile').onchange=async event=>{
  clearError();const file=event.target.files[0];if(!file)return;
  try{
    if(file.size>5e6)throw Error('JSON 파일은 5MB 이하여야 합니다.');
    const raw=JSON.parse(await file.text());
    const next=normalizeFxHedge(raw.fxHedge??raw);
    fxSnapshot=next;renderHedge();message('환헤지 데이터 적용 · 새로고침 시 초기화');
  }catch(error){message('환헤지 데이터를 불러오지 못했습니다: '+error.message,true);}
  finally{event.target.value='';}
};
document.querySelector('.brand').onclick=e=>{e.preventDefault();setTab('overview');};
$('editButton').onclick=()=>setTab('assumptions');$('coverage').onchange=renderCards;
$('applyButton').onclick=applyInputs;$('exportButton').onclick=exportCsv;
$('targetApply').onclick=()=>{clearError();try{const nextTarget=numberInput($('targetInput'),'목표수익률');optimize(state.assets,cov,state.rf,nextTarget);state.target=nextTarget;recalculate();storageSave();if(results.target){chosen='target';renderSelection();message('목표 포트폴리오를 계산했습니다.');}else message('목표수익률이 달성 가능 범위를 벗어났습니다.',true);}catch(e){message(e.message,true);}};
$('normalizeButton').onclick=()=>{try{const fields=[...document.querySelectorAll('[data-field=weight]')],v=fields.map(el=>numberInput(el,'비중'));const sum=v.reduce((a,b)=>a+b,0);if(sum<=0||v.some(x=>x<0))throw Error('0 이상의 비중을 입력하고 합계가 양수인지 확인하십시오.');fields.forEach((el,i)=>el.value=String(v[i]/sum*100));updateWeightSum();}catch(e){message(e.message,true);}};
$('resetButton').onclick=()=>{clearError();state=clone(initial);renderInputs();recalculate();storageSave();message('초기 가정을 복원했습니다.');};
document.querySelectorAll('[data-period]').forEach(b=>b.onclick=()=>{period=Number(b.dataset.period);document.querySelectorAll('[data-period]').forEach(p=>p.classList.toggle('active',p===b));renderHistory();});
$('importFile').onchange=async e=>{clearError();const file=e.target.files[0];if(!file)return;try{if(file.size>5e6)throw Error('JSON 파일은 5MB 이하여야 합니다.');const raw=JSON.parse(await file.text());normalizeData(raw);install(raw,false);message('새 데이터 스냅샷을 적용했습니다. 새로고침 시 원래 스냅샷으로 돌아갑니다.');}catch(err){message('데이터를 불러오지 못했습니다: '+err.message,true);}finally{e.target.value='';}};
try{const response=await fetch('./data.json',{cache:'no-store'});if(!response.ok)throw Error('data');install(await response.json());}catch(e){install(demoData);message('데이터 스냅샷을 읽지 못해 예시 가정으로 시작합니다.',true);}

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
