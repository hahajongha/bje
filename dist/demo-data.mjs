// Synthetic assumptions only. Private Drive data must never be committed here.
export const demoData = {
  schemaVersion:1,
  meta:{
    demo:true,
    dataFingerprint:'bje-demo-seven-assets-v2',
    assumptionStatus:'illustrative',
    notes:[
      '모든 수치는 기능 설명을 위한 가상 입력입니다. 실제 시장 자료나 보유현황이 아닙니다.',
      '국내시가·해외시가·국내주식·해외주식은 기존 데모의 국내 종합채권·미국 국채·국내 주식·미국 주식 가정을 각각 이어받았습니다.',
      '국내장부·해외장부·대체투자의 수익률과 변동성은 새로 설정한 가상 가정입니다. 장부 자산의 변동성은 모형의 위험 입력이며 회계상 장부가 변동성의 실측치가 아닙니다.',
      '상관행렬은 기존 네 자산의 상관구조에 가상 공통 노출과 독립 잔차를 추가해 구성했습니다. 실제 시계열에서 추정하지 않았습니다.'
    ]
  },
  assets:[
    {id:'kr_bond',name:'국내시가',group:'bond',mu:3.4,vol:3.8,weight:.25},
    {id:'kr_book_bond',name:'국내장부',group:'bond',mu:3.2,vol:2.2,weight:.15},
    {id:'foreign_bond',name:'해외시가',group:'bond',mu:4.2,vol:11.0,weight:.15},
    {id:'foreign_book_bond',name:'해외장부',group:'bond',mu:4.0,vol:5.0,weight:.1},
    {id:'kr_equity',name:'국내주식',group:'equity',mu:7.0,vol:20.0,weight:.1},
    {id:'foreign_equity',name:'해외주식',group:'equity',mu:8.0,vol:18.0,weight:.15},
    {id:'alternatives',name:'대체투자',group:'alternative',mu:6.0,vol:12.0,weight:.1}
  ],
  // Added categories are linear exposures to the four retained demo assets
  // plus independent residuals. Each diagonal is 1; no market series is implied.
  correlation:[
    [1,.65,.3,.185,.05,.05,.06],
    [.65,1,.195,.12025,.0325,.0325,.039],
    [.3,.195,1,.61,-.1,.1,.11],
    [.185,.12025,.61,1,-.005,.16,.11575],
    [.05,.0325,-.1,-.005,1,.55,.4325],
    [.05,.0325,.1,.16,.55,1,.4975],
    [.06,.039,.11,.11575,.4325,.4975,1]
  ]
};
