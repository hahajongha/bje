const currencies = ['USDKRW', 'AUDKRW', 'JPYKRW', 'EURKRW'];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const format = value => value.toLocaleString('ko-KR', {minimumFractionDigits:2, maximumFractionDigits:2});

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
}

export function normalizeFxHedge(raw) {
  if (raw == null) return {source:'데이터 미연결', pairs:[]};
  if (typeof raw !== 'object' || raw.unit !== 'annual_percent' || !Array.isArray(raw.pairs)) {
    throw Error('환헤지 데이터의 단위(annual_percent)와 pairs 배열을 확인하십시오.');
  }
  const seen = new Set();
  const pairs = raw.pairs.map(pair => {
    if (!pair || !currencies.includes(pair.currency) || seen.has(pair.currency)) throw Error('환헤지 통화는 USDKRW·AUDKRW·JPYKRW·EURKRW 중 중복 없이 지정하십시오.');
    seen.add(pair.currency);
    if (!validDate(pair.asOf)) throw Error(`${pair.currency} 기준일을 확인하십시오.`);
    const next = {currency:pair.currency, asOf:pair.asOf};
    for (const key of ['hedge3m', 'hedge6m', 'hedge12m', 'fxVol']) {
      const value = pair[key];
      if (value != null && (typeof value !== 'number' || !Number.isFinite(value) || (key === 'fxVol' && value < 0))) {
        throw Error(`${pair.currency} ${key} 값을 확인하십시오.`);
      }
      next[key] = value ?? null;
    }
    if (pair.volAsOf != null && !validDate(pair.volAsOf)) throw Error(`${pair.currency} 변동성 기준일을 확인하십시오.`);
    next.volAsOf = pair.volAsOf ?? pair.asOf;
    next.volPeriod = String(pair.volPeriod ?? '기간 미지정').slice(0,80);
    if (pair.aggregation != null && !['snapshot','median_5_business_days'].includes(pair.aggregation)) throw Error('환헤지 집계방식을 확인하십시오.');
    next.aggregation = pair.aggregation ?? 'snapshot';
    return next;
  });
  return {source:String(raw.source ?? '사용자 스냅샷').slice(0,120), pairs};
}

export function renderHedgeMarkup(snapshot) {
  return currencies.map(currency => {
    const pair = snapshot.pairs.find(p => p.currency === currency);
    const tenors = pair ? [pair.hedge3m, pair.hedge6m, pair.hedge12m] : [null,null,null];
    const average = tenors.every(Number.isFinite) ? tenors.reduce((sum,value) => sum+value/3,0) : null;
    const cards = [
      ['환헤지비용 3M', tenors[0], '', false],
      ['환헤지비용 6M', tenors[1], '', false],
      ['환헤지비용 12M', tenors[2], '', false],
      ['헤지비용 평균', average, '3M·6M·12M 단순평균', false],
      ['환 변동성', pair?.fxVol ?? null, pair?.volPeriod ?? '연환산 σ', true],
    ];
    return `<article class="hedge-currency"><h3>${currency}<span class="small">${pair?.aggregation === 'median_5_business_days' ? '최근 5영업일 중앙값' : '기준일 스냅샷'}</span></h3><div class="hedge-metrics">${cards.map(([label,value,detail,vol]) => {
      const present = Number.isFinite(value);
      const tone = !present ? 'missing' : vol || value === 0 ? '' : value < 0 ? 'negative' : 'positive';
      return `<div class="hedge-card"><h4>${label}</h4><div class="hedge-value ${tone}">${present ? `${!vol && value > 0 ? '+' : ''}${format(value)}%` : '—'}</div><div class="hedge-date">${present ? esc(vol ? pair.volAsOf : pair.asOf) : '데이터 없음'}</div>${detail ? `<div class="small">${esc(detail)}</div>` : ''}</div>`;
    }).join('')}</div></article>`;
  }).join('');
}
