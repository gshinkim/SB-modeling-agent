import { $, css, el, fmt, ticks, SERIES, esc } from './util.mjs';

/* Eight hues, assigned in fixed order. Past eight, identity moves to a second
   channel (dash) rather than a ninth invented hue, so no two series ever share
   a look. */
const hueOf  = i => css(SERIES[i % 8]);
export const dashOf = i => i < 8 ? null : i < 16 ? '7 4' : i < 24 ? '2 3'
  : `7 3 2 ${3 * (Math.floor(i / 8) - 1)}`;
import { S } from './state.mjs';

// A long key (a large model has dozens of species) is clipped to two rows until opened.
const LEGEND_FOLD = 12;
let legendOpen = false;
export function renderLegend(){
  const L=$('#legend'); L.textContent='';
  if(!S.result || S.result.names.length<2) return;   // a single series needs no legend box
  const fold = S.result.names.length > LEGEND_FOLD;
  L.classList.toggle('clip', fold && !legendOpen);
  if(fold){
    const t=document.createElement('button');
    t.className='lg lg-more'; t.setAttribute('aria-expanded', legendOpen);
    t.textContent = legendOpen ? 'Fewer ▴' : 'All '+S.result.names.length+' ▾';
    t.onclick=()=>{ legendOpen=!legendOpen; renderLegend(); };
    L.append(t);
  }
  S.result.names.forEach((n,i)=>{
    const b=document.createElement('button');
    b.className='lg'; b.setAttribute('aria-pressed', S.hidden.has(n)?'false':'true');
    const d=dashOf(i);
    b.innerHTML='<span class="key'+(d?' dash':'')+'" style="'+
      (d ? 'background:repeating-linear-gradient(90deg,'+hueOf(i)+' 0 5px,transparent 5px 8px)'
         : 'background:'+hueOf(i))+'"></span>'+esc(n);
    b.onclick=()=>{ S.hidden.has(n)?S.hidden.delete(n):S.hidden.add(n); draw(); };
    L.append(b);
  });
}

// The result last rendered: a chart redraw (every zoom or pan step) must not rebuild
// thousands of rows it already shows — that rebuild is what made the page lag.
let tabled;
export function renderTable(){
  const v=$('#tableView'); const r=S.result;
  if(r===tabled && v.firstChild) return;
  tabled=r;
  if(!r){ v.textContent=''; return; }
  let h='<table><thead><tr><th>t</th>'+r.names.map(n=>'<th>'+esc(n)+'</th>').join('')+'</tr></thead><tbody>';
  r.t.forEach((tv,i)=>{ h+='<tr><td>'+fmt(tv)+'</td>'+r.cols.map(c=>'<td>'+fmt(c[i])+'</td>').join('')+'</tr>'; });
  v.innerHTML=h+'</tbody></table>';
}

// Exports can render into a detached SVG, even while another tab hides the plot.
export function draw(target){
  const svg=target?.svg ?? $('#chart'), wrap=target ? null : $('#svgWrap');
  const W=target?.width ?? wrap.clientWidth, H=target?.height ?? wrap.clientHeight;
  if(!W||!H) return;
  svg.textContent='';
  if(!target){ renderLegend(); $('#zoomReset').hidden = !S.view; }
  const r=S.result;
  // Every number on this chart is computed by Tellurium. Anything without that
  // provenance is a bug, and is refused rather than drawn.
  if(r && r.source !== 'tellurium'){
    const t0=el('text',{x:W/2,y:H/2,'text-anchor':'middle',fill:css('--crit'),'font-size':13});
    t0.textContent='Refusing to plot: result did not come from Tellurium';
    svg.append(t0); return;
  }
  if(!r || !r.names.length){
    const t0=el('text',{x:W/2,y:H/2,'text-anchor':'middle',fill:css('--muted'),'font-size':13});
    t0.textContent='No simulation to show'; svg.append(t0);
    return;
  }
  const t=r.t, last=t.length-1;
  const T0 = S.view ? S.view.t0 : t[0], T1 = S.view ? S.view.t1 : t[last];
  let i0=0, i1=last;
  while(i0<last && t[i0+1] < T0) i0++;
  while(i1>0 && t[i1-1] > T1) i1--;
  const shown = r.names.map((n,i)=>i).filter(i=>!S.hidden.has(r.names[i]));
  let lo=Infinity, hi=-Infinity;
  shown.forEach(i=>{ for(let k=i0;k<=i1;k++){ const v=r.cols[i][k]; if(v<lo)lo=v; if(v>hi)hi=v; } });
  if(!isFinite(lo)){ lo=0; hi=1; }
  if(hi===lo) hi = lo + Math.max(Math.abs(lo)*0.1, 1);
  lo=Math.min(0,lo); hi=hi+(hi-lo)*0.06;

  const yTicks=ticks(lo,hi,5).filter(v=>v>=lo-1e-9 && v<=hi);
  const wide=Math.max(...yTicks.map(v=>fmt(v).length),1);
  const pad={l:Math.max(52,26+wide*6.9), r:78, t:14, b:34};
  const pw=W-pad.l-pad.r, ph=H-pad.t-pad.b;
  if(pw<40||ph<40) return;
  const x=v=>pad.l+(v-T0)/(T1-T0||1)*pw, y=v=>pad.t+ph-(v-lo)/(hi-lo)*ph;
  if(!target) S.geom={pad,pw,ph,T0,T1,W,H};

  const g=el('g'); svg.append(g);
  yTicks.forEach(v=>{
    g.append(el('line',{x1:pad.l,x2:W-pad.r,y1:y(v),y2:y(v),stroke:css('--grid'),'stroke-width':1}));
    const tx=el('text',{x:pad.l-10,y:y(v)+4,'text-anchor':'end',fill:css('--muted'),'font-size':11.5,
      'font-variant-numeric':'tabular-nums'}); tx.textContent=fmt(v); g.append(tx);
  });
  ticks(T0,T1,6).forEach(v=>{
    if(v<T0-1e-9||v>T1+1e-9) return;
    const tx=el('text',{x:x(v),y:H-12,'text-anchor':'middle',fill:css('--muted'),'font-size':11.5,
      'font-variant-numeric':'tabular-nums'}); tx.textContent=fmt(v); g.append(tx);
  });
  g.append(el('line',{x1:pad.l,x2:W-pad.r,y1:pad.t+ph,y2:pad.t+ph,stroke:css('--axis'),'stroke-width':1}));
  const yl=el('text',{x:14,y:pad.t+ph/2,fill:css('--muted'),'font-size':11.5,
    transform:'rotate(-90 14 '+(pad.t+ph/2)+')','text-anchor':'middle'});
  yl.textContent='Concentration'; g.append(yl);
  const xl=el('text',{x:pad.l+pw/2,y:H-1,fill:css('--muted'),'font-size':11.5,'text-anchor':'middle'});
  xl.textContent='Time'; g.append(xl);

  const cp=el('clipPath',{id:'plotClip'});
  cp.append(el('rect',{x:pad.l,y:pad.t-4,width:pw,height:ph+4})); svg.append(cp);
  const plot=el('g',{'clip-path':'url(#plotClip)'}); svg.append(plot);

  const a=Math.max(0,i0-1), b=Math.min(last,i1+1), ends=[];
  shown.forEach(i=>{
    const c=hueOf(i), dash=dashOf(i), col=r.cols[i];
    let d=''; for(let k=a;k<=b;k++) d+=(k===a?'M':'L')+x(t[k]).toFixed(2)+' '+y(col[k]).toFixed(2);
    plot.append(el('path',{d,fill:'none',stroke:c,'stroke-width':2,
                           'stroke-linejoin':'round','stroke-linecap':'round',
                           ...(dash ? {'stroke-dasharray':dash} : {})}));
    if(i1===last){
      const ey=y(col[last]);
      plot.append(el('circle',{cx:x(t[last]),cy:ey,r:4,fill:c,stroke:css('--surface'),'stroke-width':2}));
      ends.push({y:ey,n:r.names[i]});
    }
  });
  // direct end-labels only where they don't collide — never stacked
  ends.sort((p,q)=>p.y-q.y);
  if(shown.length<=5 && ends.every((e,i)=> i===0 || e.y-ends[i-1].y>=14))
    ends.forEach(e=>{ const tx=el('text',{x:W-pad.r+10,y:e.y+4,fill:css('--ink-2'),'font-size':12});
                      tx.textContent=e.n; g.append(tx); });

  // where Tellurium's solver says the trajectory has reached steady state
  if(r.settled && r.settleTime > T0 && r.settleTime < T1){
    const sx=x(r.settleTime);
    plot.append(el('line',{x1:sx,x2:sx,y1:pad.t,y2:pad.t+ph,stroke:css('--muted'),
                           'stroke-width':1,'stroke-dasharray':'3 3'}));
    const lb=el('text',{x:sx-6,y:pad.t+12,'text-anchor':'end',fill:css('--muted'),'font-size':11});
    lb.textContent='steady state · t='+fmt(r.settleTime); plot.append(lb);
  }

  if(target) return;
  const cross=el('line',{y1:pad.t,y2:pad.t+ph,stroke:css('--axis'),'stroke-width':1,opacity:0});
  svg.append(cross);
  const dots=el('g',{opacity:0}); svg.append(dots);
  const hit=el('rect',{x:pad.l,y:pad.t,width:pw,height:ph,fill:'transparent'}); svg.append(hit);
  const tip=$('#tip');
  const hide=()=>{ cross.setAttribute('opacity',0); dots.setAttribute('opacity',0); tip.style.opacity=0; };
  hit.addEventListener('mousemove',ev=>{
    if(S.panning) return hide();
    const rect=svg.getBoundingClientRect();
    const tv=T0+(ev.clientX-rect.left-pad.l)/pw*(T1-T0);
    const i=Math.max(0,Math.min(last,Math.round((tv-t[0])/((t[last]-t[0])/last||1))));
    cross.setAttribute('x1',x(t[i])); cross.setAttribute('x2',x(t[i])); cross.setAttribute('opacity',1);
    dots.textContent=''; dots.setAttribute('opacity',1);
    let rows='<div class="t">t = '+fmt(t[i])+'</div>';
    shown.forEach(j=>{
      const c=hueOf(j), v=r.cols[j][i];
      dots.append(el('circle',{cx:x(t[i]),cy:y(v),r:4.5,fill:c,stroke:css('--surface'),'stroke-width':2}));
      rows+='<div class="row"><span style="display:inline-flex;align-items:center;gap:7px">'+
        '<span style="width:9px;height:9px;border-radius:50%;background:'+c+'"></span>'+
        esc(r.names[j])+'</span><b>'+fmt(v)+'</b></div>';
    });
    tip.innerHTML=rows; tip.style.opacity=1;
    const px=x(t[i]);
    tip.style.left=Math.min(W-tip.offsetWidth-8,Math.max(8,px+14))+'px';
    tip.style.top=Math.max(8,Math.min(H-tip.offsetHeight-8,ev.clientY-rect.top-30))+'px';
  });
  hit.addEventListener('mouseleave',hide);
  if(!$('#tablePage').hidden) renderTable();
}

export function showTable(on){
  $('#tablePage').hidden=!on;
  $('#tableBtn').setAttribute('aria-pressed',on);
  if(on){ renderTable(); $('#tableDone').focus(); }
}

/* ---------------- time-axis zoom & pan ---------------- */
const span = () => S.result ? [S.result.t[0], S.result.t[S.result.t.length-1]] : [0,1];

export function setView(t0,t1){
  const [F0,F1]=span(), full=F1-F0, min=full/500;
  if(t1-t0 >= full-1e-9) S.view=null;
  else{
    const w=Math.max(min,t1-t0);
    t0=Math.max(F0,Math.min(t0,F1-w)); S.view={t0,t1:t0+w};
  }
  draw();
}
export function zoomAt(factor, tAnchor){
  if(!S.result) return;
  const [F0,F1]=span(), t0=S.view?S.view.t0:F0, t1=S.view?S.view.t1:F1;
  const a = tAnchor ?? (t0+t1)/2, w=(t1-t0)*factor, n0=a-(a-t0)*factor;
  setView(n0, n0+w);
}

export function initChartInteractions(){
  $('#zoomIn').onclick    = ()=>zoomAt(1/1.6);
  $('#zoomOut').onclick   = ()=>zoomAt(1.6);
  $('#zoomReset').onclick = ()=>{ S.view=null; draw(); };
  $('#svgWrap').addEventListener('dblclick', ()=>{ S.view=null; draw(); });
  $('#svgWrap').addEventListener('wheel', e=>{
    if(!S.geom||!S.result) return;
    e.preventDefault();
    const rect=$('#chart').getBoundingClientRect(), g=S.geom;
    const tA=g.T0+(e.clientX-rect.left-g.pad.l)/g.pw*(g.T1-g.T0);
    zoomAt(e.deltaY>0?1.12:1/1.12, Math.max(g.T0,Math.min(g.T1,tA)));
  }, {passive:false});
  $('#svgWrap').addEventListener('mousedown', e=>{
    if(!S.view||!S.geom||e.button!==0) return;
    S.panning=true; $('#svgWrap').classList.add('panning');
    const x0=e.clientX, v0={...S.view}, perPx=(S.geom.T1-S.geom.T0)/S.geom.pw;
    const mv=ev=>setView(v0.t0-(ev.clientX-x0)*perPx, v0.t1-(ev.clientX-x0)*perPx);
    const up=()=>{ S.panning=false; $('#svgWrap').classList.remove('panning');
                   removeEventListener('mousemove',mv); removeEventListener('mouseup',up); };
    addEventListener('mousemove',mv); addEventListener('mouseup',up);
  });
  $('#tableBtn').onclick  = ()=>showTable(true);
  $('#tableDone').onclick = ()=>showTable(false);
  new ResizeObserver(()=>{ clearTimeout(window.__rz); window.__rz=setTimeout(draw,60); })
    .observe($('#svgWrap'));
}
