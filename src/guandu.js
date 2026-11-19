/* 建安五年 · 官渡舆图（航拍林冠背景层 + 史料地物层）
 * 由 demos/官渡舆图笔势重绘.html 的绘制内核机械抽出，函数体与常量一字未改。
 * 只做三件事：
 *   1) 去掉 demos 的 DOM / 交互 / compose，改成返回 bg、feat 两层离屏 canvas；
 *   2) 引入 MIT 笔触原语（src/ink-stroke.js，见 demos/third-party/ATTRIBUTION.md）；
 *   3) 按 map-data.js 的游戏图幅算出裁切矩形，保证与 144×108 逻辑格精确对齐。
 * 确定性：seed 固定、无墙钟、无 Math.random、无位图。
 */
import { InkStroke } from './ink-stroke.js';
import { LON_MIN as G_LON_MIN, LON_MAX as G_LON_MAX,
         LAT_MIN as G_LAT_MIN, LAT_MAX as G_LAT_MAX } from './map-data.js';


const { rgba, resample, frames, ribbon, hardRibbon } = InkStroke;

  const W = 1200, H = 880, PAD = 46, SS = 2;   // SS：离屏层超采样，放大时不糊
  let ctx = null;                               // 工厂里指向 bg / feat 离屏层

  // 背景层与地物层各渲一次到离屏，缩放/平移只做合成 —— 否则每帧要重画
  // 上万个树冠团，滚轮会卡死。格网很便宜，按当前 zoom 实时画。
  let bg, feat, bgCtx, featCtx;
  let mk = () => document.createElement('canvas');

  const CELL = 42, MAJOR = 5;                  // 逻辑格距 / 每几格一条主格线
  let baseSeed = 20261116, seed = baseSeed;
  let showGrid = true;                         // 按需求：格子默认压上去
  let showFeatures = true;
  const view = { zoom:1, panX:0, panY:0 };
  let K = 1;                                   // CSS px / 世界单位
  let raf = 0;

  // ── 确定性随机 ────────────────────────────────────────────────────────
  const rnd = () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rr = (a,b) => a + (b-a)*rnd();
  const h1 = k => { const v = Math.sin(k*127.1 + seed*0.000131)*43758.5453; return v-Math.floor(v); };
  const clamp=(v,a,b)=>v<a?a:v>b?b:v;

  // ── 经纬度锚点 · 按 docs/扩大范围历史地理取数表.md 逐条落 ─────────────
  // 图幅由 112.75~116.15 / 32.65~36.65 扩到 112.30~116.75 / 32.30~36.95。
  // 四向各有史料依据（洛阳东门户 / 大野泽 / 邺与太行南段 / 汝颍上游），
  // 不是为对称而扩。今地方位均为近似，非考古复原；出处见取数表。
  const LON_MIN=112.30, LON_MAX=116.75, LAT_MIN=32.30, LAT_MAX=36.95;

  const CITIES = [
    ['许都',113.85,34.03,1],['邺',114.40,36.30,1],['汝南',114.36,33.01,2],
    ['陈留',114.53,34.66,2],['黎阳',114.55,35.68,2],['濮阳',115.03,35.75,2],
    ['阳翟',113.52,34.14,2],['谯县',115.78,33.85,2],['中牟',114.03,34.72,3],
    ['白马',114.45,35.55,3],['延津',114.20,35.15,3],['官渡',114.00,34.55,4],
  ];
  // 扩大后补入的四处有出处地点只作**地标**，不塞进 CITIES：
  // 否则十六座完整城郭 + 各自城外清场会在中部叠成一片浅田「挖洞」。
  const LANDMARKS = [
    ['洛阳',112.48,34.62],   // 虎牢「洛阳东门户」；《理惑论》洛阳城西雍门外佛寺
    ['荥阳',113.42,34.79],   // 荥泽「西起荥阳以东二十里」；王景自荥阳东筑堤
    ['浚仪',114.32,34.80],   // 《宋史·河渠志》大梁浚仪西北复分二渠
    ['阳武',113.98,35.06],   // 官渡水「经阳武县中牟台下」；袁绍军进阳武
  ];
  // 乌巢不单列为城：仅挂一处粮囤地物（「绍辎重囤集乌巢」）
  const GRANARIES = [[114.28,34.93,'乌巢']];
  /* 全境台账 13 处主景里，落在本作战区图幅内、此前未画的一组。
     坐标沿用本层近似投影，不与全境版混用；每处单独写一次性笔路。
     势力、点景亭台、楼阁牌坊一概不画。 */
  const SCENES = [
    // 前两处按示意投影略向东收，使游戏裁切窗口（112.75~116.15）内也能看到；
    // 雒阳本体在窗口外，礼制区与邙山只作方位示意，不作定点考据。
    ['灵台',112.86,34.62],  // 雒阳城南灵台 / 明堂 / 辟雍，太史令候望之所
    ['邙陵',113.00,34.90],  // 东汉圆丘封土、墓侧植柏
    ['汉阙',113.22,34.30],  // 阳城太室 / 少室 / 启母三阙，中留阙道
    ['轘辕',113.08,34.42],  // 轘辕山道十二折
    ['战具',114.00,34.55],  // 官渡：土山高橹 / 霹雳车发石 / 地道—长堑
  ];

  const HUANGHE = [
    // 西段补到荥阳北：「荥泽下分大河为阴沟」、王景自荥阳东筑堤千里
    [112.40,34.88],[112.60,34.92],[112.78,34.98],[113.05,35.02],[113.35,35.10],
    [113.62,35.16],[113.88,35.12],[114.20,35.15],[114.42,35.48],[114.55,35.68],
    [114.86,35.74],[115.18,35.78],[115.48,36.02],[115.78,36.25],[116.10,36.48],
    [116.40,36.62],
  ];
  const RIVERS_MINOR = [
    {name:'颍水',w:1.6,pts:[[113.08,32.45],[113.10,33.20],[113.30,33.55],[113.48,33.90],[113.62,34.12],[113.85,34.28],[114.10,34.40]]},
    {name:'汝水',w:1.6,pts:[[113.82,32.35],[113.90,32.70],[114.10,32.95],[114.36,33.15],[114.62,33.40],[114.82,33.72],[115.05,33.95]]},
    {name:'鸿沟',w:1.5,pts:[[113.55,34.30],[113.78,34.42],[114.00,34.55],[114.22,34.62],[114.53,34.66]]},
    {name:'官渡水',w:1.2,pts:[[114.32,34.80],[114.20,34.72],[114.08,34.64],[114.00,34.55]]},
    // 潩水/济水不画：前者与许下渠线重叠、后者与黄河西段重合，画上只会糊成一团
    {name:'淇水',w:1.3,pts:[[114.05,36.70],[114.25,36.20],[114.40,35.90],[114.55,35.68]]},
    {name:'荡水',w:1.1,pts:[[114.15,36.45],[114.32,36.32],[114.40,36.30]]},
  ];
  // 建安元年许下屯田所开运粮河，兼灌溉；「灌沟南北二口俱有陡门」。
  // 人工渠比天然河更直、更细、赭土色，是第三套地貌成因，不并入 RIVERS_MINOR。
  // 今地方位近似，见取数表 §3；不宣称精确里程。
  const CANALS = [
    {name:'枣祗河',pts:[[113.88,34.00],[113.98,33.90],[114.08,33.80],[114.22,33.74]]},
    {name:'玛瑙河',pts:[[113.52,33.86],[113.72,33.82],[113.90,33.80],[114.08,33.78]]},
    {name:'高底河',pts:[[113.90,34.12],[113.96,34.00],[113.93,33.90],[113.88,33.82]]},
    {name:'灌沟',  pts:[[113.84,33.72],[113.88,33.82],[113.90,33.92],[113.92,34.02]]},
  ];
  const LAKES = [
    {name:'圃田泽',lon:113.90,lat:34.80,rx:.20,ry:.10},
    {name:'荥泽',  lon:113.30,lat:35.02,rx:.14,ry:.08},
    // 校正：大野泽地望在今山东巨野北，旧值 115.62,35.42 偏西
    {name:'大野泽',lon:116.05,lat:35.40,rx:.28,ry:.15},
  ];
  // 航拍视角下这些不再是「要画的山」，只是地形场的隆起轴：
  // 看不到峰头、立面、皴，只有由它决定的林冠深浅。
  // 删去旧「历山坞」：今地异说多（取数表 C 级），改接太行南段延伸，不臆造专名。
  const RIDGES = [
    {name:'嵩箕林',h:.92,sig:118,pts:[[112.82,33.55],[113.02,33.90],[113.12,34.28],[113.05,34.62],[113.22,34.92]]},
    {name:'箕山坞',h:.74,sig:96, pts:[[113.28,33.35],[113.52,33.62],[113.66,33.95],[113.55,34.20]]},
    {name:'太行林',h:.96,sig:132,pts:[[114.05,36.70],[114.35,36.40],[114.62,36.18],[114.86,35.95],[115.10,35.80],[115.40,36.30],[115.62,36.10]]},
  ];
  // 官渡沙堆：建安五年「依沙堆为营攻曹，曹军也立营相距」，是微地形不是建筑。
  // 刻意落在城郭之外，免得被营垒的托光与方框盖掉。
  const SAND_AXES = [
    [113.88,34.50],[114.12,34.48],[113.84,34.64],[114.16,34.62],[114.00,34.40],
  ];
  const PASSES = [
    ['虎牢关',113.18,34.82,'pass'],['轘辕关',113.08,34.42,'pass'],
    ['延津渡',114.20,35.15,'ford'],['白马津',114.45,35.55,'ford'],
    ['黎阳津',114.55,35.68,'ford'],['濮阳津',115.03,35.75,'ford'],
    ['官渡口',114.00,34.55,'ford'],
  ];
  const ROAD_HINTS = [
    ['许都','陈留',[[113.95,34.20],[114.20,34.42],[114.45,34.58]]],
    ['许都','汝南',[[113.95,33.78],[114.10,33.48],[114.25,33.20]]],
    ['许都','谯县',[[114.20,33.90],[114.60,33.82],[115.10,33.80],[115.50,33.84]]],
    ['官渡','延津',[[114.06,34.80],[114.14,35.00]]],
    ['黎阳','邺',[[114.48,35.92],[114.42,36.10]]],
  ];
  // 有史料依据的前线/军屯据点：这些聚落换坞堡形制，其余仍用田舍
  const MILITARY = new Set(['官渡','黎阳','白马','延津']);

  const proj = (lon,lat) => [
    PAD + (lon-LON_MIN)/(LON_MAX-LON_MIN)*(W-2*PAD),
    PAD + (1-(lat-LAT_MIN)/(LAT_MAX-LAT_MIN))*(H-2*PAD),
  ];
  const PXY = p => proj(p[0],p[1]);

  // ── 连续地形场 ────────────────────────────────────────────────────────
  // 预采样成一张低分辨率场图，查询用双线性插值。
  // 这是「一次性连续函数」，不是格网单元：场图只作采样缓存，不参与绘制决策的
  // 重复单元。所有笔触位置由「带 carry 的等高游走」给出，不是遍历场图格子。
  const FW=241, FH=177, DX=W/(FW-1), DY=H/(FH-1);
  let FIELD=null, WET=null, OPEN=null, SAND=null;
  let AXES=[], WATER_AXES=[], CITY_PTS=[], LAKE_PTS=[], SAND_PTS=[];

  function segDist2(x,y,P){
    let best=1e12;
    for(let i=0;i<P.length-1;i++){
      const a=P[i],b=P[i+1],vx=b[0]-a[0],vy=b[1]-a[1];
      const t=clamp(((x-a[0])*vx+(y-a[1])*vy)/(vx*vx+vy*vy||1),0,1);
      const dx=x-(a[0]+t*vx),dy=y-(a[1]+t*vy);
      const q=dx*dx+dy*dy; if(q<best)best=q;
    }
    return best;
  }
  function buildField(){
    AXES=RIDGES.map(r=>({P:r.pts.map(PXY),h:r.h,sig:r.sig,name:r.name}));
    WATER_AXES=[{P:resample(HUANGHE.map(PXY),7),sig:30},
                ...RIVERS_MINOR.map(r=>({P:resample(r.pts.map(PXY),7),sig:22}))];
    LAKE_PTS=LAKES.map(l=>{const p=proj(l.lon,l.lat);return {x:p[0],y:p[1],rx:l.rx/(LON_MAX-LON_MIN)*(W-2*PAD),ry:l.ry/(LAT_MAX-LAT_MIN)*(H-2*PAD)};});
    CITY_PTS=CITIES.map(c=>{const p=proj(c[1],c[2]);return {x:p[0],y:p[1],r:c[3]===1?76:c[3]===2?64:c[3]===3?56:48};});
    SAND_PTS=SAND_AXES.map(PXY);

    const raw=new Float32Array(FW*FH), wet=new Float32Array(FW*FH),
          op=new Float32Array(FW*FH), snd=new Float32Array(FW*FH);
    const off=seed*0.000017;
    for(let j=0;j<FH;j++) for(let i=0;i<FW;i++){
      const x=i*DX, y=j*DY, k=j*FW+i;
      let e=0;
      for(const a of AXES) e+=a.h*Math.exp(-segDist2(x,y,a.P)/(2*a.sig*a.sig));
      // 低频连续起伏：让林冠有沟谷与受光背阴，不是几团椭圆
      e+=.20*Math.sin(x*.0061+y*.0043+off)*Math.cos(y*.0072-x*.0031+off*.7);
      e+=.11*Math.sin(x*.0134-y*.0089+2.1+off);
      e+=.07*Math.sin(x*.021+y*.017+.6);
      // 河谷下切：水切进林，场值降低
      let wmax=0;
      for(const a of WATER_AXES){
        const d2=segDist2(x,y,a.P);
        const g=Math.exp(-d2/(2*a.sig*a.sig));
        wmax=Math.max(wmax,g); e-=.34*g;
      }
      for(const l of LAKE_PTS){
        const d2=((x-l.x)/l.rx)**2+((y-l.y)/l.ry)**2;
        wmax=Math.max(wmax,Math.exp(-d2*1.1)); e-=.22*Math.exp(-d2*1.4);
      }
      // 城外清场：只留一圈紧凑的浅田，范围别摊开成大片空场
      let o=0;
      for(const c of CITY_PTS){
        // 清场只给紧凑一圈浅田；上一版 sigma 偏大，几座城叠起来在中部
        // 连成一大片纯纸白，读成"挖了个洞"而不是"城外开阔地"。
        const g=Math.exp(-((x-c.x)**2+(y-c.y)**2)/(2*(c.r*.48)**2));
        o=Math.max(o,g); e-=.16*g;
      }
      // 图廓内侧渐疏，留一丢丢纸
      const edge=Math.min(x-24,W-24-x,y-24,H-24-y);
      if(edge<30) o=Math.max(o,(30-edge)/30*.72);
      // 官渡沙堆：几组低矮断续沙岗，被中频项切开，不是规则圆饼。
      // 单独成场，不去动 e —— 否则全局 min/max 归一化会让整幅林冠色阶漂移。
      let sd=0;
      for(const s of SAND_PTS){
        const d2=(x-s[0])**2+(y-s[1])**2;
        // 叠一层高频：边缘由植被破碎地退让，不是高斯圆斑的软边
        const m=.52+.30*Math.sin(x*.031+y*.024+off*3)*Math.cos(y*.027-x*.019)
                   +.18*Math.sin(x*.071-y*.053+1.7)*Math.cos(x*.043+y*.061);
        const g=Math.exp(-d2/(2*40*40))*(.48+.52*m);
        sd=Math.max(sd,g);
      }
      // 非线性响应：低值不赭、高值才露干土，边界明确但不硬
      sd=smooth(.18,.72,sd);
      // 沙洲只在泽里漏，不把整条河岸清空（沙洲由 lakes() 单独画）
      raw[k]=e; wet[k]=wmax; op[k]=clamp(o,0,1); snd[k]=clamp(sd,0,1);
    }
    let mn=1e9,mx=-1e9;
    for(let k=0;k<raw.length;k++){ if(raw[k]<mn)mn=raw[k]; if(raw[k]>mx)mx=raw[k]; }
    for(let k=0;k<raw.length;k++) raw[k]=clamp((raw[k]-mn)/(mx-mn||1),0,1);
    FIELD=raw; WET=wet; OPEN=op; SAND=snd;
  }
  const bil=(A,x,y)=>{
    const gx=clamp(x/DX,0,FW-1.001), gy=clamp(y/DY,0,FH-1.001);
    const i=gx|0,j=gy|0,fx=gx-i,fy=gy-j,k=j*FW+i;
    return A[k]*(1-fx)*(1-fy)+A[k+1]*fx*(1-fy)+A[k+FW]*(1-fx)*fy+A[k+FW+1]*fx*fy;
  };
  const field=(x,y)=>bil(FIELD,x,y);
  const wetness=(x,y)=>bil(WET,x,y);
  const openness=(x,y)=>bil(OPEN,x,y);
  const sand=(x,y)=>bil(SAND,x,y);
  const grad=(x,y)=>[
    (field(x+5,y)-field(x-5,y))/10,
    (field(x,y+5)-field(x,y-5))/10,
  ];

  // ── 纸：保留，但压低对比，让它只在缝里被看见 ───────────────────────────
  function paper() {
    const g=ctx.createLinearGradient(0,0,W,H);
    g.addColorStop(0,'#ece3cd'); g.addColorStop(.42,'#e6ddc6');
    g.addColorStop(.78,'#e9e0ca'); g.addColorStop(1,'#e1d8c0');
    ctx.fillStyle=g; ctx.fillRect(0,0,W,H);
    for (let i=0;i<18;i++) {
      const x=rr(-100,W+100),y=rr(-80,H+80),r=rr(150,380);
      const q=ctx.createRadialGradient(x,y,0,x,y,r);
      q.addColorStop(0,rgba(rnd()>.5?'#fffaf0':'#a3976f',rr(.008,.022)));
      q.addColorStop(1,'rgba(0,0,0,0)');
      ctx.fillStyle=q; ctx.fillRect(x-r,y-r,r*2,r*2);
    }
  }

  // ── 图廓 ──────────────────────────────────────────────────────────────
  function border() {
    ctx.strokeStyle='rgba(95,84,58,.58)'; ctx.lineWidth=1.2;
    ctx.strokeRect(16,16,W-32,H-32);
    ctx.strokeStyle='rgba(95,84,58,.30)'; ctx.lineWidth=.8;
    ctx.strokeRect(23,23,W-46,H-46);
    const L=22;
    ctx.strokeStyle='rgba(140,112,62,.66)'; ctx.lineWidth=1.5;
    for (const [x,y,sx,sy] of [[16,16,1,1],[W-16,16,-1,1],[16,H-16,1,-1],[W-16,H-16,-1,-1]]) {
      ctx.beginPath();
      ctx.moveTo(x+sx*L,y); ctx.lineTo(x,y); ctx.lineTo(x,y+sy*L);
      ctx.moveTo(x+sx*9,y+sy*9); ctx.lineTo(x+sx*9,y+sy*L*.7); ctx.lineTo(x+sx*L*.7,y+sy*9);
      ctx.stroke();
    }
  }
  // ── 格网 LOD：按缩放级别决定画多少，缩太小就隐去 ──────────────────────
  // 判据用 zoom 而不是绝对屏幕像素：K 随视口宽变，手机上默认视图的格子
  // 本来就比桌面密，用绝对 px 会让窄屏一打开就看不到格子。zoom 是相对
  // 整幅图的倍率，任何视口下「缩到 0.36 倍以下就太密」都成立。
  // 三层过渡，不做硬开关，避免缩放时格子突然跳没：
  //   zoom >= .90  细格 + 主格全显
  //   .69 ~ .90    细格渐隐，主格保留（抽稀，每 5 格一条）
  //   .36 ~ .69    只剩主格并渐隐
  //   zoom < .36   全部隐藏 —— 防止线糊成一片灰
  // 与地图本体同处一个变换，所以是「压上去」的层；线宽按 1/(K*zoom) 补偿，
  // 缩放时保持恒定屏幕粗细，不会跟着地图变粗变细。
  const smooth = (a,b,v) => {
    const t = clamp((v-a)/(b-a||1),0,1);
    return t*t*(3-2*t);
  };
  function gridOverlay() {
    if (!showGrid) return 0;
    const z = view.zoom;
    const fine = smooth(.52,.90,z), major = smooth(.36,.69,z);
    if (fine<=.001 && major<=.001) return z;

    const x0=26, x1=W-26, y0=23, y1=H-23;
    const unit = 1/(K*view.zoom);
    // 同一色同一批线合成一条 path 一次 stroke，缩放时成本可忽略
    const set=(every,color,alpha,lw)=>{
      if (alpha<=.002) return;
      ctx.beginPath();
      for(let x=x0,i=0;x<x1;x+=CELL,i++) if(i%every===0){ ctx.moveTo(x,y0); ctx.lineTo(x,y1); }
      for(let y=y0,i=0;y<y1;y+=CELL,i++) if(i%every===0){ ctx.moveTo(x0,y); ctx.lineTo(x1,y); }
      ctx.strokeStyle=`rgba(${color},${alpha.toFixed(3)})`;
      ctx.lineWidth=lw*unit; ctx.stroke();
    };
    ctx.save();
    // 双色：墨底压在浅田上看得见，亮金线压在深林上看得见
    if (fine>.001) {
      set(1,'28,38,32', .20*fine, .95);
      set(1,'238,228,196', .17*fine, .50);
    }
    if (major>.001) {
      set(MAJOR,'26,36,30', .30*major, 1.5);
      set(MAJOR,'244,232,198', .44*major, .85);
    }
    ctx.restore();
    return z;
  }

  // ── 竖排小字 ──────────────────────────────────────────────────────────
  function vertical(text,x,y,size,col,alpha,sp) {
    const step=size*(sp||1.12);
    ctx.save();
    ctx.font=`${size}px "WenQuanYi Micro Hei","Noto Serif CJK SC",serif`;
    ctx.textAlign='center'; ctx.textBaseline='top';
    for (let i=0;i<text.length;i++) {
      ctx.fillStyle=rgba(col,alpha);
      ctx.fillText(text[i],x,y+i*step);
    }
    ctx.restore();
  }

  // ── 林冠色：连续色阶，不是离散色片 ────────────────────────────────────
  // 上一版用一串 if 把场值切成 7 档、每档两个随机色，放大后就是一片片
  // 边界清晰的同色块 —— 那本身就是"色块平铺"。改成锚点间线性插值，
  // 湿度/受光/树种只做连续小幅偏移，色相没有台阶，笔与笔之间也没有色界。
  const CANOPY = [
    [0.00,[176,150, 98]],  // 浅田赭黄（仍是笔色，不是纸白）
    [0.16,[164,142, 96]],
    [0.30,[138,134, 92]],
    [0.46,[108,126, 92]],
    [0.62,[ 72, 96, 72]],
    [0.80,[ 48, 74, 70]],
    [1.00,[ 34, 56, 56]],  // 深林墨青
  ];
  function canopyRGB(e,w,lit,sp){
    let i=0; while(i<CANOPY.length-2 && CANOPY[i+1][0]<e) i++;
    const a=CANOPY[i], b=CANOPY[i+1];
    const t=clamp((e-a[0])/(b[0]-a[0]||1),0,1);
    let r=a[1][0]+(b[1][0]-a[1][0])*t,
        g=a[1][1]+(b[1][1]-a[1][1])*t,
        bb=a[1][2]+(b[1][2]-a[1][2])*t;
    // 湿度往花青偏，受光往赭黄提，都是连续的，不做阈值切换
    r-=w*22; g+=w*2;  bb+=w*18;   // 湿林往花青偏，与赭黄田拉开冷暖
    r+=lit*9; g+=lit*7; bb-=lit*5;
    // 树种微扰：只在同一色阶内轻微摆动，不再二选一换整块色
    const q=(sp||0)*2-1;
    return [r+q*4, g+q*5, bb+q*3];
  }
  function palette(e,w,lit,sp){
    const [r,g,bb]=canopyRGB(e,w,lit,sp);
    const hx=v=>clamp(Math.round(v),0,255).toString(16).padStart(2,'0');
    return `#${hx(r)}${hx(g)}${hx(bb)}`;   // rgba() 工具只认 hex
  }

  // 风势：整片林冠的笔都顺场梯度的法向摆，而不是各自随机。
  // 画面里仍然没有"山"，但笔势会顺着脊轴与沟谷走，山势因此被读出来。
  // 加一层中频项，让相邻区域的笔势连续渐变 —— 否则全图同向，会读成
  // 另一种纹样平铺（上一版放大后像"撒了一层竹叶"就是栽在这儿）。
  function windAt(x,y){
    const [gx,gy]=grad(x,y);
    return Math.atan2(-gx,gy+1e-6)*.22
         + Math.sin(x*.0042+y*.0031+seed*.000013)*.34
         + Math.sin(x*.011-y*.008+1.7)*.26;
  }

  // ── 连续场薄罩：工笔的「先罩底色，再叠笔」 ────────────────────────────
  // 笔改细之后必然留缝，白底会从缝里大面积回到画面（实测露纸 45%）。
  // 这不是把纸盖住，而是按地理铺一层连续底色：深林处罩得沉、浅田处罩得淡、
  // 沙洲与城外环几乎不罩 —— 白只从场值低的地方连续地漏一丢丢。
  // 做法是把场图直接写成 FW×FH 的 ImageData 再放大绘制：浏览器双线性插值
  // 得到完全连续、没有台阶也没有重复单元的一层，不是色块也不是渐变贴图。
  function fieldWash(){
    const small=mk();
    small.width=FW; small.height=FH;
    const sc=small.getContext('2d');
    const img=sc.createImageData(FW,FH);
    for(let j=0;j<FH;j++) for(let i=0;i<FW;i++){
      const k=j*FW+i, p=k*4;
      const e=FIELD[k], ww=WET[k], o=OPEN[k], sd=SAND[k];
      const gx=(FIELD[k+(i<FW-1?1:0)]-FIELD[k-(i>0?1:0)])*.5;
      const lit=clamp(.5-gx*9,0,1);
      const [r0,g0,b0]=canopyRGB(e,ww,lit,h1(i*.37+j*.61));
      // 官渡沙堆：底罩往赭土偏、罩得更实 —— 是「露出干土」，不是「露出纸」。
      const r=r0+(164-r0)*sd*.92, g=g0+(138-g0)*sd*.92, b=b0+(100-b0)*sd*.92;
      // 深林沉、浅田淡；即使留白意愿最高处也留一层极淡赭底，
      // 白只从场值低的地方连续地漏一丢丢，不出现硬边空场。
      const a=clamp((.20+e*.44+ww*.06)*(1-o*.60)+.07+sd*.17,0,.78);
      img.data[p]=clamp(r,0,255); img.data[p+1]=clamp(g,0,255);
      img.data[p+2]=clamp(b,0,255); img.data[p+3]=a*255;
    }
    sc.putImageData(img,0,0);
    ctx.save();
    ctx.imageSmoothingEnabled=true;
    ctx.imageSmoothingQuality='high';
    ctx.drawImage(small,0,0,W,H);   // 低分辨率场 → 全幅，连续无台阶
    ctx.restore();
  }

  // 变宽短笔：起粗收尖的一次运笔，顶点累积进调用方的 path，
  // 不新建 Path2D、不逐笔 fill —— 上万团仍能一次 fill 完成。
  function brush(path,x0,y0,x1,y1,w0,w1){
    const dx=x1-x0, dy=y1-y0, L=Math.hypot(dx,dy)||1;
    const nx=-dy/L, ny=dx/L;
    path.moveTo(x0+nx*w0, y0+ny*w0);
    path.lineTo(x0-nx*w0, y0-ny*w0);
    path.lineTo(x1-nx*w1, y1-ny*w1);
    path.lineTo(x1+nx*w1, y1+ny*w1);
    path.closePath();
  }

  // ── 一个树冠团：顺场风势的一次运笔，不是方硬色片 ─────────────────────
  // 放大到 ×3 后点彩感的根源有两个：色板是离散档（已改连续插值），团是
  // 一个闭合五边形（像小色片）。这里换成「根部聚一点、起粗收尖」的变宽短笔，
  // 笔向由连续场梯度给的主风势 + 扇形展开，三套笔型按场值连续混合而不是
  // 分档切换：深林针叶细长收尖、中场阔叶短粗成簇、浅田灌丛横走扁平。
  // 没有图章函数：笔数/长度/宽度/色/朝向全由 (x,y) 的场值与 carry 连续决定。
  function tuft(x,y,e,w,carry){
    const lit=clamp(.5-grad(x,y)[1]*2.2,0,1);
    const sp=h1(x*.071+y*.093+seed*.000017);
    const col=palette(e,w,lit,sp);
    const wind=windAt(x,y);
    const needle=smooth(.44,.74,e);        // 高场：针叶多，夹角小、笔更长
    const shrub =1-smooth(.14,.40,e);      // 低场：灌丛多，横走、笔更扁
    const s=2.5+e*3.6+rr(-.3,.5);
    const n=4+Math.floor(e*2+rnd()*2);
    ctx.fillStyle=rgba(col,clamp(.62+e*.32+w*.05,.62,.97));
    ctx.beginPath();
    for(let k=0;k<n;k++){
      const spread=(k-(n-1)/2)/Math.max(1,n-1);
      const fan=spread*(1.55-needle*.72+shrub*.60)+rr(-.34,.34);
      const a=wind+fan+carry*.10;
      // 根部聚在一处，笔尖向外 —— 一簇像从同一个点长出来
      const x0=x+rr(-s*.30,s*.30), y0=y+rr(-s*.30,s*.30);
      const len=s*rr(.72,1.18)*(1+needle*.30)*(1-shrub*.22);
      const w0=rr(1.55,2.65)*(1+shrub*.30)*(1-needle*.14);
      brush(ctx,x0,y0,x0+Math.cos(a)*len,y0+Math.sin(a)*len,w0,w0*rr(.10,.30));
    }
    ctx.fill();                            // 一簇一次 fill，笔间无叠色接缝
  }

  // ── 田畴笔：低场区不是"浅色的小树冠"，是成组平行的细短笔 ────────────
  // 古舆图城外开阔地用田埂短笔，不用林冠团。笔更细、更长、同向成组，
  // 行向由一个低频连续角场给（不是每处随机）。若低场也一律画 tuft，
  // 整幅就变成一张同质感花纹壁纸 —— 地貌必须换语法，不只是换颜色。
  function fieldTuft(x,y,e,w,carry){
    const lit=clamp(.5-grad(x,y)[1]*2.2,0,1);
    const col=palette(e,w,lit,h1(x*.071+y*.093+seed*.000017));
    // 中频项让相邻田块顺地势换向，而不是整片同向排成苇席斜纹；
    // 仍是连续角场，没有把画面切成规整方格。
    // 叠一层更低频的大尺度换向：不同区域的田块整体朝向不同，
    // 放大到 ×3 才不会读成整片同向的苇席斜纹（那又是平铺）。
    const rowA=windAt(x,y)+Math.PI/2
             + Math.sin(x*.0031-y*.0022+.7)*.42
             + Math.sin(x*.006+y*.004)*.34
             + Math.sin(x*.019-y*.013+2.3)*.72
             + Math.cos(x*.014+y*.021+.8)*.46
             + carry*.08;
    const n=3+Math.floor(rnd()*3);
    const L=rr(6,13)*(1-w*.30);
    ctx.fillStyle=rgba(col,clamp(.30+e*.30,.30,.60));
    ctx.beginPath();
    for(let k=0;k<n;k++){
      const off=(k-(n-1)/2)*rr(1.9,2.7);
      const ca=Math.cos(rowA), sa=Math.sin(rowA);
      const x0=x-ca*L*.30-sa*off, y0=y-sa*L*.30+ca*off;
      brush(ctx,x0,y0,x0+ca*L,y0+sa*L,rr(.42,.72),rr(.10,.24));
    }
    ctx.fill();
  }

  // ── 沙岗笔：官渡「依沙堆为营」的微地形 ────────────────────────────────
  // 与林冠簇、田畴笔都不同：根部不聚、横向断续、起粗收尖、赭土色。
  // 由 SAND 连续场决定在哪出现、出现多少，不是全图撒同一种符号。
  function sandTuft(x,y,carry){
    const a=windAt(x,y)+Math.PI/2+rr(-.32,.32);
    const ca=Math.cos(a), sa=Math.sin(a);
    const n=2+Math.floor(rnd()*3);
    ctx.fillStyle=rgba('#9c8154',clamp(.40+rnd()*.24,.36,.66));
    ctx.beginPath();
    for(let k=0;k<n;k++){
      const L=rr(4,11), off=(k-(n-1)/2)*rr(2.0,3.4)+carry*.5;
      const x0=x-sa*off, y0=y+ca*off;
      brush(ctx,x0-ca*L*.5,y0-sa*L*.5,x0+ca*L*.5,y0+sa*L*.5,
            rr(.55,.95),rr(.08,.22));
    }
    ctx.fill();
  }

  // ── 地表覆盖：三套不同方向的一次性游走交织 ───────────────────────────
  // 关键：不遍历场图格子，不撒随机点，不调用同一个图章 N 次。
  // 每条「带」沿 x 推进时 y 由场梯度沿等高方向修正 + carry 缓变，
  // 上一段的终点与方向决定下一段；带上每团由局部场值当场生成。
  // 带与带不等距、走向不同，交织后没有可读出的重复单元。
  function surfaceCover(){
    // ① 主覆盖：不等距扫描行，一遍笔把地表写完（面，不是线簇）。
    //    上一版让带沿等值线跑，带全被吸到高场区聚成条，中间空出大片纸 ——
    //    航拍不是那样：眼睛看下去是一整片连续地表。
    //    这里行不跟梯度跑，只做小幅场起伏；行距、步长、密度、色、笔势全部
    //    由连续场 + 沿行/跨行传递的 carry 决定，没有任何重复单元可复制。
    let rowY=30, carry=rr(-1,1), rowIdx=0;
    while(rowY<H-28){
      const rowSkew=rr(-.018,.018);
      let x=30+rr(0,7);
      while(x<W-30){
        const e=field(x,rowY), w=wetness(x,rowY), o=openness(x,rowY);
        // 覆盖率：低场区也要铺（草甸/浅田），只是色浅、笔疏；只有城外环、
        // 沙洲、图廓内侧才真正漏纸。
        // 深林几乎不留缝，浅田笔组之间露出淡赭底罩 —— 密度也随场值走，
        // 不再全域一个密度，避免整幅读成同一张花纹。
        const dens=clamp(.54+e*.44-w*.04-o*.20,.26,.99);
        const step=clamp(5.7-e*1.4,4.0,6.0);
        const yy=rowY+Math.sin(x*.013+rowIdx*.7)*2.1+carry*.34
                 +rowSkew*(x-W/2)*.02;
        if(rnd()<dens && rnd()>o*.20){
          const nx=x+rr(-1.6,1.6), ny=yy+rr(-1.4,1.4);
          const sd=sand(nx,ny);
          // 官渡沙堆：林冠让位给断续沙笔，露出赭土 —— 概率连续，无硬边界
          if(sd>.26 && rnd()<sd*.88){ sandTuft(nx,ny,carry); }
          else {
            const ee=clamp(field(nx,ny)+rr(-.05,.05),0,1);
            const ww=wetness(nx,ny);
            // 概率连续混合，不做硬阈值切换：过渡带是散的，不会出现一条分界
            const fieldness=1-smooth(.22,.40,ee);
            if(rnd()<fieldness) fieldTuft(nx,ny,ee,ww,carry);
            else                tuft(nx,ny,ee,ww,carry+rowIdx*.3);
          }
        }
        carry=clamp(carry+rr(-.5,.5),-2.2,2.2);
        x+=step;
      }
      // 行距由这一行平均场强给：深林略挤，开阔地略疏，但都不超过 8px
      rowY+=clamp(7.1-field(W*.5,rowY)*1.8,5.0,7.6)+rr(-.5,.5);
      rowIdx++;
    }

    // ② 斜向灌丛游走：与①成交角，打散任何条纹感，补中低场区
    for(let b=0;b<22;b++){
      const ang=rr(.42,.78)*(rnd()>.5?1:-1);
      const ca=Math.cos(ang), sa=Math.sin(ang);
      let t=rr(-H*.4,H*1.15), carry=rr(-1,1);
      let px=rr(30,W-30), py=t;
      while(px>26&&px<W-26&&py>26&&py<H-26){
        const e=field(px,py), w=wetness(px,py), o=openness(px,py);
        if(e<.64&&e>.26&&rnd()<.30+e*.30-o*.42){
          const L=rr(3,8)*(1+e*.5);
          hardRibbon(ctx,[[px,py],[px+ca*L,py+sa*L+carry*.3]],
            {w:rr(.5,1.0),col:palette(e,w,.45,h1(px*.05+py*.07)),
             alpha:rr(.16,.32)*(1-o*.5),head:.10,tail:.42,sk:rr(0,99),seg:2});
        }
        carry=clamp(carry+rr(-.5,.5),-2,2);
        const adv=rr(5.5,9.5);
        px+=ca*adv+rr(-1.5,1.5);
        py+=sa*adv+carry*.4;
      }
    }

    // ③ 斜向交织之上的短硬笔：把「点彩团」打散成工笔短笔的织面
    for(let b=0;b<30;b++){
      let x=rr(30,W-30), y=rr(30,H-30), a=rr(-.9,.9), carry=rr(-1,1);
      const L=rr(60,190);
      for(let s=0;s<L;s+=rr(5,9)){
        const e=field(x,y), o=openness(x,y);
        if(e>.28&&rnd()<.62-o*.3){
          const l=rr(2.5,6.5)*(1+e*.4);
          hardRibbon(ctx,[[x,y],[x+Math.cos(a)*l,y+Math.sin(a)*l+carry*.2]],
            {w:rr(.45,.85),col:palette(e,wetness(x,y),.5,h1(x*.061+y*.083)),
             alpha:rr(.12,.26),head:.10,tail:.44,sk:rr(0,99),seg:2});
        }
        carry=clamp(carry+rr(-.4,.4),-2,2);
        a+=rr(-.16,.16); x+=Math.cos(a)*6; y+=Math.sin(a)*6;
        if(x<28||x>W-28||y<28||y>H-28) break;
      }
    }

    // ④ 林中极淡地名：古舆图必有地名，但不写到让人注意到底
    for(const a of AXES){
      const q=a.P[Math.floor(a.P.length/2)];
      vertical(a.name,q[0]+9,q[1]-16,9,'#3d4739',.30);
    }
  }

  // ── 许下屯田沟洫：建安五年正在发生的地表 ────────────────────────────
  // 建安元年枣祗募民屯田许下，开枣祗河/玛瑙河/高底河/灌沟，「引流以溉」，
  // 灌沟「南北二口俱有陡门」。人工渠更直、更细、赭土色，是第三套地貌成因。
  // 渠身与沟洫都挂 CANALS 真实锚点，笔数/长度/角度/陡门由局部场 + carry 连续给，
  // 没有可复制的图章，也不画成等距网格。
  function canalWorks(){
    for (const c of CANALS) {
      const P=resample(c.pts.map(PXY),6), F=frames(P);
      // 渠身：笔断意连的细赭线
      for(let i=0;i<P.length-8;i+=13){
        const Q=P.slice(i,Math.min(P.length,i+9));
        if(Q.length>2) hardRibbon(ctx,Q,
          {w:1.05,col:'#8d7a52',alpha:.30,head:.08,tail:.22,sk:rr(0,99),seg:2});
      }
      // 两侧平行沟洫：沿渠弧长游走，步进不等、角度带 carry
      let carry=rr(-1,1);
      for(let i=8;i<P.length-8;){
        const p=P[i], f=F[i];
        const side=rnd()>.5?1:-1;
        const perp=Math.atan2(f.ny,f.nx)+carry*.14;
        const ca=Math.cos(perp), sa=Math.sin(perp);
        const n=2+Math.floor(rnd()*3);
        const L=rr(12,26)*(1-openness(p[0],p[1])*.30);
        const base=rr(8,15)*side;
        for(let k=0;k<n;k++){
          const off=(k-(n-1)/2)*rr(3.2,4.8);
          const x0=p[0]+f.nx*base-sa*off, y0=p[1]+f.ny*base+ca*off;
          hardRibbon(ctx,[[x0-ca*L*.5,y0-sa*L*.5],[x0+ca*L*.5,y0+sa*L*.5]],
            {w:.7,col:'#8a7550',alpha:rr(.15,.29),head:.08,tail:.28,sk:rr(0,99),seg:2});
        }
        // 陡门：只在部分沟口，两短竖夹一门，不宣称精确间距
        if(rnd()<.30){
          const gx=p[0]+f.nx*base, gy=p[1]+f.ny*base;
          ctx.save(); ctx.strokeStyle='rgba(86,72,48,.58)'; ctx.lineWidth=1;
          ctx.beginPath();
          for(const s of [-1,1]){
            const tx=f.tx*s*3.2, ty=f.ty*s*3.2;
            ctx.moveTo(gx+tx-f.nx*4,gy+ty-f.ny*4);
            ctx.lineTo(gx+tx+f.nx*4,gy+ty+f.ny*4);
          }
          ctx.stroke(); ctx.restore();
        }
        carry=clamp(carry+rr(-.5,.5),-2,2);
        i+=Math.round(rr(10,17));
      }
      const q=P[Math.floor(P.length*.55)];
      vertical(c.name,q[0]+7,q[1]-9,8,'#6e5b3a',.62);
    }
  }

  // ── 黄河金堤 / 水门：汉代系统堤防 ─────────────────────────────────────
  // 汉人称黄河大堤为「金堤」；王景「十里立一水门，令更相洄注」。
  // 沿黄河岸线弧长铺断续夯土堤（赭），斗门只在部分堤段出现 ——
  // 建安五年是否仍完整沿用十里之制无直接记载，故不画成等距闸门阵列。
  function dykes(){
    const g=RIVER_GEO.find(r=>r.major);
    if(!g) return;
    for(const side of [1,-1]){
      let carry=rr(-1,1);
      for(let i=8;i<g.P.length-10;){
        const step=Math.round(rr(15,27));
        const off=g.width+9+carry*1.8;
        const Q=[];
        for(let j=0;j<step && i+j<g.P.length-8;j++){
          const q=g.P[i+j], f=g.F[Math.min(i+j,g.F.length-1)];
          Q.push([q[0]+f.nx*off*side,q[1]+f.ny*off*side]);
        }
        if(Q.length>2) hardRibbon(ctx,Q,
          {w:1.7,col:'#9a7a48',alpha:.46,head:.06,tail:.20,sk:rr(0,99),seg:2});
        if(rnd()<.34 && Q.length>3){
          const q=Q[Math.floor(Q.length/2)];
          const f=g.F[Math.min(i+Math.floor(step/2),g.F.length-1)];
          ctx.save(); ctx.strokeStyle='rgba(86,72,48,.60)'; ctx.lineWidth=1;
          ctx.beginPath();
          for(const s of [-1,1]){
            const tx=f.tx*s*3.1, ty=f.ty*s*3.1;
            ctx.moveTo(q[0]+tx-f.nx*4,q[1]+ty-f.ny*4);
            ctx.lineTo(q[0]+tx+f.nx*4,q[1]+ty+f.ny*4);
          }
          ctx.stroke(); ctx.restore();
        }
        carry=clamp(carry+rr(-.5,.5),-2,2);
        i+=step+Math.round(rr(4,10));
      }
    }
  }

  // ── 湿林带：必须在水画完之后跑（RIVER_GEO 那时才有数据） ─────────────
  // 上一版把它塞在 surfaceCover() 里，而 RIVER_GEO 由 river() 填充，
  // 调用顺序在前，整个循环空转 —— 河两岸因此是秃的。
  function wetBands(){
    for(const g of RIVER_GEO){
      const step=g.major?5:7;
      for(let i=2;i<g.P.length-2;i+=step){
        const p=g.P[i], f=g.F[i];
        for(const side of [-1,1]){
          for(let k=0;k<2;k++){
            const off=g.width+rr(2,24);           // 宽度浮动大，不成等宽带
            const bx=p[0]+f.nx*off*side+rr(-3,3);
            const by=p[1]+f.ny*off*side+rr(-3,3);
            if(rnd()>.62) continue;              // 断续，避免连成一条整齐划线
            tuft(bx,by,rr(.52,.84),rr(.52,.92),rr(-2,2));
          }
        }
      }
    }
    for(const l of LAKE_PTS){
      const n=20+Math.floor(l.rx/4);
      for(let k=0;k<n;k++){
        const a=k/n*Math.PI*2+rr(-.1,.1);
        const x=l.x+Math.cos(a)*l.rx*rr(1.04,1.26);
        const y=l.y+Math.sin(a)*l.ry*rr(1.04,1.28);
        if(rnd()>.76) continue;
        tuft(x,y,rr(.5,.78),rr(.6,.95),rr(-2,2));
      }
    }
  }

  // ── 水：俯视深青水面，盖在林冠之上 ────────────────────────────────────
  const RIVER_GEO=[], LAKE_GEO=[];
  function lakes() {
    for (const L of LAKES) {
      const [cx,cy]=proj(L.lon,L.lat);
      const rx=L.rx/(LON_MAX-LON_MIN)*(W-2*PAD), ry=L.ry/(LAT_MAX-LAT_MIN)*(H-2*PAD);
      const N=14, pts=[];
      for (let i=0;i<N;i++) {
        const a=i/N*Math.PI*2;
        pts.push([cx+Math.cos(a)*rx*rr(.78,1.18), cy+Math.sin(a)*ry*rr(.74,1.22)]);
      }
      const d=resample([...pts,pts[0],pts[1],pts[2]],4);
      const path=new Path2D(); path.moveTo(d[0][0],d[0][1]);
      for (const p of d) path.lineTo(p[0],p[1]);
      path.closePath();
      ctx.fillStyle=rgba('#4a6b6c',.62); ctx.fill(path);
      ctx.fillStyle=rgba('#36595c',.24); ctx.fill(path);
      ctx.strokeStyle=rgba('#3c5b58',.42); ctx.lineWidth=.9; ctx.stroke(path);
      // 圃田泽「九沟九泽二十四浦」：泽面不是一整块青，是有沙洲、有水汊、
      // 有蒲苇的湿地。沙洲漏一丢丢纸，其余全是笔，不是平铺贴图。
      const big = L.name==='圃田泽';
      const reeds=[];
      for(let i=0;i<(big?9:5);i++){
        const a=rr(0,Math.PI*2), R=rr(.15,.72);
        const x=cx+Math.cos(a)*rx*R, y=cy+Math.sin(a)*ry*R;
        const rw=rr(5,13), rh=rr(1.6,3.4);
        ctx.fillStyle=rgba('#e9e0ca',rr(.42,.72));
        ctx.beginPath(); ctx.ellipse(x,y,rw,rh,a,0,Math.PI*2); ctx.fill();
        reeds.push({x,y,r:Math.max(rw,rh)});
      }
      // 分割水道：从泽心向外，笔断意连，不连成一条贯穿全画的「路」
      for(let i=0;i<(big?8:3);i++){
        const a=rr(0,Math.PI*2), r0=rr(.10,.34), a2=a+rr(-.9,.9), len=rr(.45,.90);
        const x0=cx+Math.cos(a)*rx*r0, y0=cy+Math.sin(a)*ry*r0;
        hardRibbon(ctx,[[x0,y0],
          [x0+Math.cos(a2)*rx*len*.5,y0+Math.sin(a2)*ry*len*.5],
          [x0+Math.cos(a2)*rx*len,y0+Math.sin(a2)*ry*len]],
          {w:1.0,col:'#7fa8a6',alpha:.26,head:.08,tail:.24,sk:rr(0,99),seg:2});
      }
      // 蒲苇：沿各沙洲缘的一次性游走。萑苻泽「泽中多生蒲草」；
      // 得名另有麻黄草说，故只作丛生草本，不指定物种、不画叶片图章。
      // 全泽合成一条 path 一次 fill，笔与笔之间没有叠色接缝。
      let carry=rr(-1,1);
      ctx.fillStyle=rgba('#546b4a',.44);
      ctx.beginPath();
      for(const s of reeds){
        const n=5+Math.floor(rr(0,5));
        for(let k=0;k<n;k++){
          const t=k/n*Math.PI*2+carry*.2;
          const px=s.x+Math.cos(t)*s.r*rr(1.0,1.7), py=s.y+Math.sin(t)*s.r*rr(.7,1.3);
          const ang=t+Math.PI/2+rr(-.35,.35)+carry*.10;
          const L2=rr(4,9);
          brush(ctx,px,py,px+Math.cos(ang)*L2,py+Math.sin(ang)*L2,
                rr(.6,1.1),rr(.08,.20));
        }
        carry=clamp(carry+rr(-.5,.5),-2,2);
      }
      ctx.fill();
      for (let i=0;i<11;i++) {
        const y=cy+rr(-ry*.6,ry*.6), x=cx+rr(-rx*.6,rx*.15), l=rr(rx*.16,rx*.44);
        ribbon(ctx,[[x,y],[x+l*.5,y+rr(-1,1)],[x+l,y]],
          {w:.55,col:'#8fb0aa',alpha:rr(.16,.30),head:.08,tail:.3,sk:rr(0,99)});
      }
      vertical(L.name,cx+rx*.80,cy-ry*.5,10,'#eae6d4',.72);
      LAKE_GEO.push({cx,cy,rx,ry});
    }
  }
  function river(pts, width, name, major) {
    const P=resample(pts.map(PXY),5), F=frames(P);
    const A=P.map((p,i)=>[p[0]+F[i].nx*width,p[1]+F[i].ny*width]);
    const B=P.map((p,i)=>[p[0]-F[i].nx*width,p[1]-F[i].ny*width]);
    const path=new Path2D(); path.moveTo(A[0][0],A[0][1]);
    for (const p of A) path.lineTo(p[0],p[1]);
    for (let i=B.length-1;i>=0;i--) path.lineTo(B[i][0],B[i][1]);
    path.closePath();
    ctx.fillStyle=rgba(major?'#3f656a':'#4b7073',major?.78:.66); ctx.fill(path);
    ctx.fillStyle=rgba('#2f555a',major?.20:.14); ctx.fill(path);
    // 断续岸笔
    const broken=(Q,col,al)=>{
      const step=11,gap=3;
      for(let i=0;i<Q.length-gap;i+=step+gap){
        const seg=Q.slice(i,Math.min(Q.length,i+step));
        if(seg.length>2) ribbon(ctx,seg,{w:major?.85:.6,col,alpha:al,
          head:.05,tail:.16,sk:rr(0,99),dry:.3,bristles:3});
      }
    };
    broken(A,'#2f4f4e',.46); broken(B,'#2f4f4e',.38);
    const count=major?30:10;
    for(let k=0;k<count;k++){
      const i=Math.floor(rr(.04,.95)*(P.length-1)), f=F[i];
      const off=rr(-width*.55,width*.55);
      const x=P[i][0]+f.nx*off, y=P[i][1]+f.ny*off, l=rr(7,major?20:12);
      ribbon(ctx,[[x-f.nx*l*.5,y-f.ny*l*.5],[x+f.nx*l*.5,y+f.ny*l*.5]],
        {w:.5,col:'#9ab8b2',alpha:rr(.16,.30),head:.1,tail:.3,sk:rr(0,99)});
    }
    if(name){
      const i=Math.floor(P.length*.60), f=F[i];
      vertical(name,P[i][0]+f.nx*(width+9),P[i][1]+f.ny*(width+9)-10,
        major?11:9,'#eae6d4',major?.82:.68);
    }
    RIVER_GEO.push({P,F,width,major});
  }

  // ── 图面题识 / 比例尺 ─────────────────────────────────────────────────
  // 画在背景层里，而不是 HTML 叠层：缩放时它们必须跟图一起走。
  // 留在 DOM 上的版本缩到 0.32 倍时，题识会停在左上角、比例尺停在右下角，
  // 悬在图外的纸面上，非常出戏。
  function inscriptions(){
    const font='"WenQuanYi Micro Hei","Noto Serif CJK SC",serif';
    const tx=40, ty=48, big='汉末州郡地形图', bs=20, bp=bs*1.34;

    // 左上：深林底，浅字 + 墨描边
    ctx.save();
    ctx.font=`${bs}px ${font}`; ctx.textAlign='center'; ctx.textBaseline='top';
    ctx.lineWidth=3; ctx.lineJoin='round'; ctx.strokeStyle='rgba(18,30,25,.66)';
    for(let i=0;i<big.length;i++) ctx.strokeText(big[i],tx,ty+i*bp);
    ctx.restore();
    vertical(big,tx,ty,bs,'#f2ead4',.94,1.34);
    vertical('建安五年庚辰 · 西至洛阳东至大野 · 空中俯瞰',
      tx+30,ty+6,10,'#f0e9d5',.76,1.24);

    // 朱印
    const sx=tx+8, sy=ty+big.length*bp+20;
    ctx.save();
    ctx.fillStyle='rgba(156,51,43,.90)'; ctx.fillRect(sx-13,sy,26,26);
    ctx.strokeStyle='rgba(240,190,160,.5)'; ctx.lineWidth=1; ctx.strokeRect(sx-13,sy,26,26);
    ctx.fillStyle='#f2e6d1'; ctx.font=`15px ${font}`;
    ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText('舆',sx,sy+13);
    ctx.restore();

    // 右下：浅田底，深字
    const bw=96, bx=W-38-bw, by=H-46;
    ctx.save();
    ctx.font=`10px ${font}`; ctx.textAlign='right'; ctx.textBaseline='bottom';
    ctx.fillStyle='rgba(56,54,42,.80)';
    ctx.fillText('每方约三十里 · 纵横不拘实距',bx+bw,by-10);
    ctx.strokeStyle='rgba(95,90,69,.82)'; ctx.lineWidth=.9;
    ctx.strokeRect(bx,by,bw,6);
    ctx.fillStyle='rgba(95,90,69,.82)';
    ctx.fillRect(bx,by,bw*.25,6); ctx.fillRect(bx+bw*.5,by,bw*.25,6);
    ctx.restore();
  }

  // ── 以下为「地物层」：有实地位置，由上层数据叠压，不属于背景 ───────────
  // 形制考订：战国已有木石梁桥、渭水浮桥，前 541 年临晋关已有黄河浮桥；
  // 东汉虽已有裸拱（新野画像砖），石拱桥成熟要到隋。故这里不用江南式石拱
  // （那是南宋《平江图》305 座拱桥的语汇），支流用平梁、大河用舟桥。
  function beamBridge(x,y,ang,w) {
    ctx.save(); ctx.translate(x,y); ctx.rotate(ang);
    ctx.strokeStyle='rgba(88,78,56,.84)'; ctx.lineWidth=1.2;
    ctx.beginPath();
    ctx.moveTo(-w/2,-2.6); ctx.lineTo(w/2,-2.6);
    ctx.moveTo(-w/2,2.6);  ctx.lineTo(w/2,2.6);
    ctx.stroke();
    ctx.strokeStyle='rgba(247,239,216,.66)'; ctx.lineWidth=.5;
    ctx.beginPath(); ctx.moveTo(-w/2+1,-1.2); ctx.lineTo(w/2-1,-1.2); ctx.stroke();
    // 桥墩：不等距，由位置连续给，不是等分小竖线
    let px=-w/2+2;
    while(px<w/2-1){
      ctx.strokeStyle='rgba(88,78,56,.6)'; ctx.lineWidth=.8;
      ctx.beginPath(); ctx.moveTo(px,-3.4); ctx.lineTo(px,3.4); ctx.stroke();
      px+=rr(5,9);
    }
    ctx.restore();
  }
  function pontoonBridge(x,y,ang,w) {
    ctx.save(); ctx.translate(x,y); ctx.rotate(ang);
    // 两道连接梁：平梁，不拱
    ctx.strokeStyle='rgba(88,78,56,.82)'; ctx.lineWidth=1.4;
    ctx.beginPath();
    ctx.moveTo(-w/2,-2.4); ctx.lineTo(w/2,-2.4);
    ctx.moveTo(-w/2,2.4);  ctx.lineTo(w/2,2.4);
    ctx.stroke();
    // 舟排：每舟宽与间距连续变化，不等距复制
    let px=-w/2;
    while(px<w/2-3){
      const bw=rr(4,7);
      ctx.strokeStyle='rgba(240,236,218,.80)'; ctx.lineWidth=.8;
      ctx.beginPath();
      ctx.moveTo(px,-3.4); ctx.lineTo(px+bw*.2,3.4);
      ctx.lineTo(px+bw*.8,3.4); ctx.lineTo(px+bw,-3.4);
      ctx.stroke();
      px+=bw+rr(1.4,3.2);
    }
    ctx.restore();
  }

  // 扩大后补入的地标：只画小方城 + 竖排名，不画托光/浅田环/印，
  // 也不进 CITY_PTS 清场。它们有实地出处，但不该抢十二座主城的层级。
  function landmarks() {
    for(const [name,lon,lat] of LANDMARKS){
      const [x,y]=proj(lon,lat), s=9, h=s*.70;
      ctx.save();
      ctx.strokeStyle='rgba(68,66,52,.78)'; ctx.lineWidth=1;
      ctx.strokeRect(x-s,y-h,s*2,h*2);
      ctx.strokeStyle='rgba(247,239,216,.58)'; ctx.lineWidth=.5;
      ctx.strokeRect(x-s+1.2,y-h+1.2,s*2-2.4,h*2-2.4);
      for(const [ox,oy] of [[x-s,y-h],[x+s,y+h]]){
        ctx.strokeStyle='rgba(68,66,52,.72)'; ctx.lineWidth=.8;
        ctx.strokeRect(ox-1.8,oy-1.8,3.6,3.6);
      }
      ctx.restore();
      const deep=field(x,y)>.52;
      vertical(name,x+s+4,y-h,9,deep?'#f3ecd8':'#33352c',.88);
    }
  }

  /* ── 作战区主景补绘 ────────────────────────────────────────────────
     全部用一次性笔路（stroke 路径 / brush 变宽短笔），不用 rect / ellipse，
     也不复制同一图章。用 h1() 取确定性变化，不推进 seed —— 既有绘制序列不动。 */
  function sceneDetails(){
    // ① 雒阳灵台：不规则夯土高台，边线抖动不闭合；环柏绕台
    {
      const [x,y]=proj(SCENES[0][1],SCENES[0][2]);
      ctx.save();
      ctx.strokeStyle='rgba(84,70,48,.82)'; ctx.lineWidth=1.1;
      ctx.beginPath();
      for(let k=0;k<=6;k++){
        const px=x-11+k*3.7, py=y+5+Math.sin(k*1.7)*1.2;
        k?ctx.lineTo(px,py):ctx.moveTo(px,py);
      }
      ctx.moveTo(x-11,y+5); ctx.lineTo(x-8,y-6);
      ctx.moveTo(x+11,y+5); ctx.lineTo(x+8,y-6);
      ctx.moveTo(x-8,y-6); ctx.lineTo(x-2,y-8);
      ctx.lineTo(x+4,y-7); ctx.lineTo(x+8,y-6);
      ctx.stroke(); ctx.restore();
      for(let k=0;k<9;k++){
        const a=k/9*Math.PI*2+h1(k*7.1)*.3, R=13+h1(k*3.7)*4;
        const px=x+Math.cos(a)*R, py=y+Math.sin(a)*R*.7;
        ctx.fillStyle='rgba(52,78,58,.62)'; ctx.beginPath();
        brush(ctx,px,py+2,px+(h1(k*11.3)-.5)*2,py-3-h1(k*5.1)*3,
              .9+h1(k*9.7)*.6,.12);
        ctx.fill();
      }
      vertical('灵台',x+16,y-8,9,'#f0e9d5',.84);
    }
    // ② 邙山东汉圆丘封土与冢柏：断续折线近似圆丘，不闭合成椭圆
    {
      const [x,y]=proj(SCENES[1][1],SCENES[1][2]);
      ctx.save();
      ctx.strokeStyle='rgba(126,104,72,.80)'; ctx.lineWidth=1.1;
      ctx.beginPath();
      for(let k=0;k<=14;k++){
        const a=Math.PI+k/14*Math.PI;
        const px=x+Math.cos(a)*10, py=y+2-Math.sin(a)*6;
        if(h1(k*3.1)>.22) ctx.lineTo(px,py); else ctx.moveTo(px,py);
      }
      ctx.stroke(); ctx.restore();
      for(let k=0;k<12;k++){
        const a=k/12*Math.PI*2, R=12+h1(k*4.3)*5;
        const px=x+Math.cos(a)*R, py=y+Math.sin(a)*R*.55;
        ctx.fillStyle=k%3===0?'rgba(42,66,50,.70)':'rgba(60,86,62,.58)';
        ctx.beginPath();
        brush(ctx,px,py+2,px+(h1(k*8.9)-.5)*1.6,py-2.5-h1(k*2.7)*3,
              1+h1(k*6.1)*.7,.14);
        ctx.fill();
      }
      vertical('邙陵',x+15,y-9,9,'#f0e9d5',.82);
    }
    // ③ 阳城汉三阙：一对石垛，中留阙道；不是门楼宅院
    {
      const [x,y]=proj(SCENES[2][1],SCENES[2][2]);
      ctx.save();
      ctx.strokeStyle='rgba(92,84,66,.84)'; ctx.lineWidth=1.2;
      for(const side of [-1,1]){
        const sx=x+side*7;
        ctx.beginPath();
        ctx.moveTo(sx-2.5,y+6); ctx.lineTo(sx-2,y-5);
        ctx.lineTo(sx+1.5,y-7); ctx.lineTo(sx+2.5,y+6);
        ctx.moveTo(sx-2,y-5); ctx.lineTo(sx+2.5,y-5);
        ctx.stroke();
      }
      // 阙道：几笔浅色短横，点出中间可通
      for(let k=0;k<3;k++){
        ctx.strokeStyle='rgba(226,214,176,.60)'; ctx.lineWidth=.8;
        ctx.beginPath(); ctx.moveTo(x-4,y+2+k*1.6); ctx.lineTo(x+4,y+2+k*1.6); ctx.stroke();
      }
      ctx.restore();
      vertical('汉阙',x+13,y-8,9,'#f0e9d5',.82);
    }
    // ④ 轘辕关十二曲：一条折返十二次的一次性笔路（史料「十二曲」）
    {
      const [x,y]=proj(SCENES[3][1],SCENES[3][2]);
      ctx.save();
      ctx.strokeStyle='rgba(96,80,56,.80)'; ctx.lineWidth=1.2;
      ctx.beginPath(); ctx.moveTo(x-16,y+10);
      for(let k=0;k<12;k++){
        const yy=y+10-k*1.7, xx=x+(k%2?7:-7)+Math.sin(k*1.3)*2+h1(k*5.3)*1.4;
        ctx.lineTo(xx,yy);
      }
      ctx.stroke(); ctx.restore();
      vertical('轘辕',x+13,y-10,9,'#f0e9d5',.82);
    }
    // ⑤ 官渡战具：土山高橹 / 霹雳车发石 / 地道—长堑
    //    与沙堆微地形分开：沙堆是地表，战具是九月双方的工程。
    {
      const [x,y]=proj(SCENES[4][1],SCENES[4][2]);
      ctx.save();
      // 土山：顶端一小簇更密的笔，外加一根高橹竖笔
      ctx.strokeStyle='rgba(122,96,62,.84)'; ctx.lineWidth=1;
      ctx.beginPath();
      ctx.moveTo(x-15,y-4); ctx.lineTo(x-8,y-11);
      ctx.lineTo(x-2,y-7); ctx.lineTo(x+3,y-12); ctx.lineTo(x+10,y-4);
      ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x-3,y-11); ctx.lineTo(x-3,y-19);
      ctx.moveTo(x-6,y-17); ctx.lineTo(x,y-17); ctx.stroke();
      // 霹雳车：曹营侧离散石堆，大小位置各异，不排成阵列
      for(let k=0;k<7;k++){
        const px=x-24+h1(k*7.7)*20, py=y+6+h1(k*3.9)*7;
        ctx.fillStyle='rgba(88,80,62,.72)'; ctx.beginPath();
        brush(ctx,px,py,px+1.5+h1(k*11.1)*2,py-.8,1.1,.35);
        ctx.fill();
      }
      // 长堑：两道平行断续浅壕，笔断意连
      ctx.strokeStyle='rgba(56,78,66,.72)'; ctx.lineWidth=1.3;
      for(const dy of [12,17]){
        ctx.beginPath();
        for(let k=0;k<=8;k++){
          const px=x-30+k*7.5, py=y+dy+Math.sin(k*.9)*1.1;
          if(h1(k*2.3+dy)>.24) ctx.lineTo(px,py); else ctx.moveTo(px,py);
        }
        ctx.stroke();
      }
      ctx.restore();
      vertical('战具',x+18,y-12,9,'#f0e9d5',.84);
    }
  }

  // 东汉坞堡：平面近方、四周高墙、前后门设门楼、四隅角楼；
  // 武威雷台陶楼院角楼间还连飞桥。俯视天生就是「方围墙 + 四角小方块」。
  // 尺寸/朝向/飞桥有无由 h1(x,y) 连续决定，不是同一张图章复制。
  function walledHold(x,y,ang,sc) {
    const s=rr(11,16)*sc;
    ctx.save(); ctx.translate(x,y); ctx.rotate(ang);
    ctx.strokeStyle='rgba(68,66,52,.88)'; ctx.lineWidth=1.1;
    ctx.strokeRect(-s,-s*.80,s*2,s*1.60);
    ctx.strokeStyle='rgba(240,234,214,.78)'; ctx.lineWidth=.6;
    ctx.strokeRect(-s+1.4,-s*.80+1.4,s*2-2.8,s*1.60-2.8);
    for(const [ox,oy] of [[-s,-s*.80],[s,-s*.80],[-s,s*.80],[s,s*.80]]){
      const u=rr(2.6,4.2)*sc;
      ctx.strokeStyle='rgba(68,66,52,.90)'; ctx.lineWidth=1;
      ctx.strokeRect(ox-u/2,oy-u/2,u,u);
      ctx.fillStyle='rgba(240,234,214,.52)';
      ctx.fillRect(ox-u/2+1,oy-u/2+1,u-2,u-2);
    }
    // 门楼（南面）
    ctx.strokeStyle='rgba(68,66,52,.82)'; ctx.lineWidth=1;
    ctx.strokeRect(-s*.22,s*.80-2.5,s*.44,4.5);
    // 飞桥只部分坞堡有，避免整片同款
    if(h1(x*.11+y*.13)>.62){
      ctx.strokeStyle='rgba(88,78,56,.55)'; ctx.lineWidth=.7;
      ctx.beginPath(); ctx.moveTo(-s,-s*.80); ctx.lineTo(s,-s*.80); ctx.stroke();
    }
    ctx.restore();
  }

  // 乌巢粮囤：「绍辎重囤集乌巢」，只挂一处，成组方形屋基 + 晒场，不单列为城
  function granaries() {
    for(const [lon,lat,name] of GRANARIES){
      const [x,y]=proj(lon,lat);
      const a=nearestRiver(x,y).a;
      ctx.save(); ctx.translate(x,y); ctx.rotate(a);
      ctx.strokeStyle='rgba(68,66,52,.80)'; ctx.lineWidth=1;
      for(let k=0;k<5;k++){
        const w=rr(6,9), h=rr(4,6);
        const ox=(k%3-1)*11+rr(-2,2), oy=Math.floor(k/3)*9+rr(-2,2);
        ctx.strokeRect(ox-w/2,oy-h/2,w,h);
      }
      ctx.strokeStyle='rgba(226,214,176,.46)'; ctx.lineWidth=.7;
      ctx.strokeRect(-19,14,38,5);
      ctx.restore();
      vertical(name,x+16,y-12,9,'#f0e9d5',.78);
    }
  }
  function boat(x,y,sail) {
    const l=6+sail*4;
    ctx.save();
    ctx.strokeStyle='rgba(240,236,218,.86)'; ctx.lineWidth=.9;
    ctx.beginPath(); ctx.moveTo(x-l,y); ctx.lineTo(x,y+4); ctx.lineTo(x+l,y);
    ctx.moveTo(x,y+4); ctx.lineTo(x+.6,y-7-sail*2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x+.6,y-7-sail*2);
    ctx.lineTo(x+5+sail*2,y-4-sail); ctx.lineTo(x+.6,y-2); ctx.stroke();
    ctx.restore();
  }

  function city(c) {
    const [name,lon,lat,rank]=c;
    const [x,y]=proj(lon,lat);
    const s=rank===1?30:rank===2?24:rank===3?20:17, h=s*.64;
    const L=x-s,R=x+s,T=y-h,B=y+h;
    ctx.save();
    // 柔边托光：工笔的「托底」。中部官渡/中牟/陈留几座城叠得近，
    // 细线在密笔背景上会糊成一团；一层渐隐的纸光让城浮出来，
    // 但边缘是软的，不是之前那个实心浅田椭圆的贴纸感。
    const cityGlow=ctx.createRadialGradient(x,y,s*.35,x,y,s*2.5);
    cityGlow.addColorStop(0,'rgba(242,235,214,.46)');
    cityGlow.addColorStop(.55,'rgba(242,235,214,.20)');
    cityGlow.addColorStop(1,'rgba(242,235,214,0)');
    ctx.fillStyle=cityGlow;
    ctx.beginPath(); ctx.arc(x,y,s*2.5,0,Math.PI*2); ctx.fill();
    // 城外浅田环：用断续浅笔暗示，不填一个实心圆饼（贴纸感太重）。
    // 真正的过渡已由连续场的城外清场给出，这里只补一圈田埂短笔。
    const RX=s*2.45, RY=h*2.85;
    ctx.strokeStyle='rgba(238,228,196,.42)'; ctx.lineWidth=.8;
    for(let k=0;k<26;k++){
      const a=k/26*Math.PI*2+rr(-.06,.06);
      const px=x+Math.cos(a)*RX*rr(.72,1.0), py=y+Math.sin(a)*RY*rr(.72,1.0);
      const l=rr(5,11);
      ctx.beginPath();
      ctx.moveTo(px-Math.cos(a+.9)*l*.5,py-Math.sin(a+.9)*l*.5);
      ctx.lineTo(px+Math.cos(a+.9)*l*.5,py+Math.sin(a+.9)*l*.5);
      ctx.stroke();
    }
    ctx.strokeStyle='rgba(68,66,52,.88)'; ctx.lineWidth=1.5;
    ctx.strokeRect(L,T,s*2,h*2);
    ctx.strokeStyle='rgba(68,66,52,.42)'; ctx.lineWidth=.8;
    ctx.strokeRect(L+2.5,T+2.5,s*2-5,h*2-5);
    ctx.strokeStyle='rgba(247,239,216,.72)'; ctx.lineWidth=.7;
    ctx.strokeRect(L+1.4,T+1.4,s*2-2.8,h*2-2.8);
    if (rank<=2) {
      const u=s*.42;
      ctx.strokeStyle='rgba(68,66,52,.66)'; ctx.lineWidth=1;
      ctx.strokeRect(x-u,T+4,u*2,h*.86);
      ctx.strokeStyle='rgba(247,239,216,.6)'; ctx.lineWidth=.6;
      ctx.strokeRect(x-u+1.2,T+5.2,u*2-2.4,h*.86-2.4);
    }
    ctx.strokeStyle='rgba(68,66,52,.5)'; ctx.lineWidth=.7;
    for (const [ox,oy] of [[-s*.55,h*.1],[s*.3,-h*.25],[s*.42,h*.28]]) {
      const w=rr(4,7), ht=rr(3.5,5.5);
      ctx.strokeRect(x+ox,T+h+oy,w,ht);
      ctx.beginPath(); ctx.moveTo(x+ox-1,T+h+oy); ctx.lineTo(x+ox+w/2,T+h+oy-3);
      ctx.lineTo(x+ox+w+1,T+h+oy); ctx.stroke();
    }
    ctx.fillStyle='rgba(68,66,52,.72)';
    for (const [a,b] of [[L+4,L+s*.6],[L+s*.8,L+s*1.3],[R-s*.5,R-4]]) {
      let px=a;
      while (px<b-3){ const w=rr(2.8,4.8); ctx.fillRect(px,T-rr(3,4.6),w,rr(3,4.6)); px+=w+rr(2,4.6); }
    }
    const gw=s*.48;
    ctx.fillStyle='rgba(234,226,205,.96)'; ctx.fillRect(x-gw/2,B-1,gw,3.5);
    ctx.strokeStyle='rgba(68,66,52,.86)'; ctx.lineWidth=1.3;
    ctx.beginPath();
    ctx.moveTo(x-gw/2,B+2); ctx.lineTo(x-gw/2,T+h*.55);
    ctx.moveTo(x+gw/2,B+2); ctx.lineTo(x+gw/2,T+h*.55); ctx.stroke();
    for (const [ly,ww] of [[T+h*.55,gw*.95],[T+h*.30,gw*.78]]) {
      ctx.beginPath();
      ctx.moveTo(x-ww,ly); ctx.lineTo(x-ww*.66,ly-5);
      ctx.lineTo(x+ww*.66,ly-5); ctx.lineTo(x+ww,ly);
      ctx.moveTo(x-ww*.78,ly-5); ctx.lineTo(x,ly-9); ctx.lineTo(x+ww*.78,ly-5);
      ctx.stroke();
    }
    ctx.strokeStyle='rgba(68,66,52,.62)'; ctx.lineWidth=1;
    for (const [cx,cy] of [[L,T],[R,T],[L,B],[R,B]]) {
      ctx.strokeRect(cx-3,cy-3,6,6);
      ctx.beginPath(); ctx.moveTo(cx-4.5,cy-3); ctx.lineTo(cx,cy-6); ctx.lineTo(cx+4.5,cy-3); ctx.stroke();
    }
    ctx.strokeStyle='rgba(120,72,48,.7)'; ctx.lineWidth=.9;
    ctx.beginPath(); ctx.moveTo(R-6,T-4); ctx.lineTo(R-6,T-16); ctx.stroke();
    ctx.fillStyle='rgba(156,51,43,.62)';
    ctx.beginPath(); ctx.moveTo(R-6,T-16); ctx.lineTo(R+2,T-13); ctx.lineTo(R-6,T-10); ctx.closePath(); ctx.fill();
    ctx.restore();

    // 密背景上地名要读得出：深林用浅字、浅田用深字，再加一层反向淡描边。
    const fs=rank===1?15:rank===2?13:rank===3?11:10;
    const deep=field(x,y)>.52;
    const ink=deep?'#f3ecd8':'#33352c', halo=deep?'rgba(22,36,30,.68)':'rgba(244,236,214,.66)';
    ctx.save();
    ctx.font=`${fs}px "WenQuanYi Micro Hei","Noto Serif CJK SC",serif`;
    ctx.textAlign='center'; ctx.textBaseline='top';
    ctx.lineWidth=2.4; ctx.strokeStyle=halo; ctx.lineJoin='round';
    for(let i=0;i<name.length;i++) ctx.strokeText(name[i],R+10,T-2+i*(fs*1.12));
    ctx.restore();
    vertical(name,R+10,T-2,fs,ink,.96);
    const by=T+name.length*(fs*1.12)+3, bs=rank===1?10:8;
    ctx.fillStyle=rgba('#9c332b',.94); ctx.fillRect(R+6,by,bs,bs);
    ctx.fillStyle=rgba('#f2e6d1',.95);
    ctx.font=`${rank===1?8:7}px serif`; ctx.textAlign='center'; ctx.textBaseline='top';
    ctx.fillText(rank===1?'都':rank===2?'郡':rank===3?'县':'垒',R+6+bs/2,by+1);
    vertical(rank===1?'州治':rank===2?'郡治':rank===3?'县邑':'营垒',
      R+10+fs*1.2,T+4,8,ink,.62);
  }

  function passesFords() {
    for (const [name,lon,lat,kind] of PASSES) {
      const [x,y]=proj(lon,lat);
      if (kind==='pass') {
        ctx.strokeStyle='rgba(240,232,208,.9)'; ctx.lineWidth=1.2;
        ctx.beginPath(); ctx.moveTo(x,y+6); ctx.lineTo(x,y-10); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x,y-10); ctx.lineTo(x+12,y-6); ctx.lineTo(x,y-2); ctx.closePath();
        ctx.fillStyle='rgba(156,51,43,.82)'; ctx.fill();
        ctx.strokeStyle='rgba(110,68,46,.8)'; ctx.stroke();
      } else {
        ctx.strokeStyle='rgba(230,238,226,.9)'; ctx.lineWidth=1.1;
        ctx.beginPath(); ctx.moveTo(x-8,y+2);
        ctx.quadraticCurveTo(x,y+8,x+8,y+2);
        ctx.quadraticCurveTo(x,y+5,x-8,y+2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x,y+2); ctx.lineTo(x,y-8); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x,y-8); ctx.lineTo(x+5,y-5); ctx.lineTo(x,y-3); ctx.stroke();
      }
      vertical(name,x+11,y-11,9,'#f2ead4',.86);
    }
  }

  // 聚落挂在真实城/关津锚点上，避开深林（改用连续场判断，不再是包围盒）
  function nearestRiver(x,y) {
    let best=null, bd=1e9;
    for (const g of RIVER_GEO) for (let i=0;i<g.P.length;i+=6) {
      const d=Math.hypot(g.P[i][0]-x,g.P[i][1]-y);
      if (d<bd) { bd=d; best={a:Math.atan2(g.F[i].ty,g.F[i].tx),d}; }
    }
    return best||{a:0,d:1e9};
  }
  const inDeepCanopy=(x,y)=>field(x,y)>.60;

  function hamlet(x,y,ang,n,sc) {
    const ca=Math.cos(ang), sa=Math.sin(ang);
    ctx.save();
    ctx.strokeStyle='rgba(240,234,214,.80)'; ctx.lineWidth=.8;
    for (let k=0;k<n;k++) {
      const ox=(k-(n-1)/2)*7*sc, oy=rr(-2,2)*sc;
      const X=x+ox*ca-oy*sa, Y=y+ox*sa+oy*ca;
      const w=rr(4,6.5)*sc, h=rr(3,4.6)*sc;
      ctx.strokeRect(X-w/2,Y-h,w,h);
      ctx.beginPath();
      ctx.moveTo(X-w/2-1,Y-h); ctx.lineTo(X,Y-h-2.6*sc); ctx.lineTo(X+w/2+1,Y-h);
      ctx.stroke();
    }
    ctx.restore();
  }
  function croft(x,y,ang,n) {
    ctx.save();
    ctx.strokeStyle='rgba(226,214,176,.52)'; ctx.lineWidth=.6;
    const ca=Math.cos(ang), sa=Math.sin(ang);
    for (let k=0;k<n;k++) {
      const oy=(k-(n-1)/2)*2.6, L=rr(10,20);
      ctx.beginPath();
      ctx.moveTo(x-L/2*ca-oy*sa,y-L/2*sa+oy*ca);
      ctx.lineTo(x+L/2*ca-oy*sa,y+L/2*sa+oy*ca);
      ctx.stroke();
    }
    ctx.restore();
  }
  function settlements() {
    const civilNames=['聚','邮','市','里','邑','驿','仓','井','陂','塘'];
    const warNames=['坞','壁','屯','垒','营'];
    CITIES.forEach((c,ci)=>{
      const rank=c[3];
      const [cx,cy]=proj(c[1],c[2]);
      const military=MILITARY.has(c[0]);
      const n=rank===1?5:rank===2?3:rank===3?2:1;
      for (let k=0;k<n;k++) {
        const a=(k/n)*Math.PI*2+h1(ci*7+k)*1.4;
        const R=(rank===1?62:rank===2?50:rank===3?42:34)+rr(-8,12);
        const x=cx+Math.cos(a)*R, y=cy+Math.sin(a)*R*.78;
        if (x<60||x>W-60||y<60||y>H-60||inDeepCanopy(x,y)) continue;
        const ang=nearestRiver(x,y).a+rr(-.35,.35);
        if(military){
          // 有史料依据的前线/军屯据点：黄巾后豪强「修坞筑堡」，方墙四角楼
          walledHold(x,y,ang,rr(.85,1.25));
          vertical(warNames[(ci+k)%warNames.length],x+14,y-11,8,'#f0e9d5',rr(.58,.76));
        } else {
          hamlet(x,y,ang,2+Math.floor(h1(ci*13+k*3)*3),rr(.85,1.25));
          croft(x+Math.cos(ang)*16,y+Math.sin(ang)*16,ang+Math.PI/2,
                3+Math.floor(h1(ci*5+k)*4));
          vertical(civilNames[(ci*3+k)%civilNames.length],x+11,y-9,8,'#f0e9d5',rr(.52,.70));
        }
      }
    });
    PASSES.filter(p=>p[3]==='pass').forEach((p,pi)=>{
      const [x0,y0]=proj(p[1],p[2]);
      for (let k=0;k<2;k++) {
        const x=x0+rr(16,34)*(k?1:-1), y=y0+rr(-20,18);
        if (inDeepCanopy(x,y)) continue;
        hardRibbon(ctx,[[x,y],[x,y-rr(8,12)]],
          {w:.8,col:'#e8dcc0',alpha:.58,head:.10,tail:.30,sk:pi,seg:2});
        ribbon(ctx,[[x-4,y-rr(8,12)],[x,y-rr(12,17)],[x+4,y-rr(8,12)]],
          {w:.7,col:'#c2604f',alpha:.52,head:.10,tail:.35,sk:pi});
      }
    });
  }
  function bridgesBoats() {
    const onRiver=(pts,ts) => {
      const P=resample(pts.map(PXY),5), F=frames(P);
      return ts.map(t=>{
        const i=Math.floor(t*(P.length-1));
        return {p:P[i],ang:Math.atan2(F[i].ty,F[i].tx)+Math.PI/2};
      });
    };
    // 黄河级水面：舟桥（浮桥），不是石拱
    for (const q of onRiver(HUANGHE,[.16,.34,.52,.70,.86]))
      pontoonBridge(q.p[0]+rr(-6,6),q.p[1]+rr(-4,4),q.ang,rr(18,26));
    // 支流：木石平梁桥
    for (const r of RIVERS_MINOR) for (const q of onRiver(r.pts,[.30,.68]))
      beamBridge(q.p[0],q.p[1]+2,q.ang,rr(12,18));
    onRiver(HUANGHE,[.10,.24,.40,.58,.74,.92]).forEach((q,i)=>
      boat(q.p[0]+rr(-8,8),q.p[1]+rr(-6,6),h1(i+3)));
    onRiver(RIVERS_MINOR[0].pts,[.2,.55,.85]).forEach((q,i)=>
      boat(q.p[0]+rr(-6,6),q.p[1]+rr(-5,5),h1(i+11)));
    // 官渡：渠水南岸官方渡口，用舟桥 + 码头，不画拱
    const b=PXY([114.00,34.55]);
    pontoonBridge(b[0],b[1],nearestRiver(b[0],b[1]).a+Math.PI/2,20);
  }

  // ── 分层渲染 ──────────────────────────────────────────────────────────
  // 背景层：纸 → 廓 → 建场 → 薄罩 → 林冠/田畴/沙岗 → 沟洫 → 泽/河 → 湿林 → 金堤
  // 地物层：桥舟 → 聚落/坞堡 → 粮囤 → 城 → 关津
  // 两层都与 zoom 无关、各渲一次到离屏；缩放/平移/切层只做合成。
  // 只有「重落一笔」换 seed 才重建 —— 否则滚轮每动一下都要重画上万个树冠团。
  function renderLayers(){
    seed = baseSeed;                       // 固定起点，重建幂等
    RIVER_GEO.length=0; LAKE_GEO.length=0;

    ctx = bgCtx;
    ctx.setTransform(SS,0,0,SS,0,0);
    ctx.clearRect(0,0,W,H);
    paper(); border();
    buildField();
    fieldWash();                         // 工笔第一道工序：先罩连续底色（含官渡赭土）
    surfaceCover();                      // 再叠顺场笔势的树冠 / 田畴 / 沙岗短笔
    canalWorks();                        // 建安五年许下屯田沟洫 + 陡门
    lakes();                             // 二十四浦 / 沙洲 / 蒲苇
    river(HUANGHE,8.6,'河水',true);
    for (const r of RIVERS_MINOR) river(r.pts,r.w,r.name,false);
    wetBands();                          // 岸上的深青湿林，盖在水边而不是水下
    dykes();                             // 金堤断续夯土线 + 水门（压在湿林之上）
    inscriptions();                      // 图面题识，随图缩放

    ctx = featCtx;
    ctx.setTransform(SS,0,0,SS,0,0);
    ctx.clearRect(0,0,W,H);
    bridgesBoats();                      // 舟桥 / 平梁，无石拱
    settlements();                       // 军屯坞堡 / 民屯田舍
    granaries();                         // 乌巢粮囤
    landmarks();                         // 扩大后补入的四处有出处地标
    for (const c of CITIES) city(c);
    passesFords();
    sceneDetails();                      // 台账主景补入作战区（只画地与物，不画势力）

  }


/* ── 对游戏暴露的唯一入口 ────────────────────────────────────────────────
   对面图幅 112.30~116.75 / 32.30~36.95，画布 1200×880、PAD=46、SS=2。
   游戏图幅（map-data.js）112.75~116.15 / 32.65~36.65 是其中一个窗口，
   按同一 proj() 反算像素矩形再 drawImage，城郭、关津、河防与逻辑格天然对齐。 */
export function renderGuanduLayers(opts = {}) {
  mk = opts.createCanvas ?? (() => document.createElement('canvas'));
  baseSeed = opts.seed ?? 20261116;
  seed = baseSeed;
  bg = mk(); feat = mk();
  bg.width = feat.width = W * SS;
  bg.height = feat.height = H * SS;
  bgCtx = bg.getContext('2d'); featCtx = feat.getContext('2d');
  renderLayers();

  const px = (lon) => PAD + (lon - LON_MIN) / (LON_MAX - LON_MIN) * (W - 2 * PAD);
  const py = (lat) => PAD + (1 - (lat - LAT_MIN) / (LAT_MAX - LAT_MIN)) * (H - 2 * PAD);
  const x0 = px(G_LON_MIN), x1 = px(G_LON_MAX);
  const y0 = py(G_LAT_MAX), y1 = py(G_LAT_MIN);
  return {
    bg, feat, W, H, SS, PAD,
    // 源矩形已含 SS 倍率，调用方直接 drawImage(bg, sx,sy,sw,sh, 0,0, W,H)
    crop: { sx: x0 * SS, sy: y0 * SS, sw: (x1 - x0) * SS, sh: (y1 - y0) * SS },
  };
}
