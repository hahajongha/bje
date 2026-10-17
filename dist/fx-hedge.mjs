const currencies = ['USDKRW', 'AUDKRW', 'JPYKRW', 'EURKRW'];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const format = value => value.toLocaleString('ko-KR', {minimumFractionDigits:2, maximumFractionDigits:2});

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
}

export function normalizeFxHedge(raw) {
  if (raw == null) return {unit:'annual_percent', source:'데이터 미연결', pairs:[]};
  if (typeof raw !== 'object' || !['annual_percent','source_value'].includes(raw.unit) || !Array.isArray(raw.pairs)) {
    throw Error('환헤지 데이터의 단위(annual_percent·source_value)와 pairs 배열을 확인하십시오.');
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
    next.source = String(pair.source ?? raw.source ?? '사용자 스냅샷').slice(0,120);
    if (pair.history != null && (!Array.isArray(pair.history) || pair.history.length > 30000)) throw Error(`${pair.currency} 과거 관측값 배열을 확인하십시오.`);
    next.history = (pair.history ?? []).map((row, i) => {
      if (!row || !validDate(row.date) || row.date > pair.asOf || (i && row.date <= pair.history[i-1].date) || !Number.isFinite(row.value)) throw Error(`${pair.currency} 과거 관측값·날짜 순서를 확인하십시오.`);
      return {date:row.date, value:row.value};
    });
    if (pair.tenorHistory != null && (!Array.isArray(pair.tenorHistory) || pair.tenorHistory.length > 30000)) throw Error(`${pair.currency} 만기별 과거 관측값 배열을 확인하십시오.`);
    const averageByDate = new Map(next.history.map(row => [row.date, row.value]));
    next.tenorHistory = (pair.tenorHistory ?? []).map((row, i) => {
      if (!row || !validDate(row.date) || row.date > pair.asOf || (i && row.date <= pair.tenorHistory[i-1].date)) throw Error(`${pair.currency} 만기별 과거 관측일 순서를 확인하십시오.`);
      const result = {date:row.date};
      for (const key of ['hedge3m', 'hedge6m', 'hedge12m']) {
        if (row[key] != null && !Number.isFinite(row[key])) throw Error(`${pair.currency} 만기별 과거 프리미엄을 확인하십시오.`);
        result[key] = row[key] ?? null;
        if (row.date === next.asOf && ((result[key] == null) !== (next[key] == null) || (result[key] != null && Math.abs(result[key] - next[key]) > 1e-8 * Math.max(1, Math.abs(next[key]))))) throw Error(`${pair.currency} 최신 프리미엄과 만기별 시계열이 일치하지 않습니다.`);
      }
      const values = [result.hedge3m, result.hedge6m, result.hedge12m];
      if (!values.some(Number.isFinite)) throw Error(`${pair.currency} 만기별 과거 관측값이 모두 비어 있습니다.`);
      const average = averageByDate.get(row.date);
      if (average != null && (!values.every(Number.isFinite) || Math.abs(average - values.reduce((sum, value) => sum + value/3, 0)) > 1e-8 * Math.max(1, Math.abs(average)))) throw Error(`${pair.currency} 평균·만기별 과거 시계열이 일치하지 않습니다.`);
      return result;
    });
    const latest = next.history.at(-1);
    const tenors = [next.hedge3m, next.hedge6m, next.hedge12m];
    if (latest?.date === next.asOf && (!tenors.every(Number.isFinite) || Math.abs(latest.value - tenors.reduce((sum,value) => sum + value/3, 0)) > 1e-8 * Math.max(1, Math.abs(latest.value)))) throw Error(`${pair.currency} 최신 프리미엄과 평균 시계열이 일치하지 않습니다.`);
    return next;
  });
  return {unit:raw.unit, source:String(raw.source ?? '사용자 스냅샷').slice(0,120), pairs};
}

export function renderHedgeMarkup(snapshot) {
  return currencies.map(currency => {
    const pair = snapshot.pairs.find(p => p.currency === currency);
    const tenors = pair ? [pair.hedge3m, pair.hedge6m, pair.hedge12m] : [null,null,null];
    const average = tenors.every(Number.isFinite) ? tenors.reduce((sum,value) => sum+value/3,0) : null;
    const rawUnit = snapshot.unit === 'source_value';
    const cards = [
      [rawUnit ? '프리미엄 3M' : '환헤지비용 3M', tenors[0], '', false],
      [rawUnit ? '프리미엄 6M' : '환헤지비용 6M', tenors[1], '', false],
      [rawUnit ? '프리미엄 12M' : '환헤지비용 12M', tenors[2], '', false],
      [rawUnit ? '프리미엄 평균' : '헤지비용 평균', average, '3M·6M·12M 단순평균', false],
      ['환 변동성', pair?.fxVol ?? null, pair?.volPeriod ?? '연환산 σ', true],
    ];
    return `<article class="hedge-currency"><h3>${currency}<span class="small">${pair?.aggregation === 'median_5_business_days' ? '최근 5영업일 중앙값' : '기준일 스냅샷'}</span></h3><div class="hedge-metrics">${cards.map(([label,value,detail,vol]) => {
      const present = Number.isFinite(value);
      const tone = !present ? 'missing' : vol || value === 0 ? '' : value < 0 ? 'negative' : 'positive';
      return `<div class="hedge-card"><h4>${label}</h4><div class="hedge-value ${tone}">${present ? `${!vol && value > 0 ? '+' : ''}${format(value)}${vol || !rawUnit ? '%' : ''}` : '—'}</div><div class="hedge-date">${present ? esc(vol ? pair.volAsOf : pair.asOf) : '데이터 없음'}</div>${detail ? `<div class="small">${esc(detail)}</div>` : ''}</div>`;
    }).join('')}</div></article>`;
  }).join('');
}
