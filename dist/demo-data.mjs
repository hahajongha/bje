// Synthetic assumptions only. Private Drive data must never be committed here.
export const demoData = {
  schemaVersion:1,
  meta:{demo:true,dataFingerprint:'bje-demo-v1',notes:['모든 수치는 기능 설명을 위한 가상 입력입니다.']},
  assets:[
    {id:'kr_bond',name:'국내 종합채권',mu:3.4,vol:3.8,weight:.35},
    {id:'kr_equity',name:'국내 주식',mu:7.0,vol:20.0,weight:.1},
    {id:'us_equity',name:'미국 주식',mu:8.0,vol:18.0,weight:.2},
    {id:'us_treasury',name:'미국 국채',mu:4.2,vol:11.0,weight:.15},
    {id:'us_credit',name:'미국 IG',mu:5.0,vol:12.0,weight:.1},
    {id:'usd_bills',name:'달러 단기채',mu:3.8,vol:10.0,weight:.1}
  ],
  correlation:[
    [1,.05,.05,.3,.25,.1],
    [.05,1,.55,-.1,.2,-.1],
    [.05,.55,1,.1,.35,.2],
    [.3,-.1,.1,1,.65,.55],
    [.25,.2,.35,.65,1,.5],
    [.1,-.1,.2,.55,.5,1]
  ]
};
