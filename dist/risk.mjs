const COLORS = ['#bddb9c', '#80b6a5', '#d7bb86', '#87a6c0', '#b5a5c7', '#b68e81'];
const RANGES = [[68, 0.994457883], [90, 1.644853627], [95, 1.959963985], [99, 2.575829304]];
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);
const fmt = value => Number.isFinite(value)
  ? (Math.abs(value) < 0.005 ? 0 : value).toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  : '—';
const signed = value => `${value >= 0.005 ? '+' : ''}${fmt(value)}`;

export function renderRiskMarkup(portfolio, assets, name = '') {
  const valid = portfolio && Array.isArray(assets) && assets.length > 0 &&
    Number.isFinite(portfolio.mu) && Number.isFinite(portfolio.vol) && portfolio.vol > 0 &&
    ['weights', 'riskShares', 'riskContributions'].every(key =>
      Array.isArray(portfolio[key]) && portfolio[key].length === assets.length && portfolio[key].every(Number.isFinite));
  if (!valid) return '<div class="panel empty-chart">포트폴리오 계산값 없음</div>';

  const { weights, mu, vol, riskShares, riskContributions } = portfolio;
  const totalWeight = weights.reduce((total, value) => total + value, 0);
  const totalShare = riskShares.reduce((total, value) => total + value, 0);
  const totalContribution = riskContributions.reduce((total, value) => total + value, 0);
  const ratioDefined = weights.every(weight => weight >= 0) && Math.abs(totalWeight - 1) < 1e-8 &&
    assets.every(asset => asset && Number.isFinite(asset.vol) && asset.vol > 0);
  const weightedVol = ratioDefined ? assets.reduce((total, asset, i) => total + weights[i] * asset.vol, 0) : NaN;
  const diversificationRatio = weightedVol / vol;
  const barScale = Math.max(1, ...riskShares.map(Math.abs));

  const rows = assets.map((asset, i) => {
    const share = riskShares[i];
    const width = Math.abs(share) / barScale * 50;
    const left = share < 0 ? 50 - width : 50;
    return `<tr>
      <th scope="row"><i class="legend-dot" style="background:${COLORS[i % COLORS.length]}" aria-hidden="true"></i>${esc(asset?.name)}</th>
      <td>${fmt(weights[i] * 100)}</td>
      <td>${fmt(asset?.vol)}</td>
      <td class="${share < 0 ? 'delta-negative' : ''}">${signed(share * 100)}<span class="risk-contribution-track" aria-hidden="true"><span class="risk-contribution-fill${share < 0 ? ' is-negative' : ''}" style="left:${left}%;width:${width}%"></span></span></td>
      <td class="${riskContributions[i] < 0 ? 'delta-negative' : ''}">${signed(riskContributions[i])}</td>
    </tr>`;
  }).join('');

  return `<div class="risk-summary">
    <article class="panel risk-metric"><span class="metric-caption">연간 변동성</span><strong class="risk-metric-value">${fmt(vol)}<small> %</small></strong></article>
    <article class="panel risk-metric"><span class="metric-caption">연간 수익률 가정</span><strong class="risk-metric-value">${fmt(mu)}<small> %</small></strong></article>
    <article class="panel risk-metric"><span class="metric-caption">분산효과 비율</span><strong class="risk-metric-value">${fmt(diversificationRatio)}<small> 배</small></strong></article>
  </div>
  <div class="risk-detail-grid">
    <article class="panel risk-contributions">
      <div class="panel-heading"><h2>자산별 위험기여도</h2><span class="small accent">${esc(name)}</span></div>
      <div class="table-scroll"><table class="risk-table">
        <thead><tr><th scope="col">자산군</th><th scope="col">비중 %</th><th scope="col">변동성 %</th><th scope="col">위험기여 비중 %</th><th scope="col">변동성 기여 %p</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><th scope="row">합계</th><td>${fmt(totalWeight * 100)}</td><td>—</td><td>${fmt(totalShare * 100)}</td><td>${fmt(totalContribution)}</td></tr></tfoot>
      </table></div>
    </article>
    <article class="panel risk-ranges">
      <div class="panel-heading"><h2>1년 수익률 범위</h2><span class="small">정규분포 가정</span></div>
      <div class="table-scroll"><table class="risk-range-table">
        <thead><tr><th scope="col">포함확률</th><th scope="col">하단 %</th><th scope="col">상단 %</th></tr></thead>
        <tbody>${RANGES.map(([coverage, z]) => `<tr><th scope="row">${coverage}%</th><td>${fmt(mu - z * vol)}</td><td>${fmt(mu + z * vol)}</td></tr>`).join('')}</tbody>
      </table></div>
    </article>
  </div>`;
}
