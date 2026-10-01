// ============================================================================
// app.js — the screens: start + history, change cards, page viewer, compare, download.
// ============================================================================
(function(){
  try{
    const src=atob(window.__WORKER), u=new Uint8Array(src.length); for(let i=0;i<src.length;i++) u[i]=src.charCodeAt(i);
    pdfjsLib.GlobalWorkerOptions.workerSrc=URL.createObjectURL(new Blob([u],{type:'text/javascript'}));
  }catch(e){ console.warn('worker',e); }
})();

const MAX_MB=80, WARN_PAGES=40;
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const esc=s=>String(s??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const state={ filter:'attn', name:'', version:1, bytes:null, pdf:null, pages:[], changes:[], meta:{}, out:null, outPdf:null, beforeImgs:[], afterImgs:[], built:null, saved:false, saving:false, view:'before', busy:false, nextN:1, marking:false, pickFor:null, rev:0 };

const UI={
  status(c){
    if (!c.include || c.action==='skip') return 'skip';
    if ((c.action==='replace'||c.action==='insert') && !String(c.text).trim()) return 'need';
    if (!c.rects.length && !String(c.find).trim()) return 'need';
    if (c.action==='move' && !c.moveTo && c.moveY==null) return 'need';
    if (c.manual && c.action==='replace' && String(c.text).trim()===String(c.targetText).trim()) return 'need';
    return c.level==='need' ? 'warn' : c.level;
  }
};
window.UI=UI;
const LABEL={ ok:['Ready','b-ok'], warn:['Double-check','b-warn'], need:['Needs you','b-need'], skip:['Leaving as is','b-skip'] };

// ---------- small helpers ----------
function toast(msg){ const t=$('#toast'); t.textContent=msg; t.hidden=false; clearTimeout(toast._t); toast._t=setTimeout(()=>t.hidden=true,3200); }
function busy(on,msg='Working…'){
  state.busy=on; let el=$('.busy');
  if (on){ if(!el){ el=document.createElement('div'); el.className='busy'; el.innerHTML='<div></div>'; document.body.appendChild(el); } el.firstChild.textContent=msg; }
  else if (el) el.remove();
  $$('#go,#both,#restart').forEach(b=>b.disabled=on);
  for (const el of [$('main'), $('#bar')]) { if (on) el.setAttribute('inert',''); else el.removeAttribute('inert'); }
}
function setStep(n){ $$('#steps li').forEach(li=>{ const s=+li.dataset.s; li.classList.toggle('on',s===n); li.classList.toggle('done',s<n); }); }
function download(bytesOrBlob, filename){
  const blob = bytesOrBlob instanceof Blob ? bytesOrBlob : new Blob([bytesOrBlob],{type:'application/pdf'});
  const url=URL.createObjectURL(blob), a=document.createElement('a');
  a.href=url; a.download=filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 30000);
}
const fmtSize=b=> b>1e6 ? (b/1e6).toFixed(1)+' MB' : Math.max(1,Math.round(b/1e3))+' KB';
const fmtDate=t=> new Date(t).toLocaleString(undefined,{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'});
const safeName=s=>String(s).replace(/[\\/:*?"<>|]+/g,'-').trim()||'document';
const outName=()=> `${safeName(state.name)} - updated${state.version>1?' v'+state.version:''}`;

// ---------- loading ----------
async function loadFile(file){
  if (state.busy || state.loading) return;
  $('#err').textContent='';
  if (!file) return;
  state.loading=true; try{ await loadFileInner(file); } finally { state.loading=false; }
}
async function loadFileInner(file){
  if (!/\.pdf$/i.test(file.name) && file.type!=='application/pdf'){ $('#err').textContent='Please choose a PDF file.'; return; }
  if (file.size > MAX_MB*1e6){ $('#err').textContent=`That file is ${fmtSize(file.size)}. Files up to ${MAX_MB} MB work here.`; return; }
  const bytes=new Uint8Array(await file.arrayBuffer());
  await loadBytes(bytes, file.name.replace(/\.pdf$/i,''));
}
async function loadBytes(bytes, name, version=1){
  if (state.busy) return;
  busy(true,'Reading the PDF…');
  try{
    if (String.fromCharCode(...bytes.slice(0,1024)).indexOf('%PDF')<0) throw new Error('not-pdf');
    releaseDocs();
    const { pdf, pages, changes, meta } = await Engine.read(bytes);
    // pdf-lib must be able to write it: a PDF locked against editing (owner password) is caught here, before she starts
    try{ await PDFLib.PDFDocument.load(bytes,{updateMetadata:false}); }
    catch(err){ try{ pdf.destroy(); }catch{} if (/encrypt/i.test(err?.message||'')) throw new Error('locked'); throw err; }
    if (meta.pureXfa) throw new Error('xfa');
    Object.assign(state,{ name, version, bytes, pdf, pages, changes, meta, out:null, outPdf:null, afterImgs:[], built:null, saved:false, saving:false, view:'before', nextN:changes.length+1, marking:false, pickFor:null, rev:0 });
    $('#start').hidden=true; $('#work').hidden=false; $('#bar').hidden=false; document.body.classList.add('working');
    const notes=[];
    if (meta.signed) notes.push('This PDF has a signature field. Changing it will invalidate any signature already on it.');
    if (pages.length>WARN_PAGES) notes.push(`This PDF has ${pages.length} pages, so it may be slow.`);
    if (pages.some(p=>p.isScan)) notes.push('Some pages are scanned images. Text on those pages can’t be changed.');
    $('#banner').hidden=!notes.length; $('#banner').textContent=notes.join(' ');
    setStep(2);
    await renderBefore();
    Engine.finish(pages, changes);
    changes.forEach((c,i)=>c.n=i+1);
    state.filter = changes.some(c=>['warn','need'].includes(UI.status(c))) ? 'attn' : 'all';
    $$('.pill[data-f]').forEach(x=>x.setAttribute('aria-pressed',x.dataset.f===state.filter));
    renderCards(); renderPins(); setView('before');
    if (!changes.length) toast('No reviewer comments in this PDF. Drag across the page to mark a change.');
  }catch(e){
    console.error(e);
    const m = e?.message==='locked' ? 'This PDF is locked against editing. Open it in Preview or Acrobat, save a copy without security (File › Export, or Print › Save as PDF), then try that copy.'
      : e?.name==='PasswordException' || /password|encrypt/i.test(e?.message) ? 'This PDF is password-protected. Open it, remove the password, then try again.'
      : e?.message==='xfa' ? 'This is a special kind of form (XFA) that can’t be edited here. Save it as a regular PDF first.'
      : e?.message==='not-pdf' || e?.name==='InvalidPDFException' ? 'That file isn’t a readable PDF.'
      : 'That PDF couldn’t be read: '+(e?.message||e);
    $('#err').textContent=m; resetToStart(false);
  }finally{ busy(false); }
}

// ---------- rendering pages ----------
async function renderPdfPage(pdf, i, scale, mode){
  const page=await pdf.getPage(i+1), vp=page.getViewport({scale});
  const cv=document.createElement('canvas'); cv.width=Math.round(vp.width); cv.height=Math.round(vp.height);
  const ctx=cv.getContext('2d',{willReadFrequently:true});
  if (!ctx) throw new Error('This device ran out of memory for the page images. Try a smaller PDF.');
  await page.render({canvasContext:ctx, viewport:vp, annotationMode: mode ?? pdfjsLib.AnnotationMode.ENABLE}).promise;
  return { cv, vp, scale };
}
// one shown image per page (an <img> from a blob, not a canvas copy) keeps memory low on phones
async function renderImage(pdf, i, scale){
  const r=await renderPdfPage(pdf,i,scale);
  const blob=await new Promise(res=>r.cv.toBlob(res,'image/png'));
  r.cv.width=r.cv.height=0;                    // free the pixels now
  const url=URL.createObjectURL(blob), img=new Image(); img.src=url; await img.decode().catch(()=>{});
  return { img, url, vp:r.vp, scale };
}
function scaleFor(pg){ const w=pg.width||612, n=state.pages.length||1; return Math.min(n>12?1.5:2, 1400/w); }
function revoke(list){ for (const x of list||[]) if (x?.url) URL.revokeObjectURL(x.url); }
function releaseDocs(){
  try{ state.outPdf?.destroy(); }catch{} try{ state.pdf?.destroy(); }catch{}
  revoke(state.beforeImgs); revoke(state.afterImgs); state.beforeImgs=[]; state.afterImgs=[];
  Engine.canvases.length=0;
}
async function renderBefore(){
  Engine.canvases.length=0; state.beforeImgs=[];
  for (let i=0;i<state.pages.length;i++){
    const msg=$('.busy div'); if (msg) msg.textContent=`Reading page ${i+1} of ${state.pages.length}…`;
    Engine.canvases[i]=await renderPdfPage(state.pdf,i,scaleFor(state.pages[i]), pdfjsLib.AnnotationMode.DISABLE);   // bare page, for analysis
    state.beforeImgs[i]=await renderImage(state.pdf,i,Math.min(1.5,scaleFor(state.pages[i])));                     // what she sees
  }
}
function pageEl(info, kind, idx){
  const w=document.createElement('div'); w.className='pagewrap '+kind; w.dataset.page=idx;
  const img=document.createElement('img'); img.src=info.url; img.alt=`${kind==='before'?'Original':'Updated'} page ${idx+1}`; img.draggable=false;
  w.appendChild(img);
  const lab=document.createElement('span'); lab.className='plabel'; lab.textContent=(kind==='before'?'Original':'Updated')+' · p'+(idx+1); w.appendChild(lab);
  return w;
}
function setView(v){
  if ((v==='after'||v==='both') && !state.afterImgs.length) v='before';
  state.view=v;
  $$('.seg button').forEach(b=>{ b.classList.toggle('on',b.dataset.v===v); b.setAttribute('aria-selected',b.dataset.v===v); });
  $$('.seg button[data-v="after"],.seg button[data-v="both"]').forEach(b=>b.disabled=!state.afterImgs.length);
  const host=$('#pages'); host.innerHTML='';
  for (let i=0;i<state.pages.length;i++){
    const row=document.createElement('div'); row.className='pagerow'+(v==='both'?' two':'');
    if (v!=='after') row.appendChild(pageEl(state.beforeImgs[i],'before',i));
    if (v!=='before' && state.afterImgs[i]) row.appendChild(pageEl(state.afterImgs[i],'after',i));
    host.appendChild(row);
  }
  $('#hint').textContent = v==='before' ? 'Drag across anything on the page to change it. On a phone, tap Mark a change first.' : 'Comparing the updated PDF. Switch to Original to mark more changes.';
  renderPins(); bindDrawing();
}
function pinRectPct(c){
  const pg=state.pages[c.page], r=c.rects.length?Engine.union(c.rects):c.pinRect, vp=pg.vp;
  const [x0,y0,x1,y1]=vp.convertToViewportRectangle(r);
  return { left:Math.min(x0,x1)/vp.width*100, top:Math.min(y0,y1)/vp.height*100, width:Math.max(8,Math.abs(x1-x0))/vp.width*100, height:Math.max(8,Math.abs(y1-y0))/vp.height*100 };
}
function renderPins(){
  $$('.pin,.target-line').forEach(p=>p.remove());
  for (const c of state.changes){
    const wrap=$(`.pagewrap.before[data-page="${c.page}"]`); if(!wrap) continue;
    const p=pinRectPct(c), el=document.createElement('div');
    const s=UI.status(c);
    el.className='pin'+(s==='warn'?'':' '+s)+(c.manual?' mine':''); el.dataset.n=c.n;
    Object.assign(el.style,{left:p.left+'%',top:p.top+'%',width:p.width+'%',height:p.height+'%'});
    el.innerHTML=`<b>${c.n}</b>`; el.title=`Change ${c.n}`;
    el.addEventListener('click',e=>{ e.stopPropagation(); focusChange(c.n,true); });
    wrap.appendChild(el);
    if (c.action==='move' && c.moveY!=null){
      const pg=state.pages[c.page], line=document.createElement('div'); line.className='target-line';
      line.style.top=((pg.view[3]-c.moveY)/(pg.view[3]-pg.view[1])*100)+'%'; wrap.appendChild(line);
    }
  }
}
function focusChange(n, scrollCard){
  $$('.card.focus,.pin.focus').forEach(e=>e.classList.remove('focus'));
  const ch=state.changes.find(x=>x.n==n); if (ch && !ch.open){ ch.open=true; const el0=$(`.card[data-n="${n}"]`); if (el0) paint(el0,ch); }
  const card=$(`.card[data-n="${n}"]`), pin=$(`.pin[data-n="${n}"]`);
  card?.classList.add('focus'); pin?.classList.add('focus');
  (scrollCard?card:pin)?.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'center'});
}

// ---------- marking changes on the page ----------
function pagePoint(wrap, ev){
  const r=wrap.getBoundingClientRect(), pg=state.pages[+wrap.dataset.page], v=pg.view;
  const fx=Math.min(1,Math.max(0,(ev.clientX-r.left)/r.width)), fy=Math.min(1,Math.max(0,(ev.clientY-r.top)/r.height));
  return { x:v[0]+fx*(v[2]-v[0]), y:v[3]-fy*(v[3]-v[1]), fx, fy };
}
function bindDrawing(){
  $$('.pagewrap.before').forEach(wrap=>{
    let start=null, rub=null;
    wrap.onpointerdown=ev=>{
      if (state.busy || ev.button>0) return;
      if (state.pickFor){ ev.preventDefault(); return pickSpot(wrap, ev); }
      const allowed = state.marking || ev.pointerType==='mouse';
      if (!allowed) return;
      if (ev.target.closest('.pin')) return;
      ev.preventDefault(); try{ wrap.setPointerCapture(ev.pointerId); }catch{}
      start=pagePoint(wrap,ev); rub=document.createElement('div'); rub.className='rubber'; wrap.appendChild(rub);
    };
    wrap.onpointermove=ev=>{
      if (!start) return; const p=pagePoint(wrap,ev);
      Object.assign(rub.style,{left:Math.min(start.fx,p.fx)*100+'%',top:Math.min(start.fy,p.fy)*100+'%',width:Math.abs(p.fx-start.fx)*100+'%',height:Math.abs(p.fy-start.fy)*100+'%'});
    };
    const end=ev=>{
      if (!start) return; const p=pagePoint(wrap,ev), s=start; start=null; rub?.remove();
      const pg=state.pages[+wrap.dataset.page];
      const r=[Math.min(s.x,p.x),Math.min(s.y,p.y),Math.max(s.x,p.x),Math.max(s.y,p.y)];
      if (r[2]-r[0]<4 && r[3]-r[1]<4) return;          // a click, not a drag
      addManual(+wrap.dataset.page, r);
      if (ev.pointerType!=='mouse') setMarking(false);
    };
    wrap.onpointerup=end; wrap.onpointercancel=()=>{ start=null; rub?.remove(); };
  });
}
function setMarking(on){ state.marking=on; $('#markBtn').setAttribute('aria-pressed',on); $('#markBtn').textContent=on?'Drag on the page…':'Mark a change'; document.body.classList.toggle('marking',on); }
function addManual(pageIdx, r){
  const pg=state.pages[pageIdx];
  if (pg.isScan){ toast('This page is a scanned image, so its text can’t be changed.'); return; }
  if (pg.rotate){ toast('This page is rotated, so it can’t be edited here.'); return; }
  // snap to the text the box touches
  const sl=Engine.slicesInRect(pg.items,r);
  let rects=[r], targetText='', base=null;
  if (sl.length){
    rects=Engine.mergeLines(sl.map(s=>[s.x, s.item.y0, s.x1, s.item.y1]));
    const bits=rects.map(x=>Engine.textInRect(pg.items,x));
    targetText=bits.map(b=>b.text).filter(Boolean).join(' '); base=bits.find(b=>b.base)?.base||null;
  }
  const c=Engine.newChange({ id:'m'+Date.now(), n:state.nextN++, page:pageIdx, subtype:'Manual', manual:true, note:'', author:'You',
    rects, pinRect:Engine.union(rects), targetText, base,
    action: targetText ? 'replace' : 'insert', text: targetText, level:'ok',
    why: targetText ? 'Type the new wording below, or choose Remove.' : 'Type the text to add here.' });
  c.boxes=pg.widgets.filter(w=>Engine.inside(w.rect,c.rects));
  Engine.repeatPages(state.pages, c);
  state.changes.push(c); state.changes.sort((a,b)=>a.page-b.page || Engine.union(b.rects.length?b.rects:[b.pinRect])[3]-Engine.union(a.rects.length?a.rects:[a.pinRect])[3]);
  stale(); renderCards(); renderPins(); focusChange(c.n,true);
  const ta=$(`.card[data-n="${c.n}"] textarea`); if (ta){ ta.focus(); ta.select(); }
}
function pickSpot(wrap, ev){
  const c=state.pickFor; state.pickFor=null; document.body.classList.remove('picking');
  if (+wrap.dataset.page!==c.page){ toast('Rows can only move within the same page.'); return; }
  c.moveY=pagePoint(wrap,ev).y; c.moveTo=null; c.level='warn';
  c.why='The row will go after the row you clicked. Check the preview.';
  stale(); renderCards(); renderPins(); focusChange(c.n,true);
}

// ---------- cards ----------
function cropURL(info, pg, r, padX=36, padY=10){
  if (!info || !info.img || !info.img.naturalWidth) return '';
  const v=pg.view;
  const x0=Math.max(v[0],r[0]-padX), x1=Math.min(v[2],r[2]+padX), y0=Math.max(v[1],r[1]-padY), y1=Math.min(v[3],r[3]+padY);
  const k=info.img.naturalWidth/(v[2]-v[0]);
  const sx=(x0-v[0])*k, sy=(v[3]-y1)*k, sw=(x1-x0)*k, sh=(y1-y0)*k;
  if (sw<2||sh<2) return '';
  const cv=document.createElement('canvas'), z=Math.min(1, 900/sw); cv.width=Math.round(sw*z); cv.height=Math.round(sh*z);
  cv.getContext('2d').drawImage(info.img, sx,sy,sw,sh, 0,0,cv.width,cv.height);
  const url=cv.toDataURL('image/png'); cv.width=cv.height=0; return url;
}
function cropRectFor(c){
  const pg=state.pages[c.page];
  let r=c.rects.length?Engine.union(c.rects):c.pinRect;
  if (c.find){ const f=Engine.findText(pg,c.find); if (f) r=f.rects[0]; }
  const v=pg.view;
  if (c.action==='move' || (c.action==='remove' && c.closeGap)) r=[v[0], Math.max(v[1],r[1]-60), v[2], Math.min(v[3],r[3]+60)];
  else r=[Math.max(v[0],r[0]-10), r[1], Math.min(v[2], Math.max(r[2], r[0]+260)), r[3]];
  return r;
}
function renderCards(){
  const host=$('#cards'); host.innerHTML='';
  const n=state.changes.length;
  $('#listTitle').textContent = n ? `${n} change${n===1?'':'s'}` : 'Changes';
  if (!n){
    host.innerHTML=`<div class="card"><p class="note">No reviewer comments were found.</p><p class="why">Drag across any text on the page to change it, or across an empty spot to add text. On a phone, tap <b>Mark a change</b> first.</p><p class="tip">Comments made in Acrobat, Preview, Edge or Chrome (highlights, sticky notes, cross-outs) show up here automatically. Notes sent in an email don’t.</p></div>`;
  }
  for (const c of state.changes) host.appendChild(cardEl(c));
  summary();
}
function cardEl(c){
  const el=document.createElement('article'); el.className='card'; el.dataset.n=c.n;
  const pg=state.pages[c.page];
  const others = c.alsoPages.length ? c.alsoPages.map(q=>q+1) : [];
  el.innerHTML=`
    <div class="ctop"><span class="meta">#${c.n} · Page ${c.page+1}${c.author?' · '+esc(c.author):''}</span><span class="badge"></span></div>
    ${c.manual ? '<p class="note"><span class="badge b-mine">Your change</span></p>' : c.markOnly ? `<p class="note"><span class="badge b-skip">${esc(c.subtype)} mark</span>${c.note?` <q>${esc(c.note)}</q>`:''}</p>` : `<p class="note">${c.note?`<q>${esc(c.note).replace(/\n/g,'<br>')}</q>`:'<em>(no note)</em>'}</p>`}
    ${c.replies.length?`<p class="marked">Replies: ${c.replies.map(esc).join(' · ')}</p>`:''}
    ${c.targetText?`<p class="marked">Marked text: <mark>${esc(c.targetText)}</mark></p>`:''}
    <p class="why"></p>
    <div class="cmp one"></div>
    <button class="fold" type="button">Edit this change</button>
    <div class="fields">
      <label for="a${c.n}">Do this</label>
      <select id="a${c.n}" class="act">
        <option value="replace">Replace text</option><option value="remove">Remove it</option>
        <option value="insert">Add text here</option><option value="move">Move row</option><option value="skip">Leave as is</option>
      </select>
      <label for="f${c.n}" class="frow">Find</label><input id="f${c.n}" class="find frow" type="text" placeholder="Text on the page to change">
      <label for="t${c.n}" class="trow">New text</label><textarea id="t${c.n}" class="txt trow" rows="1"></textarea>
    </div>
    <p class="tip trow">Tip: <b>_</b> makes a checkbox, <b>___</b> makes a text box, and a line ending in “:” gets a text box.</p>
    <div class="opts">
      ${c.boxes.length?`<label class="tog orow-boxes"><input type="checkbox" class="drop"> Also remove the ${c.boxes.length} fill-in box${c.boxes.length===1?'':'es'} here</label>`:''}
      <label class="tog orow-gap"><input type="checkbox" class="gap"> Close the gap (rows below move up)</label>
      ${others.length?`<label class="tog orow-rep"><input type="checkbox" class="rep"> Also change page${others.length>1?'s':''} ${others.join(', ')} (same text, same spot)</label>`:''}
    </div>
    <div class="crow mrow"><button class="btn sm quiet mend">Move to end of section</button><button class="btn sm quiet mpick">Choose a spot on the page</button></div>
    ${c.manual?'<div class="crow"><button class="btn sm danger del">Delete this change</button></div>':''}`;
  const act=el.querySelector('.act'), txt=el.querySelector('.txt'), find=el.querySelector('.find');
  act.value=c.action; txt.value=c.text; find.value=c.find;
  const drop=el.querySelector('.drop'), gap=el.querySelector('.gap'), rep=el.querySelector('.rep');
  if (drop) drop.checked=c.dropBoxes; gap.checked=c.closeGap; if (rep) rep.checked=c.repeat;
  const changed=()=>{ stale(); paint(el,c); summary(); renderPins(); };
  act.onchange=()=>{ c.action=act.value; c.include=c.action!=='skip';
    if (c.level==='need' && c.action!=='skip') c.level='warn';
    if (c.action==='replace' && !c.text && c.targetText){ c.text=c.targetText; txt.value=c.text; }
    if (c.action==='remove') c.dropBoxes=true;
    changed(); };
  txt.oninput=()=>{ c.text=txt.value; changed(); };
  find.oninput=()=>{ c.find=find.value; const before=c.alsoPages.join();
    Engine.repeatPages(state.pages,c);
    if (c.alsoPages.join()!==before){ const fresh=cardEl(c); el.replaceWith(fresh); fresh.querySelector('.find').focus(); stale(); summary(); renderPins(); return; }
    changed(); };
  if (drop) drop.onchange=()=>{ c.dropBoxes=drop.checked; changed(); };
  gap.onchange=()=>{ c.closeGap=gap.checked; changed(); };
  if (rep) rep.onchange=()=>{ c.repeat=rep.checked; c._repeatSet=true; changed(); };
  el.querySelector('.mend').onclick=()=>{ c.moveTo='sectionEnd'; c.moveY=null; c.level='warn'; c.why='This row will move to the end of its section. Check the preview.'; changed(); };
  el.querySelector('.mpick').onclick=()=>{ if(state.view!=='before') setView('before'); state.pickFor=c; document.body.classList.add('picking'); toast('Now tap the row it should go after.'); $(`.pagewrap.before[data-page="${c.page}"]`)?.scrollIntoView({block:'center'}); };
  el.querySelector('.del')?.addEventListener('click',()=>{ state.changes=state.changes.filter(x=>x!==c); stale(); renderCards(); renderPins(); });
  el.querySelector('.fold').onclick=()=>{ c.open=true; paint(el,c); el.querySelector('select')?.focus(); };
  el.addEventListener('click',e=>{ if(!e.target.closest('select,textarea,input,button,label')) focusChange(c.n,false); });
  txt.addEventListener('input',()=>grow(txt));
  paint(el,c);
  return el;
}
function paint(el,c){
  const s=UI.status(c);
  el.classList.toggle('skip', s==='skip');
  // Ready ones fold to a line; the ones that need her stay open
  el.classList.toggle('folded', !c.open && (s==='ok' || (s==='skip' && c.level!=='need')));
  el.hidden = state.filter==='attn' && !(s==='warn' || s==='need' || c.open || c.manual);
  const b=el.querySelector('.badge:not(.b-mine)'); b.className='badge '+LABEL[s][1]; b.textContent=LABEL[s][0];
  el.querySelector('.why').textContent = s==='skip' && c.level!=='need' && !c.markOnly ? 'This one will be left as it is.' : c.why;
  const show=(sel,on)=>el.querySelectorAll(sel).forEach(x=>x.style.display=on?'':'none');
  show('.trow', c.action==='replace'||c.action==='insert');
  show('.frow', (!c.rects.length || String(c.find).trim()) && c.action!=='skip');
  show('.orow-boxes', c.action==='replace');
  show('.orow-gap', c.action==='remove');
  show('.orow-rep', c.action==='replace'||c.action==='remove');
  show('.mrow', c.action==='move');
  const t=el.querySelector('.txt'); t.rows=1; requestAnimationFrame(()=>grow(t));
  // compare
  const cmp=el.querySelector('.cmp'), pg=state.pages[c.page], r=cropRectFor(c);
  const before=cropURL(state.beforeImgs[c.page],pg,r);
  const after=state.afterImgs.length && s!=='skip' && s!=='need' ? cropURL(state.afterImgs[c.page],pg,r) : '';
  cmp.className='cmp'+(after?'':' one');
  cmp.innerHTML = before ? `<figure><figcaption>Before</figcaption><img alt="Before" src="${before}"></figure>`+(after?`<figure><figcaption>After</figcaption><img alt="After" src="${after}"></figure>`:'') : '';
}
function grow(t){ t.style.height='auto'; t.style.height=Math.min(240,t.scrollHeight+2)+'px'; }
function summary(){
  const k={ok:0,warn:0,need:0,skip:0}; state.changes.forEach(c=>k[UI.status(c)]++);
  const apply=k.ok+k.warn, attn=k.warn+k.need;
  $('#cAttn').textContent=attn; $('#cAll').textContent=state.changes.length;
  let note=$('#allgood'); if (!note){ note=document.createElement('p'); note.id='allgood'; note.className='empty'; $('#cards').before(note); }
  note.hidden = !(state.filter==='attn' && attn===0 && state.changes.length);
  note.textContent = 'Nothing needs checking — every change is ready. Choose All to see them.';
  $('#sum').innerHTML=`<b>${apply}</b> to apply`+(k.warn?` · <b>${k.warn}</b> to double-check`:'')+(k.need?` · <b style="color:var(--bad)">${k.need} need${k.need===1?'s':''} you</b>`:'')+(k.skip?` · ${k.skip} left as is`:'');
  const go=$('#go');
  if (state.out){ go.textContent='Download updated PDF'; $('#both').hidden=false; }
  else { go.textContent='Preview changes'; $('#both').hidden=true; go.disabled = state.busy || (apply===0 && !$('#strip').checked); }
}
function stale(){
  state.rev++;
  if (!state.out) return;
  try{ state.outPdf?.destroy(); }catch{} revoke(state.afterImgs);
  state.out=null; state.outPdf=null; state.afterImgs=[]; state.saved=false;
  $('#done').hidden=true; setStep(2);
  if (state.view!=='before') setView('before');
  $$('.seg button[data-v="after"],.seg button[data-v="both"]').forEach(b=>b.disabled=true);
}

// ---------- build, compare, download ----------
async function preview(){
  if (state.busy) return;
  busy(true,'Making the updated PDF…');
  const rev=state.rev;
  try{
    const { out, log, stats } = await Apply.build(state, { strip:$('#strip').checked });
    try{ state.outPdf?.destroy(); }catch{} revoke(state.afterImgs); state.afterImgs=[];
    const outPdf=await pdfjsLib.getDocument({data:out.slice(), isEvalSupported:false}).promise;
    const imgs=[];
    for (let i=0;i<outPdf.numPages;i++) imgs[i]=await renderImage(outPdf,i,Math.min(1.5,scaleFor(state.pages[i]||{})));
    if (rev!==state.rev){ outPdf.destroy(); revoke(imgs); toast('Something changed while the preview was being made. Preview again.'); return; }
    state.out=out; state.outPdf=outPdf; state.afterImgs=imgs; state.saved=false;
    const applied=state.changes.filter(c=>['ok','warn'].includes(UI.status(c))).length;
    state.built={ applied, log, stats };
    const bits=[`${applied} change${applied===1?'':'s'} applied`];
    if (stats.removedBoxes) bits.push(`${stats.removedBoxes} fill-in box${stats.removedBoxes===1?'':'es'} removed`);
    if (stats.newFields+stats.newBoxes) bits.push(`${stats.newFields+stats.newBoxes} new fill-in box${stats.newFields+stats.newBoxes===1?'':'es'} added`);
    if (stats.rowOps) bits.push(`${stats.rowOps} row${stats.rowOps===1?'':'s'} moved or closed up`);
    $('#done').innerHTML=`<strong>Preview ready. Compare, then download.</strong>${esc(bits.join(' · '))}`+(log.length?`<div class="log">${log.map(esc).join('<br>')}</div>`:'');
    $('#done').hidden=false;
    setStep(3); setView('both'); renderCards();
  }catch(e){
    console.error(e); state.out=null;
    $('#done').innerHTML=`<span style="color:var(--bad)">The update couldn’t be made: ${esc(e?.message||e)}. Your original is unchanged.</span>`; $('#done').hidden=false;
  }finally{ busy(false); summary(); }
}
function changeSummary(){
  const lines=[`Changes to ${state.name}${state.version>1?` (round ${state.version})`:''} — ${fmtDate(Date.now())}`,''];
  for (const c of state.changes){
    const s=UI.status(c); if (s==='skip'||s==='need') continue;
    const where=`Page ${c.page+1}`+(c.repeat&&c.alsoPages.length?` (and ${c.alsoPages.map(q=>q+1).join(', ')})`:'');
    const from=c.find||c.targetText;
    const what = c.action==='remove' ? `Removed “${from}”${c.closeGap?' and closed the gap':''}`
      : c.action==='replace' ? `Changed “${from}” to “${c.text.replace(/\s*\n\s*/g,' / ')}”`
      : c.action==='insert' ? `Added “${c.text.replace(/\s*\n\s*/g,' / ')}”`
      : c.action==='move' ? `Moved the row “${from}”` : '';
    lines.push(`${where}: ${what}${c.note&&!c.manual?`  [note: ${c.note.replace(/\s+/g,' ')}]`:''}`);
  }
  if (state.built?.log?.length){ lines.push('','Notes:',...state.built.log); }
  return lines.join('\n');
}
async function saveHistory(){
  if (state.saved || state.saving || !state.out) return;
  state.saving=true;
  try{
    await Store.save({ name:state.name, version:state.version, savedAt:Date.now(), applied:state.built?.applied||0, summary:changeSummary(), original:state.bytes.slice().buffer, updated:state.out.slice().buffer });
    state.saved=true; toast('Saved to history on this device.');
  }catch(e){ console.warn('history',e); toast('Downloaded. History isn’t available in this browser, so keep the file.'); }
  finally{ state.saving=false; }
}
async function onGo(){
  if (state.busy) return;
  if (!state.out) return preview();
  download(state.out, `${outName()}.pdf`);
  await saveHistory();
}
async function onBoth(){
  if (state.busy || !state.out) return;
  const enc=new TextEncoder(), n=safeName(state.name), o=outName(), before=state.version>1?`${n} - before v${state.version}`:`${n} - original`;
  download(Store.zip([{name:`${before}.pdf`,data:state.bytes},{name:`${o}.pdf`,data:state.out},{name:`${o} - changes.txt`,data:enc.encode(changeSummary())}]), `${o} (with original).zip`);
  await saveHistory();
}

// ---------- history ----------
async function renderHistory(){
  const host=$('#history');
  if (!(await Store.available())){ host.innerHTML='<p class="empty">History isn’t available in this browser (it may be a private window). Downloads still work.</p>'; return; }
  let rows=[]; try{ rows=await Store.list(); }catch(e){ console.warn(e); }
  if (!rows.length){ host.innerHTML='<p class="empty">Updated PDFs you download are kept here, so you can get any version back.</p>'; }
  else host.innerHTML=rows.map(r=>`<div class="hrow" data-id="${r.id}">
      <div><div class="hname">${esc(r.name)}${(r.version||1)>1?` <span class="badge b-skip">v${r.version}</span>`:''}</div><div class="hsub">${esc(fmtDate(r.savedAt))} · ${r.applied} change${r.applied===1?'':'s'} · ${fmtSize(r.sizeUpdated)}</div></div>
      <div class="hact"><button class="btn sm" data-a="upd">Updated</button><button class="btn sm quiet" data-a="orig">Before</button><button class="btn sm quiet" data-a="log">Changes</button><button class="btn sm quiet" data-a="cont">Continue editing</button><button class="btn sm quiet danger" data-a="del" aria-label="Delete ${esc(r.name)}">Delete</button></div>
    </div>`).join('');
  host.querySelectorAll('button[data-a]').forEach(b=>b.onclick=async()=>{
    const id=+b.closest('.hrow').dataset.id;
    try{
      const rec=await Store.get(id); if(!rec) return renderHistory();
      const n=safeName(rec.name), ver=rec.version||1, tag=ver>1?` v${ver}`:'';
      if (b.dataset.a==='upd') download(new Uint8Array(rec.updated), `${n} - updated${tag}.pdf`);
      if (b.dataset.a==='orig') download(new Uint8Array(rec.original), ver>1?`${n} - before v${ver}.pdf`:`${n} - original.pdf`);
      if (b.dataset.a==='log') download(new Blob([rec.summary||''],{type:'text/plain'}), `${n} - updated${tag} - changes.txt`);
      if (b.dataset.a==='cont') await loadBytes(new Uint8Array(rec.updated), rec.name, ver+1);
      if (b.dataset.a==='del'){ if (confirm(`Delete “${rec.name}” from history? This can’t be undone.`)){ await Store.remove(id); renderHistory(); } }
    }catch(e){ toast('That version couldn’t be opened.'); console.warn(e); }
  });
  const u=rows.length ? await Store.usage() : null; $('#usage').textContent = u&&u.usage ? `${fmtSize(u.usage)} used` : '';
}
function resetToStart(clearErr=true){
  $('#file').value=''; $('#start').hidden=false; $('#work').hidden=true; $('#bar').hidden=true; document.body.classList.remove('working');
  if (clearErr) $('#err').textContent='';
  releaseDocs(); state.out=null; state.outPdf=null; state.pdf=null; setMarking(false); state.pickFor=null; document.body.classList.remove('picking');
  setStep(1); renderHistory();
}

// ---------- wiring ----------
$('#drop').onclick=()=>$('#file').click();
$('#drop').onkeydown=e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); $('#file').click(); } };
$('#file').onchange=e=>loadFile(e.target.files[0]);
['dragover','dragenter'].forEach(ev=>document.addEventListener(ev,e=>{ e.preventDefault(); if(!$('#start').hidden) $('#drop').classList.add('over'); }));
['dragleave','drop'].forEach(ev=>document.addEventListener(ev,e=>{ e.preventDefault(); $('#drop').classList.remove('over'); }));
document.addEventListener('drop',e=>{ const f=e.dataTransfer?.files?.[0]; if(f && !$('#start').hidden) loadFile(f); });
$$('.seg button').forEach(b=>b.onclick=()=>setView(b.dataset.v));
$$('.pill[data-f]').forEach(b=>b.onclick=()=>{ state.filter=b.dataset.f; $$('.pill[data-f]').forEach(x=>x.setAttribute('aria-pressed',x===b)); renderCards(); });
$('#markBtn').onclick=()=>{ if(state.view!=='before') setView('before'); setMarking(!state.marking); };
$('#strip').onchange=()=>{ stale(); summary(); };
$('#restart').onclick=()=>{ if (state.changes.some(c=>c.manual) && !state.saved && !confirm('Start over? Changes you marked will be lost.')) return; resetToStart(); };
$('#go').onclick=onGo; $('#both').onclick=onBoth;
document.addEventListener('keydown',e=>{ if(e.key==='Escape'){ setMarking(false); state.pickFor=null; document.body.classList.remove('picking'); } });
window.addEventListener('beforeunload',e=>{ if (state.out && !state.saved){ e.preventDefault(); e.returnValue=''; } });
renderHistory();
window.__app={ state, UI, Engine, Apply, Store, addManual, preview, setView };
