# BJE Portfolio Lab

자산배분 대시보드입니다. 허용 GitHub 대상은 **hahajongha/bje**이며 확인된 기본 브랜치는 **main**입니다. 다른 프로젝트 코드나 설정을 가져오지 않고 새로 작성했습니다.

## 기능

- 현재 비중, 최소분산, 목표수익률, 최대 Sharpe 비교
- 결정적인 활성집합 전수 계산에 의한 효율적 경계선
- 비중 변경, 위험기여 비중, 정규모형의 1년 실현수익률 범위
- 자산별 기대수익률·변동성·비중·상관계수·무위험금리 편집
- 원화 총수익 추이, 1년/3년/5년 표시, CSV 내보내기
- 브라우저별 가정 저장, JSON 스냅샷 가져오기, 반응형 화면

정적 HTML/CSS/ES modules이며 외부 JavaScript·폰트·CDN 의존성이 없습니다. `dist/`를 정적 호스팅으로 제공하면 됩니다. 웹 서버 없이 HTML을 직접 여는 `file://` 실행은 지원하지 않습니다.

## 데이터 경계

**공개 소스의 `dist/data.json`과 `dist/demo-data.mjs`에는 가상 입력만 있습니다.** 실제 Drive Excel, 실제 수익률, Drive 파일 ID와 접근 토큰은 이 소스 묶음에 없습니다. 실제 데이터가 들어간 배포는 비공개를 유지해야 합니다. 실제 데이터를 공개 `dist/data.json`에 덮어써 커밋하지 마십시오.

스냅샷을 읽지 못하면 데모 표시와 오류 안내를 보여 줍니다. 자동 Drive 동기화 기능은 없습니다. JSON 가져오기는 브라우저 메모리에서 처리하며 업로드하지 않습니다. 가져온 스냅샷은 새로고침하면 기본 데이터로 돌아갑니다. 사용자가 적용한 투자 가정만 해당 스냅샷별로 localStorage에 저장됩니다.

## 계산

`dist/portfolio.mjs`의 공개 함수:

- `covariance(assets, correlation)` — 연간 %p² 공분산
- `stats(weights, assets, cov, rf)` — 수익률, 변동성, Sharpe, 부호 있는 위험기여
- `optimize(assets, cov, rf, target)` — minVol/maxSharpe/target/frontier
- `validateInputs(assets, correlation)` — 유한수·대칭·상관범위·양의 정부호 검증

`assets.mu`, `assets.vol`, `rf`, `target`은 연간 퍼센트 단위입니다(5 = 5%). 비중은 소수입니다(0.2 = 20%). 무차입·공매도 금지·비중 합 100%이며 자산별 상한은 없습니다. 2~8개 자산을 지원합니다. 변동성 0과 특이 상관행렬은 조용히 보정하지 않고 거절합니다.

월별 단순수익률 산술평균 × 12, 표본공분산 × 12로 연율화합니다. 이는 월별 자기상관을 무시한 근사입니다. 효율적 경계선은 최소분산 포트폴리오 이상의 수익률 구간입니다. 불가능한 목표는 `null`을 반환합니다. 모든 초과수익률이 0 이하이면 최대 Sharpe는 최선의 단일자산을 선택합니다.

1년 구간은 정규분포 가정의 실현수익률 범위이며 기대수익률 추정치의 신뢰구간이 아닙니다. 과거 평균은 전망이 아니고, 표본 내 최적화는 표본 외 성과를 입증하지 않습니다. 비중과 2.50% 무위험금리는 초기 예시입니다.

## 원자료 변환

Python `numpy`, `openpyxl`을 사용하며 Excel을 읽기만 합니다. 제공기관의 add-in을 새로고침하지 않습니다.

```bash
python scripts/build_data.py --info /private/data_info.xlsx --bb /private/data_bb.xlsx --as-of 2026-10-15 --months 60 --output /private/portfolio.json
```

공개 저장소 안에 원본 또는 결과를 두면 실행을 거절합니다. 생성한 JSON을 사이트의 데이터 노트에서 가져올 수 있습니다.

| 자산 | 파일 / 시트 / 열 | 통화 처리 |
| --- | --- | --- |
| 국내 종합채권 | data_info / DailyRate / JO | KIS 총수익, 원화 |
| 국내 주식 | data_bb / D / FX | KOSPI 총수익, 원화 |
| 미국 주식 | data_bb / D / FW 및 BB | S&P 500 USD 총수익 × USDKRW |
| 미국 국채 | data_bb / D / GP | IEF 총수익, 원자료 CURR=KRW |
| 미국 투자등급 | data_bb / D / GR | LQD 총수익, 원자료 CURR=KRW |
| 달러 단기채 | data_bb / D / GT | BIL 총수익, 원자료 CURR=KRW |

ETF 세 열은 이미 원화 입력이므로 환율을 다시 곱하지 않습니다. 헤더·통화 요청 수식이 바뀌면 변환을 거절합니다. 같은 날짜의 공통 값으로 월별 마지막 관측을 선택하며 현재 진행 중인 월은 제외합니다. 보간하지 않습니다. 달력상 월말에서 7일을 초과한 관측이나 빠진 월은 거절합니다. 국가별 거래시간과 휴장일 반복값은 남을 수 있습니다. 데이터 제공기관의 독립 원자료 대조는 미수행입니다.

실제 JSON 스키마는 `assets[].annualMean/annualVol/currentWeight` 소수 단위, `correlation` 2차원 배열입니다. `meta.periodStart/periodEnd/observations`가 표본을 나타냅니다. `monthly.returns`는 `monthly.dates`와 대응하고, `monthly.base100`은 초기 관측을 포함하는 `monthly.baseDates`와 대응합니다. 모든 2차원 시계열 배열은 시점 × 자산 순서입니다.

## 검증

```bash
node --test tests/*.test.mjs
BJE_TEST_DATA=/private/portfolio.json node --test tests/ui-smoke.test.mjs
```

수학 테스트는 두 자산 해석해, 역분산 해, 별도 격자탐색, 비정부호·특이행렬, 경계목표, 음의 Sharpe와 위험기여를 포함합니다. UI smoke는 Node의 DOM 대역에서 실제 앱 로직과 이벤트를 실행하며 브라우저 레이아웃·접근성·픽셀 검증을 대체하지 않습니다.

이번 환경에는 지원되는 브라우저 제어 경로가 없어 실제 화면 렌더링 검증은 수행하지 못했습니다.

## 저장소 운영

2026-10-16 연결 앱의 접근 승인 반영 후 `hahajongha/bje` 쓰기를 확인했습니다. 기본 브랜치는 `main`이며, 구현은 별도 기능 브랜치의 Pull Request로 검토합니다. 머지는 사용자가 요청할 때 수행합니다.
