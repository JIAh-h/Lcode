/* ═══════════════════════════════════════════════
   Lcode · Web 前端 v1.0 — mock 数据 + 交互
   （无构建、无依赖；由 index.html 加载）
   ═══════════════════════════════════════════════ */
(function(){
'use strict';
var $=function(s,r){return (r||document).querySelector(s)};
var $$=function(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s))};

/* ─────────────────────────────────────────────
   MOCK 数据
   ───────────────────────────────────────────── */
var MOCK={
  workspace:'web-app',
  user:{name:'jiahao',initial:'J',title:'本地用户'},
  models:[
    {name:'DeepSeek-V4 Pro',src:'深度求索'},
    {name:'deepseek-v4-flash',src:'自定义'}
  ],
  groups:[
    {name:'web-app',items:[
      {title:'把 parse.ts 换成结构化解析',state:'running',count:'14 步',on:true},
      {title:'看一下这个项目主要是做什么的',state:'idle',count:'已完成'}
    ]},
    {name:'api-server',items:[
      {title:'给订单接口补测试',state:'idle',count:'已完成'},
      {title:'修登录态过期不跳转',state:'error',count:'中断'}
    ]}
  ],
  stateColor:{running:'var(--state-running)',success:'var(--state-success)',error:'var(--state-error)',waiting:'var(--state-waiting)',idle:'var(--state-idle)'},
  replay:[
    ['读取文件 utils/parse.ts','42ms'],
    ['搜索 parse(','4 个文件'],
    ['修改文件 utils/parse.ts','+13 −2'],
    ['新建测试文件','+22'],
    ['运行测试','14 通过'],
    ['等待确认 · 改外部类型文件','已允许'],
    ['修改 order.d.ts','+6 −2'],
    ['再次运行测试','全部通过 · 本轮结束'],
    ['读取 README','—'],
    ['搜索 zod 版本','—']
  ],
  rationale:{
    1:'读取 utils/parse.ts：\n· 谁批准的：权限「标准」自动允许（工作区内文件）\n· 依据：任务目标是改造这个文件，先看现状\n· 影响面：只读',
    2:'搜索 "parse("：\n· 依据：改动签名前必须摸清全部调用方\n· 结果：11 处引用、4 个文件',
    3:'修改 utils/parse.ts：\n· 谁批准的：权限「标准」自动允许（工作区内文件）\n· 依据：用户要求「换成结构化解析」\n· 影响面：1 个文件，+13 −2',
    4:'新建 utils/__tests__/parse.test.ts：\n· 依据：用户明确要求「补一个测试」\n· 影响面：新文件，+22',
    5:'运行 pnpm vitest run utils：\n· 依据：验证改动\n· 结果：14 通过',
    6:'等待确认（工作区外文件）：\n· 策略：sandbox/mode=workspace-write → ask\n· 无「记住选择」，一次性放行',
    7:'修改 ~/shared/types/order.d.ts：\n· 谁批准的：用户在第 6 步明确允许（仅一次）\n· 影响面：工作区外，+6 −2',
    8:'再次运行测试：\n· 依据：外部类型文件改动后回归\n· 结果：全部通过，本轮结束',
    9:'读取 README：\n· 依据：确认文档是否需要同步更新\n· 结果：暂不需要',
    10:'搜索 zod 版本：\n· 依据：确认依赖版本一致性\n· 结果：package.json 已是 ^3.23.8'
  },
  trusted:[
    {path:'~/code/web-app',files:'1,284 个文件',at:'2026-08-02 信任'},
    {path:'~/code/api-server',files:'862 个文件',at:'2026-07-18 信任'}
  ],
  storage:[
    {label:'会话记录',size:'128 MB'},
    {label:'回放快照',size:'96 MB'},
    {label:'模型响应缓存',size:'512 MB'},
    {label:'日志',size:'24 MB'}
  ]
};

/* ─────────────────────────────────────────────
   基础交互：屏幕切换 / 主题 / 折叠 / 菜单 / toast
   ───────────────────────────────────────────── */
function go(id){
  $$('.screen').forEach(function(s){s.classList.toggle('on',s.id===id)});
  $$('#nav button').forEach(function(b){b.classList.toggle('on',b.dataset.s===id)});
  window.scrollTo(0,0);
}
$('#nav').addEventListener('click',function(e){var b=e.target.closest('button');if(b)go(b.dataset.s)});
document.addEventListener('click',function(e){
  var g=e.target.closest('[data-go]');
  if(g){e.preventDefault();go(g.dataset.go);return}
  var t=e.target.closest('[data-toast]');
  if(t){toast(t.dataset.toast)}
});
var toastTimer=null;
function toast(msg){
  var el=$('#toast');el.textContent=msg;el.classList.add('show');
  clearTimeout(toastTimer);toastTimer=setTimeout(function(){el.classList.remove('show')},2200);
}
/* 主题 */
$$('input[name=th]').forEach(function(r){r.addEventListener('change',function(){document.documentElement.dataset.theme=r.value;syncAppearance()})});
$('#cb').addEventListener('change',function(){document.documentElement.dataset.cb=this.checked?'on':'off';syncAppearance()});
/* 折叠（通用 data-fold） */
document.addEventListener('click',function(e){
  var t=e.target.closest('[data-fold]');if(!t)return;
  var el=document.getElementById(t.dataset.fold);if(!el)return;
  if(el.classList.contains('reply')){el.classList.toggle('folded')}
  else if(el.classList.contains('ops')){el.classList.toggle('open')}
  else if(el.classList.contains('ssec')){el.classList.toggle('open')}
  else if(el.classList.contains('fitem')){el.classList.toggle('open')}
  else el.classList.toggle('open');
});
/* 菜单（通用下拉） */
$$('[data-menu]').forEach(function(btn){
  btn.addEventListener('click',function(e){
    e.stopPropagation();
    var m=document.getElementById(btn.dataset.menu);
    var wasOpen=m.classList.contains('open');
    $$('.menu').forEach(function(x){x.classList.remove('open')});
    $$('.mi').forEach(function(x){x.classList.remove('open')});
    if(!wasOpen){m.classList.add('open');btn.classList.add('open')}
  });
});
document.addEventListener('click',function(){
  $$('.menu').forEach(function(x){x.classList.remove('open')});
  $$('.mi').forEach(function(x){x.classList.remove('open')});
});
/* 预览导航栏收起/展开 */
var pv=$('#pvToggle');
if(pv){pv.addEventListener('click',function(){
  var bar=$('#previewBar');bar.classList.toggle('folded');
  pv.textContent=bar.classList.contains('folded')?'预览导航':'收起';
})}

/* ─────────────────────────────────────────────
   侧栏渲染（P1 / P2 共用）
   ───────────────────────────────────────────── */
function renderSidebar(el,compact){
  var h='<div class="shead">工作区</div><nav class="snav">'
    +'<a class="new" href="#">'
    +'<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>新对话</a>';
  if(!compact){
    h+='<a href="#">'
      +'<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2.5 4.5A1.5 1.5 0 014 3h2l1.5 2H12a1.5 1.5 0 011.5 1.5v5A1.5 1.5 0 0112 13H4a1.5 1.5 0 01-1.5-1.5v-7z" stroke="currentColor" stroke-width="1.2"/></svg>打开文件夹…</a>';
  }
  h+='</nav>';
  MOCK.groups.forEach(function(g){
    h+='<div class="sgroup">'+g.name+'</div><div class="slist">';
    g.items.forEach(function(it){
      h+='<div class="sitem'+(it.on?' on':'')+'" data-sess="'+it.title+'">'
        +'<i class="st" style="background:'+MOCK.stateColor[it.state]+'"></i>'+it.title
        +'<span class="cnt">'+it.count+'</span></div>';
    });
    h+='</div>';
  });
  h+='<div class="acct"><div class="av">'+MOCK.user.initial+'</div>'
    +'<div><div class="nm">'+MOCK.user.name+'</div><div class="em">'+MOCK.user.title+'</div></div>'
    +'<button class="ticon" data-go="p5" title="设置（Ctrl+,）">⚙</button></div>';
  el.innerHTML=h;
  $$('.sitem',el).forEach(function(s){
    s.addEventListener('click',function(){
      $$('.sitem',el).forEach(function(x){x.classList.remove('on')});
      s.classList.add('on');
      go('p2'); /* 产品入口：点会话进工作台 */
    });
  });
  var newBtn=$('.snav .new',el);
  if(newBtn){newBtn.addEventListener('click',function(e){e.preventDefault();go('p1')})} /* 产品入口：新对话回首页 */
  var folderBtn=$$('.snav a',el)[1];
  if(folderBtn){folderBtn.addEventListener('click',function(e){e.preventDefault();toast('演示：打开文件夹')})}
}
renderSidebar($('#side1'),false);
renderSidebar($('#side2'),true);

/* ─────────────────────────────────────────────
   右栏 tab / 面板开关 / 产物入口
   ───────────────────────────────────────────── */
$$('.rtabs button').forEach(function(b){b.addEventListener('click',function(){
  $$('.rtabs button').forEach(function(x){x.classList.remove('on')});b.classList.add('on');
  $('#rtab-changes').style.display=b.dataset.rtab==='changes'?'block':'none';
  $('#rtab-files').style.display=b.dataset.rtab==='files'?'block':'none';
})});
var pt=$('#panelToggle');
function setPanel(hidden){
  var wb=$('.wb');if(!wb)return;
  wb.classList.toggle('panel-hidden',hidden);
  pt.classList.toggle('on',!hidden);
  pt.setAttribute('aria-pressed',String(!hidden));
}
pt.addEventListener('click',function(){setPanel(!$('.wb').classList.contains('panel-hidden'))});
$$('[data-panel]').forEach(function(b){b.addEventListener('click',function(){
  var p=$('#rightpanel');if(!p)return;
  setPanel(false);
  p.style.boxShadow='0 0 0 2px var(--accent)';setTimeout(function(){p.style.boxShadow=''},900)
})});

/* ── 菜单动作：data-act（视图/帮助）与 data-edit（编辑） ── */
var zoomLevel=1;
function applyZoom(){document.body.style.zoom=zoomLevel;toast('缩放 '+Math.round(zoomLevel*100)+'%')}
document.addEventListener('click',function(e){
  var el=e.target.closest('[data-act]');if(!el)return;
  var known=['side','panel','theme','zoomin','zoomout','zoomreset','fullscreen','keys'];
  if(known.indexOf(el.dataset.act)<0)return; /* 其余 data-act（P4 allow/deny/cancel）由原有逻辑处理 */
  e.preventDefault();
  var act=el.dataset.act;
  if(act==='side'){
    document.body.classList.toggle('noside');
    toast(document.body.classList.contains('noside')?'侧边栏已隐藏':'侧边栏已显示');
  }else if(act==='panel'){
    if(!$('#p2').classList.contains('on')){go('p2');setTimeout(function(){setPanel(!$('.wb').classList.contains('panel-hidden'))},0)}
    else setPanel(!$('.wb').classList.contains('panel-hidden'));
  }else if(act==='theme'){
    var next=document.documentElement.dataset.theme==='dark'?'light':'dark';
    document.documentElement.dataset.theme=next;
    var radio=$('input[name=th][value="'+next+'"]');if(radio)radio.checked=true;
    toast(next==='dark'?'已切换到深色主题':'已切换到浅色主题');
  }else if(act==='zoomin'){zoomLevel=Math.min(1.5,zoomLevel+0.1);applyZoom()}
  else if(act==='zoomout'){zoomLevel=Math.max(0.7,zoomLevel-0.1);applyZoom()}
  else if(act==='zoomreset'){zoomLevel=1;applyZoom()}
  else if(act==='fullscreen'){
    if(document.fullscreenElement){document.exitFullscreen()}
    else{document.documentElement.requestFullscreen&&document.documentElement.requestFullscreen()}
  }else if(act==='keys'){
    go('p5');
    setTimeout(function(){
      var links=$$('#setnav a');
      for(var i=0;i<links.length;i++){
        if(links[i].textContent==='键盘快捷键'){links[i].click();break}
      }
    },0);
  }
});
/* 编辑菜单：交给浏览器原生编辑命令处理 */
document.addEventListener('click',function(e){
  var el=e.target.closest('[data-edit]');if(!el)return;
  e.preventDefault();
  var ok=false;
  try{ok=document.execCommand(el.dataset.edit)}catch(err){}
  toast(ok?'已执行「'+el.textContent.replace(/\s.*$/,'')+'」':'当前没有可编辑的目标');
});

/* ─────────────────────────────────────────────
   P2：状态切换 / 计时 / 确认流 / 发送
   ───────────────────────────────────────────── */
var seg=$('#p2seg');
var elapsedSec=124,timer=null;
function fmt(s){return Math.floor(s/60)+' 分 '+(s%60)+' 秒'}
function startTimer(){
  if(timer)return;
  timer=setInterval(function(){
    elapsedSec++;
    var t=$('#elapsedTxt');if(t)t.textContent='已进行 '+fmt(elapsedSec);
  },1000);
}
function stopTimer(){clearInterval(timer);timer=null}
startTimer();
seg.addEventListener('click',function(e){
  var b=e.target.closest('button');if(!b)return;
  $$('button',seg).forEach(function(x){x.classList.toggle('on',x===b)});
  var done=b.dataset.state==='done';
  $('#turnRun').style.display=done?'none':'block';
  $('#turnDone').style.display=done?'block':'none';
  $('#wmeta').textContent=done?'整个任务 · 已完成':'整个任务 · 进行中';
  $('#wlive').style.display=done?'none':'inline-flex';
  if(done){stopTimer();var f=$('#finalSummary');if(f)f.scrollIntoView({behavior:'smooth',block:'center'})}
  else startTimer();
});
/* P4 确认动作 */
document.addEventListener('click',function(e){
  var b=e.target.closest('[data-act]');if(!b)return;
  var act=b.dataset.act,bar=$('#pendingBar');
  var col=$('#col');
  if(act==='allow'){
    if(bar){bar.className='pending done';bar.innerHTML='<span class="ptag">已确认</span><span class="ptxt">允许修改 ~/shared/types/order.d.ts（仅这一次）——继续运行</span>';
      var op=document.createElement('div');op.className='op';
      op.innerHTML='<span class="ic">✎</span><span class="verb">修改文件</span><span class="arg">~/shared/types/order.d.ts</span><span class="ds"><span class="add">+6</span> <span class="del">−2</span></span><span class="meta">已确认</span>';
      $('#opNow').parentNode.insertBefore(op,$('#opNow'));}
    toast('已允许，任务继续');
  }else if(act==='deny'){
    if(bar){bar.className='pending done';bar.innerHTML='<span class="ptag">已拒绝</span><span class="ptxt">跳过 order.d.ts，不改工作区外的文件——继续其余步骤</span>'}
    toast('已拒绝，跳过该文件');
  }else{
    stopTimer();
    $('#wlive').style.display='none';
    if(bar){bar.className='pending done';bar.innerHTML='<span class="ptag">已取消</span><span class="ptxt">任务已取消，已完成的改动保留</span>'}
    toast('任务已取消');
  }
});
/* 发送（首页 → 工作台 / 工作台内追加） */
function sendFrom(id){
  var ta=$(id);if(!ta||!ta.value.trim()){toast('先输入内容再发送');return}
  var v=ta.value.trim();ta.value='';
  go('p2');
  var col=$('#col');
  var u=document.createElement('div');u.className='umsg';u.textContent=v;
  col.insertBefore(u,$('#turnRun'));
  var ack=document.createElement('div');ack.className='reply';
  ack.innerHTML='<div class="rhead"><div class="ravatar">L</div><div class="rname">Lcode</div><span class="rmark">已收到</span></div>'
    +'<div class="rbody"><p>收到，已加入当前任务队列'+(isRunning()?'，会在下一步生效。':'，马上开始。')+'（演示环境：这里是 mock 响应）</p></div>';
  col.insertBefore(ack,$('#turnRun'));
  ack.scrollIntoView({behavior:'smooth',block:'nearest'});
}
function isRunning(){return $('#turnRun').style.display!=='none'}
$('#homeSend').addEventListener('click',function(){sendFrom('#homeInput')});
$('#wbSend').addEventListener('click',function(){sendFrom('#wbInput')});
$$('#homeInput,#wbInput').forEach(function(ta){
  ta.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendFrom('#'+ta.id)}});
});
$$('#permBtn1,#modelBtn1').forEach(function(b){b.addEventListener('click',function(){toast('演示：下拉选项暂不可换，请到「设置」修改')})});

/* ─────────────────────────────────────────────
   P3 回放
   ───────────────────────────────────────────── */
var stepsBox=$('#steps'),curStep=7;
function renderReplay(){
  stepsBox.innerHTML='';
  MOCK.replay.forEach(function(s,i){
    var d=document.createElement('div');
    d.className='step'+(i===curStep?' on':'');
    d.innerHTML='<span class="n">'+(i+1)+'</span><div><div class="t">'+s[0]+'</div><div class="m">'+s[1]+'</div></div>';
    d.addEventListener('click',function(){selectStep(i)});
    stepsBox.appendChild(d);
  });
}
function selectStep(i){
  curStep=i;
  $$('.step',stepsBox).forEach(function(x,ix){x.classList.toggle('on',ix===i)});
  var s=MOCK.replay[i];
  $('#snapTitle').textContent='第 '+(i+1)+' 步 · '+s[0];
  $('#ss3c').textContent='截至第 '+(i+1)+' 步 · '+(6+i*2)+' 条';
  $('#ss3').textContent='[用户] 把 utils/parse.ts 换成结构化解析，并补一个测试。\n[助手] 我先读这个文件和它的调用方。\n[操作] '+s[0]+' → '+s[1]+'\n…（共 '+(6+i*2)+' 条，此处折叠）';
  $('#ss4').textContent=MOCK.rationale[i+1]||'（略）';
}
$('#goLatest').addEventListener('click',function(){selectStep(MOCK.replay.length-1);toast('已回到最新')});
renderReplay();selectStep(7);

/* ─────────────────────────────────────────────
   P5 设置：10 个分区
   ───────────────────────────────────────────── */
var SECTIONS=[
  {g:'个人'},{id:'general',label:'常规'},{id:'appearance',label:'外观'},{id:'keys',label:'键盘快捷键'},{id:'account',label:'账户'},
  {g:'模型'},{id:'providers',label:'模型'},
  {g:'权限'},{id:'perm',label:'权限预设'},{id:'trust',label:'工作区信任'},
  {g:'记忆与历史'},{id:'history',label:'历史与保留'},{id:'export',label:'导出'}
];
var curSec='providers';
function renderNav(){
  var nav=$('#setnav');nav.innerHTML='';
  SECTIONS.forEach(function(s){
    if(s.g){var g=document.createElement('div');g.className='g';g.textContent=s.g;nav.appendChild(g);return}
    var a=document.createElement('a');a.href='#';a.textContent=s.label;
    a.className=s.id===curSec?'on':'';
    a.addEventListener('click',function(e){e.preventDefault();curSec=s.id;renderNav();renderSection()});
    nav.appendChild(a);
  });
}
function swRow(label,desc,on,id){
  return '<div class="srow"><div class="sl">'+label+'</div><div class="sr"><div class="swrow">'
    +'<button class="switch'+(on?' on':'')+'" data-sw'+(id?' id="'+id+'"':'')+'></button>'
    +'<span class="swd">'+desc+'</span></div></div></div>';
}
function savebar(ok){return '<div class="savebar"><button class="btn primary" data-save>保存</button><span class="okmsg" data-okmsg style="display:'+(ok?'inline':'none')+'">✓ 已保存</span></div>'}
var TPL={
  general:function(){
    return '<h2>常规</h2><div class="sub">基础行为。改动即时生效。</div>'
      +'<div class="sect"><div class="sh2">界面语言</div><div class="srow"><div class="sl">语言</div><div class="sr"><div class="seg" data-seggroup><button class="on">中文（简体）</button><button>English</button></div><span class="src">切换后立即生效，不影响对话内容。</span></div></div></div>'
      +'<div class="sect"><div class="sh2">启动</div>'
      +'<div class="srow"><div class="sl">启动时</div><div class="sr"><div class="field"><select><option>打开上次的工作区</option><option>进入首页</option><option>打开指定文件夹…</option></select></div></div></div>'
      +swRow('自动检查更新','每周在后台检查新版本，仅提示，不自动安装',true)
      +swRow('崩溃后自动恢复','下次启动时恢复中断的对话并显著标注补记',true)
      +'</div>'
      +'<div class="sect"><div class="sh2">隐私</div>'+swRow('匿名使用统计','只上报功能使用计数，不含任何代码与对话内容',false)+'</div>'
      +savebar();
  },
  appearance:function(){
    var th=document.documentElement.dataset.theme||'light';
    var cb=document.documentElement.dataset.cb==='on';
    return '<h2>外观</h2><div class="sub">主题与显示。此处的改动与右上角的主题切换联动。</div>'
      +'<div class="sect"><div class="sh2">主题</div><div class="srow"><div class="sl">外观</div><div class="sr"><div class="seg" id="themeSeg">'
      +'<button data-th="light"'+(th==='light'?' class="on"':'')+'>浅色</button>'
      +'<button data-th="dark"'+(th==='dark'?' class="on"':'')+'>深色</button>'
      +'<button data-th="light">跟随系统</button></div></div></div>'
      +'<div class="srow"><div class="sl">强调色</div><div class="sr"><div class="swatches">'
      +'<button class="swatch on" style="background:#2563EB" data-ac="#2563EB"></button>'
      +'<button class="swatch" style="background:#7C3AED" data-ac="#7C3AED"></button>'
      +'<button class="swatch" style="background:#0D9488" data-ac="#0D9488"></button>'
      +'<button class="swatch" style="background:#D97706" data-ac="#D97706"></button>'
      +'</div><span class="src">用于链接、选中态与运行状态指示。</span></div></div>'
      +'<div class="srow"><div class="sl">色盲友好 diff</div><div class="sr"><div class="swrow"><button class="switch'+(cb?' on':'')+'" id="cbSwitch"></button><span class="swd">增删行改用蓝/橙区分（对红绿色盲更友好）</span></div></div></div>'
      +'</div>'
      +'<div class="sect"><div class="sh2">显示</div>'
      +'<div class="srow"><div class="sl">界面字号</div><div class="sr"><div class="seg" data-fsseg><button data-fs="sm">小</button><button class="on" data-fs="md">标准</button><button data-fs="lg">大</button></div></div></div>'
      +'<div class="srow"><div class="sl">等宽字体</div><div class="sr"><div class="field"><select><option>JetBrains Mono</option><option>SF Mono</option><option>Consolas</option><option>系统默认</option></select></div></div></div>'
      +'</div>';
  },
  keys:function(){
    var rows=[['新对话','⌃','N'],['打开设置','⌃',','],['显示/隐藏面板','⌃','B'],['进入回放','⌃','R'],['发送消息','Enter',''],['换行','Shift + Enter','']];
    return '<h2>键盘快捷键</h2><div class="sub">演示版暂不支持改键，点击「修改」会给出提示。</div>'
      +'<div class="sect"><div class="sh2">全局</div>'
      +rows.map(function(r){
        return '<div class="krow"><span class="kdesc">'+r[0]+'</span><span class="kcombo">'
          +(r[2]?'<span class="kbd">'+r[1]+' '+r[2]+'</span>':'<span class="kbd">'+r[1]+'</span>')
          +'</span><button class="kedit" data-toast="演示版：暂不支持自定义快捷键">修改</button></div>';
      }).join('')+'</div>';
  },
  account:function(){
    return '<h2>账户</h2><div class="sub">Lcode 默认使用本地账户，数据不出本机。</div>'
      +'<div class="sect"><div class="sh2">资料</div>'
      +'<div class="srow"><div class="sl">头像与名称</div><div class="sr"><div class="fbox" style="display:flex;gap:12px;align-items:center">'
      +'<div class="avatarlg">'+MOCK.user.initial+'</div>'
      +'<div class="field" style="flex:1"><input value="'+MOCK.user.name+'"></div></div></div></div>'
      +'<div class="srow"><div class="sl">登录方式</div><div class="sr"><span class="src">本地账户 · 无需登录。<b>接入团队版</b>后可同步设置与会话（未接入）。</span></div></div>'
      +'</div>'
      +'<div class="sect"><div class="sh2">数据位置</div>'
      +'<div class="trow"><span class="tp">~/lcode</span><span class="tm">会话、设置与回放数据</span><button data-toast="已在访达中显示（模拟）">在文件夹中显示</button></div>'
      +'<div class="trow"><span class="tp">~/lcode/sessions</span><span class="tm">JSONL 会话日志</span><button data-toast="已在访达中显示（模拟）">在文件夹中显示</button></div>'
      +'</div>'
      +'<div class="savebar"><button class="btn danger" data-toast="已退出本地账户（模拟）——演示环境不会真的清除数据">退出本地账户</button></div>';
  },
  providers:function(){
    return '<h2>模型</h2><div class="sub">新对话默认使用的模型，以及你自己添加的自定义模型。改动即时生效，不影响已经开着的对话。</div>'
      +'<div class="sect"><div class="sh2">默认模型</div><div class="srow"><div class="sl">新对话使用</div><div class="sr"><div class="seg" data-seggroup><button class="on">DeepSeek-V4 Pro</button><button>deepseek-v4-flash</button><button>Ollama · qwen3</button></div><span class="src">会话里也可以临时切换，只影响那个对话。</span></div></div></div>'
      +'<div class="sect"><div class="sh2">自定义模型 <button class="mini" id="addModelBtn">＋ 添加模型</button></div>'
      +'<div class="mnote">配置一份 OpenAI 兼容的接口即可。添加后会自动写入本地 <code class="mono">~/.lcode/models.json</code>，不会上传。</div>'
      +'<div id="modelList"></div>'
      +'</div>';
  },
  perm:function(){
    return '<h2>权限预设</h2><div class="sub">决定 Lcode 什么时候需要问你。改动即时生效。</div>'
      +'<div class="sect"><div class="sh2">预设</div><div class="srow"><div class="sr" style="gap:10px">'
      +'<div class="pill" data-perm="ro"><div class="pic">RO</div><div><div class="pn">只读</div><div class="pd">不会改动任何文件，适合让 AI 先看代码</div></div><span class="st2">　</span></div>'
      +'<div class="pill on" data-perm="std"><div class="pic">ST</div><div><div class="pn">标准</div><div class="pd">工作区内自动执行；改工作区外、跑有风险的命令前先问</div></div><span class="st2 ok">当前</span></div>'
      +'<div class="pill" data-perm="full"><div class="pic">FU</div><div><div class="pn">完全</div><div class="pd">不再询问。只建议在容器/沙箱里使用</div></div><span class="st2">　</span></div>'
      +'</div></div></div>'
      +'<div class="sect"><div class="sh2">细则</div>'
      +swRow('工作区外文件每次都问','没有「记住选择」；一次确认只管一次',true)
      +swRow('危险命令额外确认','rm -rf、git push --force 等始终二次确认',true)
      +'<div class="srow"><div class="sl">始终要求确认的命令</div><div class="sr"><div class="field"><textarea>rm -rf\ngit push --force\nsudo …</textarea></div></div></div>'
      +'</div>'
      +savebar();
  },
  trust:function(){
    return '<h2>工作区信任</h2><div class="sub">受信任的文件夹会记住权限设定；不信任的文件夹以只读打开。</div>'
      +'<div class="sect"><div class="sh2">已信任的文件夹 <button class="mini" data-toast="演示：选择文件夹">＋ 添加文件夹</button></div><div id="trustList">'
      +MOCK.trusted.map(function(t,i){
        return '<div class="trow"><span class="tp">'+t.path+'</span><span class="tm">'+t.files+' · '+t.at+'</span><button data-untrust="'+i+'">移除</button></div>';
      }).join('')+'</div></div>'
      +'<div class="warnrow" style="margin-top:16px"><span class="wt">提示</span><span>打开不受信任的文件夹时，Lcode 会以只读模式启动，明确确认后才会获得写权限。</span></div>';
  },
  history:function(){
    return '<h2>历史与保留</h2><div class="sub">会话记录与回放数据都保存在本机，可随时清理。</div>'
      +'<div class="sect"><div class="sh2">保留策略</div>'
      +'<div class="srow"><div class="sl">会话记录</div><div class="sr"><div class="field"><select><option>永久保留</option><option>保留 1 年</option><option selected>保留 90 天</option><option>保留 30 天</option></select></div></div></div>'
      +'<div class="srow"><div class="sl">回放快照</div><div class="sr"><div class="field"><select><option selected>跟随会话</option><option>保留 30 天</option><option>保留 7 天</option></select></div></div></div>'
      +'</div>'
      +'<div class="sect"><div class="sh2">空间占用</div><div id="storeList">'
      +MOCK.storage.map(function(s,i){
        return '<div class="trow"><span class="tp">'+s.label+'</span><span class="tm" data-size="'+i+'">'+s.size+'</span><button data-clean="'+i+'">清理</button></div>';
      }).join('')+'</div></div>'
      +savebar();
  },
  export:function(){
    return '<h2>导出</h2><div class="sub">把会话导出为通用格式，便于归档或在其他工具里分析。</div>'
      +'<div class="sect"><div class="sh2">导出设置</div>'
      +'<div class="srow"><div class="sl">格式</div><div class="sr"><div class="seg" data-seggroup><button class="on">JSONL</button><button>Markdown</button><button>HTML</button></div><span class="src">JSONL 保留全部事件（含过程与回放）；Markdown/HTML 只含对话正文。</span></div></div>'
      +'<div class="srow"><div class="sl">范围</div><div class="sr"><div class="field"><select><option>当前会话</option><option>当前工作区的全部会话</option><option>全部会话</option></select></div></div></div>'
      +'</div>'
      +'<div class="savebar"><button class="btn primary" data-toast="已导出到 ~/Downloads/lcode-export.jsonl（模拟）">导出…</button></div>';
  }
};
function renderSection(){
  var col=$('#setcol');
  col.innerHTML=(TPL[curSec]||TPL.general)();
  bindSection(col);
}
function bindSection(root){
  /* 开关 */
  $$('[data-sw]',root).forEach(function(b){b.addEventListener('click',function(){b.classList.toggle('on')})});
  /* seg 单选组 */
  $$('[data-seggroup]',root).forEach(function(g){
    $$('button',g).forEach(function(b){b.addEventListener('click',function(){
      $$('button',g).forEach(function(x){x.classList.remove('on')});b.classList.add('on');
    })});
  });
  /* 外观：主题联动 + 色盲 + 字号 + 强调色 */
  var themeSeg=$('#themeSeg',root);
  if(themeSeg){
    $$('button',themeSeg).forEach(function(b){b.addEventListener('click',function(){
      if(!b.dataset.th)return;
      document.documentElement.dataset.theme=b.dataset.th;
      var radio=$('input[name=th][value="'+b.dataset.th+'"]');if(radio)radio.checked=true;
    })});
  }
  var cbSw=$('#cbSwitch',root);
  if(cbSw){cbSw.addEventListener('click',function(){
    cbSw.classList.toggle('on');
    var on=cbSw.classList.contains('on');
    document.documentElement.dataset.cb=on?'on':'off';
    $('#cb').checked=on;
  })}
  var fsSeg=$('[data-fsseg]',root);
  if(fsSeg){$$('button',fsSeg).forEach(function(b){b.addEventListener('click',function(){
    $$('button',fsSeg).forEach(function(x){x.classList.remove('on')});b.classList.add('on');
    document.documentElement.dataset.fs=b.dataset.fs==='md'?'':b.dataset.fs;
  })})}
  $$('.swatch',root).forEach(function(s){s.addEventListener('click',function(){
    $$('.swatch',root).forEach(function(x){x.classList.remove('on')});s.classList.add('on');
    document.documentElement.style.setProperty('--accent',s.dataset.ac);
    toast('强调色已切换（演示，刷新后还原）');
  })});
  /* range 显示 */
  $$('[data-range]',root).forEach(function(r){r.addEventListener('input',function(){
    $('[data-rangeval]',root).textContent=(r.value/100).toFixed(1);
  })});
  /* 保存 */
  $$('[data-save]',root).forEach(function(b){b.addEventListener('click',function(){
    var ok=$('[data-okmsg]',root);if(ok)ok.style.display='inline';
    toast('已保存（mock）');
  })});
  /* 权限预设 pill */
  $$('[data-perm]',root).forEach(function(p){p.addEventListener('click',function(){
    $$('[data-perm]',root).forEach(function(x){x.classList.remove('on');var st=$('.st2',x);if(st){st.className='st2';st.textContent='　'}});
    p.classList.add('on');var s=$('.st2',p);if(s){s.className='st2 ok';s.textContent='当前'}
  })});
  /* 信任移除 */
  $$('[data-untrust]',root).forEach(function(b){b.addEventListener('click',function(){
    MOCK.trusted.splice(+b.dataset.untrust,1);renderSection();toast('已移除信任（mock）');
  })});
  /* 清理 */
  $$('[data-clean]',root).forEach(function(b){b.addEventListener('click',function(){
    var i=+b.dataset.clean;MOCK.storage[i].size='0 MB';
    var el=$('[data-size="'+i+'"]',root);if(el)el.textContent='0 MB';
    toast('已清理「'+MOCK.storage[i].label+'」（mock）');
  })});
}
renderNav();renderSection();

/* ── 模型页：列表渲染 + 添加模型弹窗（WorkBuddy 风格） ── */
function renderModelList(){
  var box=$('#modelList');if(!box)return;
  if(!MOCK.models.length){box.innerHTML='<div class="mnote">还没有自定义模型。点右上「＋ 添加模型」，填一份接口地址和 API Key 就能用。</div>';return}
  box.innerHTML=MOCK.models.map(function(m,i){
    return '<div class="mrow"><span class="mic">◆</span><span class="mnm">'+m.name+'</span><span class="msrc">'+m.src+'</span>'
      +'<span class="macts">'
      +'<button data-mact="edit" data-idx="'+i+'" title="编辑">✎</button>'
      +'<button data-mact="del" data-idx="'+i+'" title="删除">🗑</button>'
      +'</span></div>';
  }).join('');
}
/* 供应商预设：内置供应商的接口地址来自适配器默认值，用户不用填 → 该字段只在「自定义」时出现 */
var MM_PRESETS={'自定义':null,'DeepSeek':'https://api.deepseek.com','OpenAI':'https://api.openai.com/v1','Ollama（本地）':'http://127.0.0.1:11434'};
function syncProviderFields(){var p=$('#mmProvider'),row=$('#mmBaseRow');if(!p||!row)return;var custom=MM_PRESETS[p.value]===null;row.style.display=custom?'flex':'none';if(custom)$('#mmBase').value=''}
function openModelModal(){var m=$('#modelModal');if(m){m.style.display='grid';$$('.tokchips').forEach(function(b){$$('button',b).forEach(function(c){c.classList.toggle('on',c.dataset.tok==='')})});var k=$('#mmKey');if(k)k.type='password';var eye=$('#mmEye');if(eye){eye.classList.remove('off');eye.title='显示'}var pv=$('#mmProvider');if(pv)pv.value='自定义';syncProviderFields();var n=$('#mmName');if(n)n.focus()}}
function closeModelModal(){var m=$('#modelModal');if(m)m.style.display='none'}
document.addEventListener('click',function(e){
  var t=e.target;
  if(t.closest('#addModelBtn')){e.preventDefault();openModelModal();return}
  if(t.closest('#mmClose')||t.closest('#mmCancel')){closeModelModal();return}
  var chip=t.closest('.tokchips button'); /* 长度 chips：单选；再点取消 → 回到「默认」 */
  if(chip){
    var box=chip.parentNode;
    if(chip.dataset.tok===''){
      $$('button',box).forEach(function(c){c.classList.toggle('on',c.dataset.tok==='')});
    }else{
      var wasOn=chip.classList.contains('on');
      $$('button',box).forEach(function(c){c.classList.remove('on')});
      if(wasOn){var d=$('button[data-tok=""]',box);if(d)d.classList.add('on')}
      else chip.classList.add('on');
    }
    return;
  }
  if(t.closest('#mmSave')){
    var name=$('#mmName').value.trim();
    if(!name){toast('请先填写模型名称');$('#mmName').focus();return}
    var src=$('#mmProvider').value;
    MOCK.models.push({name:name,src:src==='自定义'?'自定义':src});
    renderModelList();closeModelModal();
    $('#mmName').value='';$('#mmKey').value='';$('#mmBase').value='';
    toast('已添加模型「'+name+'」（mock）');return;
  }
  if(t.closest('#modelModal')&&!t.closest('.modal')){closeModelModal();return} /* 点遮罩关闭 */
  var act=t.closest('[data-mact]');
  if(act){
    var i=+act.dataset.idx;
    if(act.dataset.mact==='del'){var nm=MOCK.models[i].name;MOCK.models.splice(i,1);renderModelList();toast('已删除「'+nm+'」（mock）')}
    else toast('演示：编辑模型「'+MOCK.models[i].name+'」');
  }
});
/* API Key 显隐 */
var mmEye=$('#mmEye');
if(mmEye)mmEye.addEventListener('click',function(){
  var k=$('#mmKey');var show=k.type==='password';
  k.type=show?'text':'password';
  mmEye.classList.toggle('off',show);
  mmEye.title=show?'隐藏':'显示';
});
/* 供应商切换：非「自定义」时不出现接口地址字段 */
var mmProvider=$('#mmProvider');
if(mmProvider)mmProvider.addEventListener('change',syncProviderFields);
renderModelList();

/* 首次进入设置时同步一次外观控件状态 */
function syncAppearance(){if(curSec==='appearance'&&$('#p5').classList.contains('on'))renderSection()}
})();
