/* 十三州全境舆图渲染内核 —— 由 demos/建安五年全境舆图.html 机械抽出。
   连续场 + 一次性路径生成，无格网平铺、无位图。史料依据见
   docs/十三州全境取数表.md、docs/背景层落地清单.md。
   笔法、连续场、色板、史料主景锚点一字未改；只做两件事：
     1) 图幅 / seed 参数化（战区大地图用官渡图幅，典籍页用十三州全境图幅）；
     2) 去掉 demos 的 DOM 交互与合成，改为返回 bg / fg 两层离屏 canvas，
        由调用方贴到自己的画布。零位图、确定性、无墙钟无随机源。 */
export function createAtlas(opts = {}) {
  const W = opts.W ?? 1400, H = opts.H ?? 1100;
  const LON0 = opts.LON0 ?? 93, LON1 = opts.LON1 ?? 126,
        LAT0 = opts.LAT0 ?? 15, LAT1 = opts.LAT1 ?? 43;           // 图幅：西止玉门、东含乐浪、南含日南
const lon2x = l => (l-LON0)/(LON1-LON0)*W;
const lat2y = t => (LAT1-t)/(LAT1-LAT0)*H;
const x2lon = x => LON0 + x/W*(LON1-LON0);
const y2lat = y => LAT1 - y/H*(LAT1-LAT0);

  let seed = opts.seed ?? 202005;
  const mk = opts.createCanvas ?? (() => mk());

/* ---------- 确定性噪声 ---------- */
function h2(i,j,s){ const n = Math.sin(i*127.1 + j*311.7 + s*74.7)*43758.5453; return n-Math.floor(n); }
function sm(t){ return t*t*(3-2*t); }
function vn(x,y,s){
  const i=Math.floor(x), j=Math.floor(y), fx=sm(x-i), fy=sm(y-j);
  const a=h2(i,j,s), b=h2(i+1,j,s), c=h2(i,j+1,s), d=h2(i+1,j+1,s);
  return (a+(b-a)*fx) + ((c+(d-c)*fx)-(a+(b-a)*fx))*fy;
}
function fbm(x,y,s){ return vn(x,y,s)*.56 + vn(x*2.1,y*2.1,s+3)*.29 + vn(x*4.3,y*4.3,s+7)*.15; }
function rnd(s){ const n=Math.sin(s*12.9898+seed*0.017)*43758.5453; return n-Math.floor(n); }
const clamp=(v,a,b)=>v<a?a:v>b?b:v;
const lerp=(a,b,t)=>a+(b-a)*t;
function mix(c1,c2,t){ return [lerp(c1[0],c2[0],t),lerp(c1[1],c2[1],t),lerp(c1[2],c2[2],t)]; }

/* ---------- 区域权重：南北之别是连续场，不是分区填色 ---------- */
const C_NORTH=[186,168,126], C_SOUTH=[118,148,120], C_DESERT=[214,197,160],
      C_LINGNAN=[152,170,134], C_WET=[92,126,130];
function region(lon,lat){
  // 秦岭—淮河线随经度起伏，过渡带宽 8 度，避免硬切
  const qin = 33.2 + 0.9*Math.sin((lon-104)*0.42) + (lon<112?0.5:0)
              + (fbm(lon*1.3,lat*1.1,seed*.004)-.5)*1.4;
  const south = clamp((qin+1.4-lat)/8.0, 0, 1);
  const desert = clamp((lat-37)/7,0,1)*clamp((108-lon)/14,0,1);
  const lingnan = clamp((25-lat)/10,0,1);
  const wet = clamp(1-Math.abs(lat-30.6)/2.8,0,1)*clamp((lon-104)/9,0,1)*0.42;
  // 密度：中原与江南高，河西/塞北/岭南低；由连续场给出，不按区硬切
  const core = Math.exp(-Math.pow((lat-33.5)/9,2)) * clamp((lon-100)/10,0,1);
  const density = clamp(0.20 + 0.72*core + 0.30*wet - 0.42*desert - 0.30*lingnan
                  + (fbm(lon*.42,lat*.48,seed*.006)-.5)*0.5, 0.06, 1);
  // 风势：连续场决定笔向，相邻区域渐变而非全图同向
  const wind = (fbm(lon*.32,lat*.36,seed*.008)-.5)*2.4 + (south-.5)*0.5;
  return {south,desert:clamp(desert,0,1),lingnan,wet,qin,density,wind};
}
function fieldColor(lon,lat){
  const r=region(lon,lat), n=fbm(lon*0.55, lat*0.62, seed*0.001);
  let c=mix(C_NORTH,C_SOUTH,r.south);
  c=mix(c,C_DESERT,r.desert*0.86);
  c=mix(c,C_LINGNAN,r.lingnan*0.42);
  c=mix(c,C_WET,r.wet*0.48);
  const d=(n-0.5)*38;
  return [clamp(c[0]+d,0,255),clamp(c[1]+d,0,255),clamp(c[2]+d*0.8,0,255), r];
}

/* ---------- 变宽多边形笔：根部聚一点、起粗收尖，一次 fill ---------- */
function brush(g, pts, w0, w1, color, alpha){
  if(pts.length<2) return;
  const L=[], R=[];
  for(let k=0;k<pts.length;k++){
    const p=pts[k], a=pts[Math.max(0,k-1)], b=pts[Math.min(pts.length-1,k+1)];
    let dx=b[0]-a[0], dy=b[1]-a[1]; const m=Math.hypot(dx,dy)||1; dx/=m; dy/=m;
    const t=k/(pts.length-1);
    const w=(lerp(w0,w1,t)) * (0.72+0.42*Math.sin(t*Math.PI));
    L.push([p[0]-dy*w, p[1]+dx*w]); R.push([p[0]+dy*w, p[1]-dx*w]);
  }
  g.beginPath(); g.moveTo(L[0][0],L[0][1]);
  for(let k=1;k<L.length;k++) g.lineTo(L[k][0],L[k][1]);
  for(let k=R.length-1;k>=0;k--) g.lineTo(R[k][0],R[k][1]);
  g.closePath(); g.globalAlpha=alpha; g.fillStyle=color; g.fill(); g.globalAlpha=1;
}
function line(g,pts,color,width,alpha,dash){
  g.beginPath(); g.moveTo(pts[0][0],pts[0][1]);
  for(let k=1;k<pts.length;k++) g.lineTo(pts[k][0],pts[k][1]);
  g.strokeStyle=color; g.lineWidth=width; g.globalAlpha=alpha===undefined?1:alpha;
  if(dash) g.setLineDash(dash); else g.setLineDash([]);
  g.stroke(); g.setLineDash([]); g.globalAlpha=1;
}
function P(arr){
  if(typeof arr[0]==='number') return [lon2x(arr[0]),lat2y(arr[1])];  // 单点锚点
  return arr.map(([l,t])=>[lon2x(l),lat2y(t)]);
}

/* 不规则闭合笔路：取代 ellipse / rect。半径由低频噪声连续给出，一次运笔闭合。 */
function irregular(g,cx,cy,rx,ry,key,fill,stroke,lw){
  const N=26, pts=[];
  for(let k=0;k<N;k++){
    const a=k/N*Math.PI*2;
    const wob=1 + (fbm(Math.cos(a)*1.7+key*3.1, Math.sin(a)*1.7+key*2.3, seed*.005)-.5)*.52
                 + (rnd(key*13+k*2.7)-.5)*.16;
    pts.push([cx+Math.cos(a)*rx*wob, cy+Math.sin(a)*ry*wob]);
  }
  g.beginPath(); g.moveTo(pts[0][0],pts[0][1]);
  for(let k=1;k<N;k++) g.lineTo(pts[k][0],pts[k][1]);
  g.closePath();
  if(fill){ g.fillStyle=fill; g.fill(); }
  if(stroke){ g.strokeStyle=stroke; g.lineWidth=lw||1; g.stroke(); }
  return pts;
}
/* 竖排题名：逐字落笔，带纸白描边，密背景上仍读得出 */
function vlabel(g,txt,x,y,size,color,halo){
  g.textAlign='center'; g.textBaseline='middle'; g.font=`${size}px serif`;
  g.lineWidth=2.6; g.strokeStyle=halo||'rgba(236,228,206,.80)';
  for(let i=0;i<txt.length;i++){
    const yy=y+i*(size+2);
    g.strokeText(txt[i],x,yy); g.fillStyle=color; g.fillText(txt[i],x,yy);
  }
  g.textBaseline='alphabetic';
}
/* 一级朱题：全图只给少数几处，重点靠朱色 + 竖排 + 字级点明 */
function sealLabel(g,txt,x,y){
  const n=txt.length, cy=y+12+(n-1)*17/2;
  irregular(g,x,cy,10,n*9+7,x*.1+y*.07,'rgba(233,227,209,.80)',null,0);
  irregular(g,x,y-2,2.3,2.3,x*.1+y*.07+1,'rgba(166,49,41,.78)',null,0);
  vlabel(g,txt,x,y+12,15,'rgba(116,38,30,.95)','rgba(236,228,206,.92)');
}
/* 二级墨注：有个性但不抢，横排小字 */
function inkNote(g,txt,x,y){
  g.font='10px serif'; g.textAlign='left'; g.lineWidth=2.2;
  g.strokeStyle='rgba(236,228,206,.86)'; g.strokeText(txt,x,y);
  g.fillStyle='rgba(64,52,38,.86)'; g.fillText(txt,x,y);
}
/* 注记引笔：极淡，只在远处主景用，不喧宾夺主 */
function lead(g,from,tx,ty){
  brush(g,[[from[0],from[1]],[(from[0]+tx)/2+3,(from[1]+ty)/2-2],[tx,ty+2]],
        .45,.1,'rgb(150,52,42)',.22);
}
/* 手刻印形：方形但边缘抖动，不是纯 rect（汉印本方，取刻石缺损感） */
function sealBox(g,h,fill,stroke){
  const p=[[-h,-h],[h,-h],[h,h],[-h,h]], pts=[];
  for(let k=0;k<4;k++){
    const a=p[k], b=p[(k+1)%4];
    for(let q=0;q<4;q++){
      const t=q/4;
      pts.push([lerp(a[0],b[0],t)+(rnd(k*13+q*7+h)-.5)*1.8,
                lerp(a[1],b[1],t)+(rnd(k*17+q*3+h)-.5)*1.8]);
    }
  }
  g.beginPath(); g.moveTo(pts[0][0],pts[0][1]);
  for(let k=1;k<pts.length;k++) g.lineTo(pts[k][0],pts[k][1]);
  g.closePath();
  if(fill){ g.fillStyle=fill; g.fill(); }
  if(stroke){ g.strokeStyle=stroke; g.lineWidth=1.3; g.stroke(); }
}

/* ---------- 真实锚点：水系 / 山脉 / 长城 / 州界 ---------- */
const HUANGHE=[[103.2,36.1],[104.6,37.0],[106.2,38.4],[107.6,39.6],[109.0,40.6],[110.4,40.2],
  [111.2,38.6],[112.0,36.6],[113.2,35.1],[113.9,35.3],[114.4,35.6],[114.7,35.7],
  [115.6,36.2],[116.6,36.8],[117.8,37.4],[118.9,38.0]];
const CHANGJIANG=[[104.4,28.8],[105.6,29.2],[106.5,29.6],[108.2,29.9],[110.0,30.4],
  [112.2,30.3],[114.3,30.6],[116.2,29.8],[117.6,30.9],[118.8,32.0],[120.6,31.9],[121.6,31.5]];
const HUAI=[[113.0,32.4],[114.4,32.5],[115.8,32.5],[116.8,32.6],[118.2,32.9],[119.3,33.1],[120.4,33.3]];
const WEI=[[104.3,34.9],[105.6,34.5],[107.0,34.4],[108.4,34.4],[109.6,34.5],[110.3,34.6]];
const HAN=[[106.9,33.1],[108.0,32.7],[110.0,32.4],[111.6,32.0],[112.5,30.9],[114.3,30.6]];
const YING=[[113.0,34.0],[113.6,33.7],[114.0,33.3],[114.6,32.9],[115.2,32.7],[116.8,32.6]];
const SI=[[116.4,35.6],[117.0,34.9],[117.6,34.3],[118.2,33.7],[119.0,33.1]];
const RUOSHUI=[[100.4,39.0],[100.9,40.0],[101.2,41.0],[101.6,41.8]];
const RIVERS=[{p:HUANGHE,w:5.2},{p:CHANGJIANG,w:4.4},{p:HUAI,w:2.7},
  {p:WEI,w:1.8},{p:HAN,w:2.1},{p:YING,w:1.5},{p:SI,w:1.4},{p:RUOSHUI,w:1.4}];

const RIDGES=[
  {name:'秦岭',p:[[104.0,33.9],[105.4,34.1],[106.8,34.2],[108.2,34.1],[109.6,33.9],[110.8,33.6],[112.0,33.4]],a:1.0},
  {name:'太行',p:[[113.2,35.2],[113.8,36.4],[114.2,37.6],[114.6,38.8],[115.0,39.8]],a:0.8},
  {name:'阴山',p:[[106.0,40.7],[107.8,40.9],[109.6,40.9],[111.2,40.8],[112.6,40.6]],a:0.9},
  {name:'祁连',p:[[96.5,38.9],[98.6,38.6],[100.5,38.2],[102.4,37.6],[103.6,36.9]],a:0.7},
  {name:'南岭',p:[[110.0,25.2],[111.8,25.1],[113.6,25.0],[115.2,24.8],[116.4,24.5]],a:0.6},
  {name:'武夷',p:[[117.2,27.6],[118.0,26.8],[118.6,25.9],[119.0,25.0]],a:0.45},
];
const WALLS=[
  {p:[[103.8,35.4],[105.0,36.6],[106.6,37.7],[108.0,39.4],[109.4,40.6],[111.0,40.9],[112.8,40.7],[114.4,40.3],[116.0,40.4],[117.8,40.7],[119.6,40.9],[121.4,40.8],[123.2,40.6]],w:2.0},
  {p:[[106.0,41.8],[108.0,42.0],[110.2,42.0],[112.2,41.8],[114.2,41.6]],w:1.3},   // 光禄塞外线
  {p:[[105.6,41.2],[107.6,41.5],[109.6,41.6],[111.6,41.5]],w:1.1},                // 平行第二道
  {p:[[93.9,40.1],[95.6,39.9],[97.4,39.8],[99.0,39.6],[100.4,39.0],[101.2,41.0],[101.6,41.8]],w:1.5}, // 河西至居延
];
const MARSHES=[
  {n:'圃田泽',l:113.95,t:34.72,rx:0.55,ry:0.30},
  {n:'荥泽',l:113.45,t:34.92,rx:0.30,ry:0.18},
  {n:'大野泽',l:116.05,t:35.40,rx:0.62,ry:0.34},
  {n:'云梦',l:112.60,t:30.10,rx:0.85,ry:0.55},
  {n:'彭蠡',l:116.20,t:29.60,rx:0.55,ry:0.42},
  {n:'震泽',l:120.20,t:31.10,rx:0.42,ry:0.30},
  {n:'居延泽',l:101.60,t:41.90,rx:0.45,ry:0.26},
];
/* 州界为示意朱线，不作考据边界 */
const STATES=[
  {n:'司隶',p:[[108.5,35.6],[110.2,36.0],[112.6,35.6],[113.4,34.0],[112.0,33.4],[110.0,33.2],[108.4,33.6],[108.0,34.6]]},
  {n:'豫州',p:[[112.4,34.4],[114.6,34.6],[116.4,34.4],[117.2,33.2],[116.2,32.0],[114.2,31.8],[113.0,32.8]]},
  {n:'兖州',p:[[114.4,35.8],[116.6,36.0],[117.4,35.0],[116.4,34.4],[114.6,34.6],[113.8,35.2]]},
  {n:'冀州',p:[[113.8,36.0],[115.8,36.4],[116.6,38.0],[115.4,39.2],[113.6,38.6],[113.2,37.2]]},
  {n:'青州',p:[[116.8,36.2],[118.6,36.6],[120.4,37.4],[121.0,36.4],[119.4,35.4],[117.6,35.2]]},
  {n:'徐州',p:[[116.4,34.6],[118.4,34.8],[119.6,34.0],[119.4,32.4],[117.8,32.2],[116.8,33.0]]},
  {n:'并州',p:[[110.4,35.0],[112.6,35.6],[113.6,37.4],[112.8,40.0],[110.6,41.0],[108.6,39.4],[109.4,37.2]]},
  {n:'幽州',p:[[114.0,39.4],[116.4,39.8],[119.6,40.8],[123.6,41.6],[125.8,40.0],[123.0,39.0],[119.0,38.6],[116.0,38.4]]},
  {n:'凉州',p:[[93.9,40.4],[100.0,42.4],[104.0,41.0],[106.0,39.0],[106.4,36.0],[104.6,34.0],[102.0,33.6],[98.0,36.0],[95.0,38.4]]},
  {n:'荆州',p:[[110.4,33.4],[113.0,33.0],[114.8,31.8],[115.6,29.8],[113.6,25.0],[110.6,24.8],[109.2,27.6],[109.8,31.0]]},
  {n:'扬州',p:[[115.4,32.4],[118.4,32.6],[121.4,31.6],[121.0,27.0],[118.0,24.4],[115.6,25.0],[114.6,28.2]]},
  {n:'益州',p:[[97.8,33.0],[102.0,34.0],[106.4,33.4],[109.4,31.0],[107.4,27.0],[104.0,23.6],[100.6,25.0],[98.0,28.6]]},
  {n:'交趾',p:[[108.0,23.4],[111.6,23.6],[113.4,21.6],[110.0,16.0],[107.0,17.2],[105.4,20.0]]},
];
const CAPITALS=[
  {n:'雒阳',l:112.45,t:34.62,k:'capital'}, {n:'谯',l:115.78,t:33.85,k:'capital'},
  {n:'邺',l:114.62,t:36.32,k:'capital'},   {n:'昌邑',l:116.10,t:35.07,k:'capital'},
  {n:'下邳',l:118.02,t:34.31,k:'capital'},{n:'临淄',l:118.31,t:36.83,k:'capital'},
  {n:'蓟',l:116.36,t:39.88,k:'capital'},   {n:'晋阳',l:112.45,t:37.55,k:'capital'},
  {n:'陇县',l:106.20,t:34.98,k:'capital'},{n:'襄阳',l:112.14,t:32.04,k:'capital'},
  {n:'寿春',l:116.79,t:32.58,k:'capital'},{n:'成都',l:104.07,t:30.67,k:'capital'},
  {n:'龙编',l:106.05,t:21.03,k:'capital'},
  {n:'长安',l:108.94,t:34.34,k:'cmd'},     {n:'许',l:113.85,t:34.02,k:'cmd'},
  {n:'宛',l:112.53,t:33.00,k:'cmd'},       {n:'江陵',l:112.24,t:30.33,k:'cmd'},
  {n:'临湘',l:112.94,t:28.23,k:'cmd'},     {n:'建业',l:118.80,t:32.06,k:'cmd'},
  {n:'吴',l:120.62,t:31.30,k:'cmd'},       {n:'山阴',l:120.58,t:30.00,k:'cmd'},
  {n:'南昌',l:115.86,t:28.68,k:'cmd'},     {n:'庐陵',l:114.98,t:27.10,k:'cmd'},
  {n:'番禺',l:113.26,t:23.13,k:'cmd'},     {n:'姑臧',l:102.63,t:37.93,k:'cmd'},
  {n:'张掖',l:100.45,t:38.93,k:'cmd'},     {n:'酒泉',l:98.51,t:39.73,k:'cmd'},
  {n:'敦煌',l:94.66,t:40.14,k:'cmd'},      {n:'狄道',l:103.83,t:35.38,k:'cmd'},
  {n:'冀',l:105.20,t:34.73,k:'cmd'},       {n:'襄平',l:123.16,t:41.13,k:'cmd'},
  {n:'朝鲜',l:125.75,t:39.03,k:'cmd'},     {n:'南郑',l:107.03,t:33.07,k:'cmd'},
  {n:'江州',l:106.55,t:29.56,k:'cmd'},     {n:'滇池',l:102.70,t:24.95,k:'cmd'},
  {n:'广信',l:111.50,t:23.42,k:'cmd'},     {n:'九真',l:105.80,t:19.90,k:'cmd'},
  {n:'象林',l:108.20,t:16.00,k:'cmd'},     {n:'平原',l:116.43,t:37.17,k:'cmd'},
  {n:'彭城',l:117.18,t:34.26,k:'cmd'},     {n:'陈留',l:114.31,t:34.80,k:'cmd'},
  {n:'濮阳',l:115.03,t:35.75,k:'cmd'},     {n:'阳翟',l:113.49,t:34.14,k:'cmd'},
  {n:'平舆',l:114.63,t:33.05,k:'cmd'},     {n:'睢阳',l:115.65,t:34.42,k:'cmd'},
  {n:'郴',l:113.01,t:25.77,k:'cmd'},       {n:'泉陵',l:111.61,t:26.42,k:'cmd'},
];
/* 主景锚点：史料点名、俯视有辨识度的地物。势力层不画（与玩家动态相关）。 */
const LANDMARKS={
  guandu:[114.35,35.00],      // 官渡：依沙塠为屯，东西数十里
  lingtai:[112.47,34.60],     // 雒阳城南灵台、明堂、辟雍
  mangshan:[112.58,34.80],    // 邙山东汉圆丘封土、冢柏
  hanque:[113.04,34.42],      // 阳城登封汉三阙（太室/少室/启母）
  huanyuan:[112.90,34.54],    // 轘辕关十二曲
  putian:[113.95,34.72],      // 圃田泽二十四浦
  jindi:[114.15,35.28],       // 黄河金堤、十里一水门
  yunliang:[113.70,33.90],    // 枣祗河 / 任峻「铜底铁帮运粮河」
  baimajin:[114.35,35.55],    // 白马津、延津浮桥
  wuchao:[114.75,35.45],      // 乌巢粮囷
  juyan:[101.60,41.85],       // 居延塞积薪、苣火
  huojing:[103.50,30.42],     // 蜀郡临邛火井（汉代天然气井）
  jianhu:[120.58,29.98],      // 会稽鉴湖，东汉永和五年马臻筑
};

/* ---------- 背景层：连续底罩 + 一次性扫描游走笔触 ---------- */
function makeBg(){
  const c=mk(); c.width=W; c.height=H;
  const g=c.getContext('2d');
  // 纸底
  g.fillStyle='#e9e3d1'; g.fillRect(0,0,W,H);
  // 连续场底罩：低分辨率生成后平滑放大，无台阶
  const FW=350, FH=275, im=g.createImageData(FW,FH);
  for(let j=0;j<FH;j++) for(let i=0;i<FW;i++){
    const lon=LON0+i/FW*(LON1-LON0), lat=LAT1-j/FH*(LAT1-LAT0);
    const [r,gg,b,reg]=fieldColor(lon,lat);
    const k=(j*FW+i)*4;
    im.data[k]=r; im.data[k+1]=gg; im.data[k+2]=b;
    // 底罩不铺满：密度越低纸透得越多，边地留一丢丢白
    im.data[k+3]=Math.round(255*clamp(0.56+0.44*reg.density,0,1));
  }
  const fc=mk(); fc.width=FW; fc.height=FH;
  fc.getContext('2d').putImageData(im,0,0);
  g.drawImage(fc,0,0,W,H);

  // 图廓：手绘抖笔双线，不用 rect
  function border(inset,wid,col,lw){
    const pts=[];
    const push=(x,y)=>pts.push([x+(rnd(x*.07+y*.13)-.5)*1.8, y+(rnd(x*.11+y*.05)-.5)*1.8]);
    for(let x=inset;x<=W-inset;x+=42) push(x,inset);
    for(let y=inset;y<=H-inset;y+=38) push(W-inset,y);
    for(let x=W-inset;x>=inset;x-=42) push(x,H-inset);
    for(let y=H-inset;y>=inset;y-=38) push(inset,y);
    line(g,pts,col,lw,.7);
  }
  border(14,2,'rgba(120,92,52,.52)',2.0);
  border(21,1,'rgba(120,92,52,.26)',1.0);

  // 泽：不规则岸线（一次闭合笔路）+ 芦苇 + 沙洲，不用 ellipse
  MARSHES.forEach((m,mi)=>{
    const cx=lon2x(m.l), cy=lat2y(m.t), rx=lon2x(m.l+m.rx)-cx, ry=lat2y(m.t)-lat2y(m.t+m.ry);
    irregular(g,cx,cy,rx,ry,mi+7,'rgba(74,120,126,.30)','rgba(56,96,104,.38)',1.1);
    // 岸线再补一道断续水线，笔断意连
    const edge=irregular(g,cx,cy,rx*1.03,ry*1.03,mi+31,null,'rgba(40,80,86,.26)',.9);
    for(let k=0;k<edge.length;k+=3)
      brush(g,[edge[k],[ (edge[k][0]+edge[(k+1)%edge.length][0])/2, (edge[k][1]+edge[(k+1)%edge.length][1])/2 ],edge[(k+2)%edge.length]],.8,.1,'rgba(48,92,98,.4)',.4);
    const cnt=Math.round(26+m.rx*36);
    for(let k=0;k<cnt;k++){
      const a=rnd(k*3.1+m.l)*Math.PI*2, rr=0.52+0.46*rnd(k*5.7+m.t);
      const x=cx+Math.cos(a)*rx*rr, y=cy+Math.sin(a)*ry*rr;
      brush(g,[[x,y-3],[x+1,y-6],[x+2,y-9]],1.2,.15,'#3f6f62',.5);
    }
    for(let k=0;k<3;k++){
      const x=cx+(rnd(k*7.3+m.l)-.5)*rx*1.0, y=cy+(rnd(k*9.1+m.t)-.5)*ry*.9;
      irregular(g,x,y,rx*.17,ry*.19,mi*5+k+3,'rgba(224,210,172,.68)',null,0);
    }
  });

  // 河：双勾岸 + 淡青罩 + 顺流波纹（断续，笔断意连）
  RIVERS.forEach((rv,idx)=>{
    const p=P(rv.p);
    line(g,p,'rgba(66,88,86,.38)',rv.w+2.6,.30);
    line(g,p,'rgba(228,222,202,.50)',rv.w*.86,.45);
    line(g,p,'rgba(86,116,116,.58)',rv.w*.42,.60);
    for(let k=0;k<p.length-1;k++){
      const a=p[k], b=p[k+1], seg=Math.hypot(b[0]-a[0],b[1]-a[1]);
      const n=Math.max(2,Math.round(seg/26));
      for(let q=0;q<n;q++){
        if(rnd(idx*91+k*13+q*2.7)<.34) continue;
        const t=(q+.5)/n, x=lerp(a[0],b[0],t), y=lerp(a[1],b[1],t);
        brush(g,[[x-6,y+1],[x-1,y],[x+5,y-1]],.8,.12,'rgba(60,110,118,.6)',.55);
      }
    }
  });

  // 山脉骨架：沿脊线一次性山脉带 + 顺坡短笔
  RIDGES.forEach((rg,idx)=>{
    const p=P(rg.p);
    // 山脉带
    g.beginPath(); g.moveTo(p[0][0],p[0][1]-8*rg.a);
    for(let k=0;k<p.length;k++){
      const q=p[k], wob=Math.sin(k*2.1+idx)*5*rg.a;
      g.lineTo(q[0],q[1]-9*rg.a+wob);
    }
    for(let k=p.length-1;k>=0;k--) g.lineTo(p[k][0],p[k][1]+9*rg.a);
    g.closePath(); g.fillStyle='rgba(96,104,84,.30)'; g.fill();
    line(g,p,'rgba(72,78,62,.72)',1.6*rg.a,.8);
    // 顺坡皴：方向随脊线法向，长度随起伏变
    for(let k=0;k<p.length-1;k++){
      const a=p[k], b=p[k+1], seg=Math.hypot(b[0]-a[0],b[1]-a[1]);
      const n=Math.round(seg/12);
      for(let q=0;q<n;q++){
        const t=(q+.5)/n, x=lerp(a[0],b[0],t), y=lerp(a[1],b[1],t);
        const side=(q%2?1:-1), len=(9+8*rnd(idx*33+k*7+q))*rg.a;
        brush(g,[[x,y],[x+2*side,y+len*.5],[x+4*side,y+len]],1.5,.12,'rgba(66,74,58,.55)',.55);
      }
    }
  });

  // 地表笔触：不等距扫描游走，笔型 / 密度 / 方向全由连续场决定
  let y=8, ri=0;
  while(y<H-8){
    let x=-18+rnd(y*.37)*32;
    while(x<W+18){
      const lon=x2lon(x), lat=y2lat(y), [,, ,r]=fieldColor(lon,lat);
      const n=fbm(lon*1.7,lat*1.9,seed*.002);
      const dens=r.density;
      const step=lerp(26,8,dens)+rnd(x*.13+y*.07)*8;
      // 边地留白：密度越低越常跳笔，白从笔缝里连续漏出
      if(rnd(x*.031+y*.017) > 0.30+0.68*dens){ x+=step*.7; continue; }
      const ang=r.wind+(n-.5)*1.35+(rnd(x*.019+y*.023)-.5)*.6,
            ca=Math.cos(ang), sa=Math.sin(ang);
      const rot=(dx,dy)=>[x+dx*ca-dy*sa, y+dx*sa+dy*ca];
      // 笔型按场权重概率混合：过渡带里两套笔交错，不出现硬切线
      const pick=rnd(x*.053+y*.021+n*3.1);
      const wDesert=r.desert*0.86, wLing=r.lingnan*0.60, wSouth=r.south*0.92;
      if(pick < wDesert || (lat>40.5 && n>.55)){
        // 沙碛 / 塞北：极稀的横向短弧，笔数最少
        if(n>.34) brush(g,[rot(-9,0),rot(0,-2),rot(10,1)],.9,.12,'rgba(150,126,88,.40)',.42);
      } else if(pick < wDesert+wLing){
        // 岭南：疏点，不铺满
        if(n>.46){
          g.beginPath(); g.arc(x,y,1.2+rnd(x*.7)*1.3,0,Math.PI*2);
          g.fillStyle='rgba(88,110,80,.40)'; g.fill();
        }
      } else if(pick < wDesert+wLing+wSouth){
        // 南方：田块只在低频高值区成簇，且随风向倾斜、时有缺笔
        const cluster=fbm(lon*.72,lat*.83,seed*.011);
        if(cluster>.44 && rnd(x*.33+y*.19)>.20){
          // 田埂只是一组平行短笔，缺笔、倾斜、绝不闭合成方框
          const s=3+rnd(x*.21)*5, rows=3+Math.floor(rnd(x*.41)*2);
          for(let i=0;i<rows;i++){
            if(rnd(x*.53+i*7.1)>.22) continue;
            const dy=i*2.4-s*.6;
            brush(g,[rot(-s*.9,dy),rot(0,dy-.4),rot(s*.8,dy+.3)],.62,.1,'rgba(64,104,80,.46)',.46);
          }
        } else {
          brush(g,[rot(-3,3),rot(0,-3),rot(4,2)],1.2,.14,'rgba(46,88,68,.52)',.48);
        }
      } else {
        // 北方：横向燥笔束（战后荒田，短、断、稀）
        const c = n>.55 ? 'rgba(56,76,62,.58)' : 'rgba(126,100,64,.50)';
        const L=5+rnd(x*.19)*6;
        const dy=Math.sin(ang)*2;
        brush(g,[rot(-L,dy),rot(0,dy-1),rot(L,dy+.5)],1.6,.12,c,.52);
        if(n>.72) brush(g,[rot(-2,3),rot(0,0),rot(3,-3)],1.0,.1,'rgba(50,70,56,.5)',.44);
      }
      x+=step;
    }
    y += 9+rnd(ri*7.3)*8; ri++;
  }
  return c;
}

/* ---------- 地物层 ---------- */
function makeFg(){
  const c=mk(); c.width=W; c.height=H;
  const g=c.getContext('2d');

  // 势力层不画：归属随玩家局内动态变化，由上层逻辑负责，背景只给地与物。

  // 州界朱线（示意）
  STATES.forEach((s,si)=>{
    const p=P(s.p);
    // 沿折线按弧长抖点断续落笔，首尾不闭合：读成朱线，不是多边形
    for(let k=0;k<p.length-1;k++){
      const a=p[k], b=p[k+1], seg=Math.hypot(b[0]-a[0],b[1]-a[1])||1;
      let t=0.02;
      while(t<0.97){
        const t2=Math.min(0.97,t+(7+rnd(si*17+k*5+t*73)*10)/seg);
        if(rnd(si*29+k*11+t*151)>.44){
          const j=q=>[lerp(a[0],b[0],q)+(rnd(q*97+si)-.5)*3.6,
                      lerp(a[1],b[1],q)+(rnd(q*83+si*3)-.5)*3.6];
          brush(g,[j(t),j((t+t2)/2),j(t2)],.68,.15,'rgb(150,52,42)',.22);
        }
        t=t2;
      }
    }
    const c=p[0]; g.font='12px serif'; g.textAlign='left';
    g.lineWidth=2.4; g.strokeStyle='rgba(236,228,206,.75)'; g.strokeText(s.n,c[0]+5,c[1]+14);
    g.fillStyle='rgba(140,58,44,.72)'; g.fillText(s.n,c[0]+5,c[1]+14);
  });

  // 长城三重 + 沿线烽燧
  WALLS.forEach((w,idx)=>{
    const p=P(w.p);
    line(g,p,'rgba(84,68,48,.75)',w.w+1.6,.7);
    line(g,p,'rgba(214,198,160,.62)',w.w*.5,.55,[9,5]);
    for(let k=0;k<p.length-1;k++){
      const a=p[k],b=p[k+1],seg=Math.hypot(b[0]-a[0],b[1]-a[1]);
      let t=0.02+rnd(k*3.7+idx)*0.05;
      while(t<0.98){
        if(idx<=1 && rnd(k*11.3+t*97+idx)>.44){
          const x=lerp(a[0],b[0],t)+(rnd(t*211)-.5)*4;
          const y=lerp(a[1],b[1],t)+(rnd(t*173)-.5)*4;
          beacon(g,x,y,idx,rnd(t*311));
        }
        t += (46+rnd(k*7.1+t*131)*52)/seg;   // 不等距，不再像等距图章
      }
    }
  });

  /* ========== 主景：史料点名、俯视有辨识度，各自单独画，不复制图章 ==========
     重点由朱色竖题 + 字级 + 引笔点明，不靠画框。势力一概不画。 */

  // ① 官渡（一级主景）：依沙塠为屯，东西数十里；土山高橹、霹雳车、地道—长堑
  const gd=P(LANDMARKS.guandu), gx=gd[0], gy=gd[1];
  const span=62, war=[];
  for(let k=0;k<=18;k++) war.push([gx-span+2*span*k/18, gy-15+(rnd(k*2.7)-.5)*5]);
  for(let k=0;k<war.length-1;k+=2)
    brush(g,[war[k],war[k+1],war[Math.min(k+2,war.length-1)]],1.7,.3,'rgb(122,86,52)',.72);  // 袁营深沟
  for(let k=0;k<=18;k++) war[k]=[war[k][0], war[k][1]+30+(rnd(k*4.3)-.5)*4];
  for(let k=0;k<war.length-1;k+=2)
    brush(g,[war[k],war[k+1],war[Math.min(k+2,war.length-1)]],1.5,.25,'rgb(46,78,62)',.70);  // 曹营长堑
  for(let k=0;k<9;k++){                                   // 营垒：不规则圈，大小不一、不等距
    const x=gx-58+k*14+(rnd(k*5.9)-.5)*6, y=gy-22+(rnd(k*3.1)-.5)*4;
    irregular(g,x,y,3+rnd(k*7)*2.4,2.2+rnd(k*11)*1.6,k+41,null,'rgb(150,110,62)',1.0);
    irregular(g,x+2,y+31,2.6+rnd(k*13)*2,2+rnd(k*17)*1.4,k+83,null,'rgb(46,78,62)',.95);
  }
  for(let k=0;k<18;k++){                                  // 沙堆：断续短弧笔
    const x=gx-60+rnd(k*7.7)*120, y=gy-8+rnd(k*3.9)*7;
    brush(g,[[x-7,y],[x,y-3],[x+8,y]],1.5,.2,'rgb(176,142,94)',.62);
  }
  // 霹雳车（发石车）：不规则木架 + 石堆，曹营侧
  const pcx=gx-16, pcy=gy+20;
  brush(g,[[pcx-7,pcy+4],[pcx,pcy-6],[pcx+7,pcy+3]],1.6,.3,'rgb(74,60,42)',.85);
  brush(g,[[pcx-6,pcy+3],[pcx+1,pcy-1],[pcx+7,pcy+4]],1.1,.2,'rgb(74,60,42)',.7);
  for(let q=0;q<5;q++) irregular(g,pcx+12+(rnd(q*3)*9),pcy+2+(rnd(q*7)*6),
      1.2+rnd(q*11),1+q%2,200+q,'rgb(96,90,76)',null,0);
  // 土山高橹：袁营侧不规则台 + 竖橹
  irregular(g,gx+22,gy-26,7,4,311,'rgba(150,118,74,.62)','rgb(110,84,52)',1);
  brush(g,[[gx+22,gy-29],[gx+23,gy-38],[gx+22,gy-44]],1.3,.3,'rgb(74,60,42)',.85);
  // 地道—长堑：两道平行浅笔
  brush(g,[[gx-34,gy+1],[gx-10,gy+2],[gx+12,gy+1]],1.1,.2,'rgb(92,76,56)',.55);
  brush(g,[[gx-32,gy+6],[gx-9,gy+7],[gx+14,gy+6]],.9,.15,'rgb(46,78,62)',.5);
  sealLabel(g,'官渡',gx-2,gy-56);

  // ② 雒阳城南灵台 / 明堂 / 辟雍：夯土高台，太史令候望之所
  const lt=P(LANDMARKS.lingtai);
  irregular(g,lt[0],lt[1],7,5.2,401,'rgba(158,138,102,.72)','rgb(96,80,56)',1.1);
  irregular(g,lt[0],lt[1],3.6,2.6,402,'rgba(214,196,158,.72)',null,0);
  for(let q=0;q<9;q++){
    const a=q/9*Math.PI*2, x=lt[0]+Math.cos(a)*11, y=lt[1]+Math.sin(a)*8;
    brush(g,[[x,y+2],[x,y-2],[x+.6,y-5]],1,.15,'rgb(52,76,58)',.62);
  }
  lead(g,lt,lt[0]-36,lt[1]-38); sealLabel(g,'灵台',lt[0]-36,lt[1]-38);

  // ③ 邙山东汉圆丘封土：由覆斗改圆丘，高不足二十米、径七十至百三十米，环植柏
  const ms=P(LANDMARKS.mangshan);
  for(let q=0;q<4;q++){
    const x=ms[0]+(q-1.5)*13, y=ms[1]+(rnd(q*3.7)-.5)*5;
    irregular(g,x,y,4.6+rnd(q*5)*2,3.2+rnd(q*7)*1.4,410+q,'rgba(168,146,106,.68)','rgb(104,86,60)',1);
    for(let t=0;t<7;t++){
      const a=t/7*Math.PI*2;
      brush(g,[[x+Math.cos(a)*7,y+Math.sin(a)*5+1],[x+Math.cos(a)*7,y+Math.sin(a)*5-2],
               [x+Math.cos(a)*7+.5,y+Math.sin(a)*5-5]],.8,.12,'rgb(48,72,54)',.55);
    }
  }
  lead(g,ms,ms[0]+32,ms[1]-30); inkNote(g,'邙陵',ms[0]+32,ms[1]-30);

  // ④ 阳城汉三阙（太室 / 少室 / 启母，东汉延光年间）：一对石垛，中留阙道
  const hq=P(LANDMARKS.hanque);
  irregular(g,hq[0]-6,hq[1],2.4,5.4,421,'rgba(146,136,116,.82)','rgb(78,70,56)',1);
  irregular(g,hq[0]+6,hq[1],2.2,5.0,422,'rgba(146,136,116,.82)','rgb(78,70,56)',1);
  brush(g,[[hq[0]-4,hq[1]+6],[hq[0],hq[1]+7],[hq[0]+4,hq[1]+6]],.8,.15,'rgb(120,104,78)',.6);
  lead(g,hq,hq[0]+26,hq[1]+18); inkNote(g,'汉阙',hq[0]+26,hq[1]+18);

  // ⑤ 轘辕关十二曲：山道折返十二次，一次性笔路
  const hy=P(LANDMARKS.huanyuan); const road=[];
  for(let k=0;k<=12;k++) road.push([hy[0]-16+k*2.7, hy[1]-12+k*1.9+(k%2?4:-4)]);
  brush(g,road,1.5,.25,'rgb(88,74,54)',.72);
  irregular(g,hy[0]+18,hy[1]+10,3.4,2.6,431,'rgba(150,120,82,.7)','rgb(84,68,48)',1);
  lead(g,[hy[0]-14,hy[1]-10],hy[0]-32,hy[1]+16); inkNote(g,'轘辕',hy[0]-32,hy[1]+16);

  // ⑥ 圃田泽二十四浦：由泽心分汊的一次性短笔，长短不一
  const pt=P(LANDMARKS.putian);
  for(let k=0;k<16;k++){
    const a=k/16*Math.PI*2+rnd(k*3.3)*.3, len=8+rnd(k*7.1)*14;
    brush(g,[[pt[0]+Math.cos(a)*3,pt[1]+Math.sin(a)*2],
             [pt[0]+Math.cos(a)*len*.55,pt[1]+Math.sin(a)*len*.4],
             [pt[0]+Math.cos(a)*len,pt[1]+Math.sin(a)*len*.7]],.8,.1,'rgb(56,100,104)',.46);
  }
  inkNote(g,'二十四浦',pt[0]+22,pt[1]+22);

  // ⑦ 黄河金堤 / 十里一水门：断续夯土线 + 不等距斗门（不画成闸门阵列）
  const jd=P(LANDMARKS.jindi);
  const dike=[]; for(let k=0;k<=10;k++) dike.push([jd[0]-30+k*6, jd[1]+Math.sin(k*.9)*3]);
  for(let k=0;k<dike.length-1;k+=2)
    brush(g,[dike[k],dike[k+1],dike[Math.min(k+2,dike.length-1)]],1.3,.25,'rgb(146,118,78)',.62);
  [2,6,9].forEach((k,qi)=>{
    const x=dike[k][0], y=dike[k][1];
    irregular(g,x,y,2+qi*.5,2.6+qi*.4,440+qi,'rgba(214,198,160,.8)','rgb(96,78,54)',1);
    brush(g,[[x,y+3],[x+1,y+7],[x,y+9]],.7,.15,'rgb(74,60,42)',.6);
  });
  inkNote(g,'金堤',jd[0]-52,jd[1]-14);

  // ⑧ 枣祗河 / 任峻「铜底铁帮运粮河」：带名字的渠 + 陡门
  const yl=P(LANDMARKS.yunliang);
  const canal=[[yl[0]-22,yl[1]+8],[yl[0]-8,yl[1]+3],[yl[0]+6,yl[1]+2],[yl[0]+22,yl[1]-4]];
  brush(g,canal,1.5,.2,'rgb(70,108,104)',.62);
  [1,3].forEach((k,qi)=>{
    const x=canal[k][0], y=canal[k][1];
    brush(g,[[x-3,y-4],[x,y-1],[x+3,y-4]],.9,.2,'rgb(96,82,56)',.75);
  });
  inkNote(g,'运粮河',yl[0]-26,yl[1]+20);

  // ⑨ 白马津 / 延津浮桥：一排不连的舟 + 缆笔，非江南石拱
  const bm=P(LANDMARKS.baimajin);
  brush(g,[[bm[0]-24,bm[1]+2],[bm[0],bm[1]+1],[bm[0]+24,bm[1]+2]],.8,.2,'rgb(92,76,52)',.6);
  for(let k=0;k<6;k++){
    const x=bm[0]-20+k*8+(rnd(k*3.3)-.5)*2;
    brush(g,[[x-3,bm[1]],[x,bm[1]-2.4],[x+3.4,bm[1]]],1.1,.3,'rgb(96,74,52)',.8);
  }
  inkNote(g,'白马津',bm[0]+30,bm[1]-18);

  // ⑩ 乌巢粮囷：圆形囷（非方屋）+ 晒场笔
  const wc=P(LANDMARKS.wuchao);
  for(let q=0;q<5;q++){
    const x=wc[0]-12+q*6, y=wc[1]+(rnd(q*5.1)-.5)*4;
    irregular(g,x,y,2.4+rnd(q*7)*.8,2.2+rnd(q*11)*.6,450+q,'rgba(196,170,124,.76)','rgb(104,82,56)',1);
  }
  for(let k=0;k<5;k++)
    brush(g,[[wc[0]-14, wc[1]+8+k*1.6],[wc[0],wc[1]+7+k*1.6],[wc[0]+15,wc[1]+8+k*1.6]],.6,.1,'rgb(128,104,70)',.45);
  inkNote(g,'乌巢',wc[0]+26,wc[1]+14);

  // ⑪ 居延塞积薪：《塞上烽火品约》积薪重两吨、外涂泥沙，苣火夜举
  const jy=P(LANDMARKS.juyan);
  for(let q=0;q<4;q++)
    irregular(g,jy[0]+(rnd(q*3.7)-.5)*9,jy[1]+(rnd(q*7.1)-.5)*5,
      3+rnd(q*5)*2,2+q*.4,460+q,'rgba(138,116,82,.72)','rgb(84,68,48)',.9);
  brush(g,[[jy[0]+9,jy[1]-3],[jy[0]+10,jy[1]-9],[jy[0]+9,jy[1]-14]],1.4,.3,'rgb(166,49,41)',.8);
  sealLabel(g,'积薪',jy[0]-22,jy[1]-20);

  // ⑫ 蜀郡临邛火井：汉代已见记载的天然气井，井口 + 井架 + 一点幽火
  const hj=P(LANDMARKS.huojing);
  irregular(g,hj[0],hj[1],3.2,2.6,470,'rgba(196,180,146,.82)','rgb(84,68,48)',1);
  brush(g,[[hj[0]-5,hj[1]+2],[hj[0],hj[1]-9],[hj[0]+5,hj[1]+2]],1.1,.2,'rgb(78,64,46)',.8);
  brush(g,[[hj[0]-4,hj[1]-7],[hj[0]+4,hj[1]-7]],.8,.15,'rgb(78,64,46)',.7);
  brush(g,[[hj[0]-1,hj[1]-3],[hj[0]+.5,hj[1]-7],[hj[0]+1.5,hj[1]-11]],1,.25,'rgb(166,49,41)',.75);
  inkNote(g,'火井',hj[0]+9,hj[1]+4);

  // ⑬ 会稽鉴湖：东汉永和五年（140）马臻筑，不规则湖 + 断续堤塘 + 斗门
  const jh=P(LANDMARKS.jianhu);
  irregular(g,jh[0],jh[1],14,7,471,'rgba(74,120,126,.30)','rgba(56,96,104,.36)',1);
  const dh=[]; for(let k=0;k<=8;k++) dh.push([jh[0]-15+k*3.8, jh[1]+8+Math.sin(k*.8)*1.6]);
  for(let k=0;k<dh.length-1;k+=2)
    brush(g,[dh[k],dh[k+1],dh[Math.min(k+2,dh.length-1)]],.9,.15,'rgb(120,100,68)',.62);
  for(let k=0;k<3;k++)
    irregular(g,jh[0]-9+k*9,jh[1]+9,1.6,1.8,480+k,'rgba(214,198,160,.8)','rgb(96,78,54)',.9);
  inkNote(g,'鉴湖',jh[0]+18,jh[1]+12);

  // 州治 / 郡治分级：不规则墨点 + 竖排（州治）/ 横注（郡治），不用方块
  CAPITALS.forEach((p,idx)=>{
    const x=lon2x(p.l), y=lat2y(p.t);
    if(p.k==='capital'){
      irregular(g,x,y,5.4,4.8,500+idx,'rgba(238,230,208,.88)','rgb(72,56,36)',1.5);
      irregular(g,x,y,7.6,6.8,600+idx,null,'rgb(200,168,106)',.8);
      vlabel(g,p.n,x,y-16,12,'rgba(38,32,24,.94)','rgba(236,228,206,.9)');
    } else {
      irregular(g,x,y,2.2,2.0,700+idx,'rgb(72,60,42)',null,0);
      g.fillStyle='rgba(52,44,32,.72)'; g.font='10px serif'; g.textAlign='center';
      g.lineWidth=2; g.strokeStyle='rgba(236,228,206,.65)'; g.strokeText(p.n,x,y-6);
      g.fillText(p.n, x, y-6);
    }
  });

  // 题识、比例尺、朱印（随图走，不悬在纸外）
  g.textAlign='left';
  const tt=(s,x,y,f,c)=>{ g.font=f; g.lineWidth=3.2; g.strokeStyle='rgba(236,228,206,.92)';
    g.strokeText(s,x,y); g.fillStyle=c; g.fillText(s,x,y); };
  tt('建安五年 · 十三州全境', 36, 56, 'bold 24px serif','rgba(40,34,26,.92)');
  tt('西止玉门 · 东含乐浪 · 南尽日南 · 纵横不拘实距', 38, 78, '12px serif','rgba(72,60,44,.86)');
  tt('朱题三：官渡连营 · 雒阳灵台 · 居延积薪（余景见墨注）', 38, 96, '11px serif','rgba(116,50,38,.84)');
  // 比例尺：断续短笔刻度，不用贯通直线
  const sx=W-236, sy=H-92;
  for(let k=0;k<12;k++){
    const x=sx+k*15;
    brush(g,[[x,sy],[x+7,sy-.4],[x+14,sy]],.8,.2,'rgb(60,50,36)',.8);
    if(k%3===0) brush(g,[[x,sy-3],[x+.5,sy],[x,sy+3]],.7,.15,'rgb(60,50,36)',.8);
  }
  g.fillStyle='rgba(60,50,36,.85)'; g.font='11px serif'; g.textAlign='center';
  g.fillText('约千里',sx+90,sy-8);
  // 朱印：手刻缺损边，方形但非纯几何 rect
  g.save(); g.translate(W-72,H-158); g.rotate(-.04);
  sealBox(g,22,'rgba(166,49,41,.82)','rgba(243,231,210,.8)');
  sealBox(g,18,null,'rgba(243,231,210,.55)');
  g.fillStyle='#f3e7d2'; g.font='bold 19px serif'; g.textAlign='center';
  g.fillText('建安',0,-2); g.fillText('五年',0,17); g.restore();
  return c;
}
function beacon(g,x,y,idx,k){
  const s=3.0+k*2.4;                      // 大小不一
  g.save(); g.translate(x,y);
  sealBox(g,s,'rgba(226,210,172,.85)','rgba(78,62,42,.82)');
  g.restore();
  irregular(g,x-s-1,y-s-2,1.1,1.1,900+k+x*.01,'rgb(78,62,42)',null,0);  // 角楼
  irregular(g,x+s-.6,y-s-2,1.1,1.1,910+k+y*.01,'rgb(78,62,42)',null,0);
  if(idx===0 && k>.62){                 // 积薪：仅部分台有
    brush(g,[[x,y-s-2],[x+1,y-s-5],[x+1,y-s-9]],.9,.2,'rgb(120,96,64)',.55);
  }
}

  // 战区大地图只要背景层：地物（城郭/关津/领地/朱题）由游戏上层按局内状态动态画，
  // 不重复贴一遍 fg。典籍页的「十三州全境舆图」才要 bg + fg 全份。
  const bg = makeBg();
  const fg = opts.fg === false ? null : makeFg();
  return { bg, fg, W, H, lon2x, lat2y, x2lon, y2lat };
}

