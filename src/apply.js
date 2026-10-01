// ============================================================================
// apply.js — writes the updated PDF.
// Pass 1 (pdf-lib): erase + redraw text, new fill-in fields, remove/move widgets, strip comments.
// Pass 2 (rows):    rebuild pages from strips to close gaps and move rows; widgets follow.
// ============================================================================
const Apply = (() => {
  const E = Engine;
  const FONT_FILES = window.__FONTS || {};   // name -> base64 (injected at build)
  const b64 = s => { const bin=atob(s), u=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i); return u; };

  // ---------- fonts ----------
  function familyFor(rawName){
    const n=(rawName||'').toLowerCase();
    const bold=/bold|black|heavy|semibold|demi/.test(n);
    let fam='LiberationSans';
    if (/calibri|carlito|aptos|segoe|candara|corbel|constantia|gill|myriad/.test(n)) fam='Carlito';
    else if (/times|liberationserif|tinos|georgia|cambria|garamond|caladea|book ?antiqua|palatino|minion|serif/.test(n) && !/sans/.test(n)) fam='LiberationSerif';
    return { fam, bold };
  }
  function fontNameOf(state, pageIdx, base){
    if (!base || !base.font) return '';
    try{ const objs=state.pages[pageIdx].page.commonObjs; if (objs.has(base.font)){ const f=objs.get(base.font); return (f && (f.name||f.loadedName)) || ''; } }catch{}
    return '';
  }
  async function makeFontCache(doc){
    const { StandardFonts } = PDFLib;
    const cache={}; let fkOk=false;
    try{ if (window.fontkit){ doc.registerFontkit(window.fontkit); fkOk=true; } }catch{}
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    return async ({fam,bold}) => {
      const key=fam+(bold?'-Bold':'-Regular');
      if (cache[key]) return cache[key];
      let f=helv;
      if (fkOk && FONT_FILES[key]){ try{ f=await doc.embedFont(b64(FONT_FILES[key]), {subset:true}); }catch(e){ console.warn('font',key,e); f=helv; } }
      cache[key]=f; return f;
    };
  }
  const WIN={'‘':"'",'’':"'",'“':'"','”':'"','–':'-','—':'-','…':'...','•':'-',' ':' ','≤':'<=','≥':'>=','→':'->'};
  function safeText(font, s){
    let out='';
    const fk=font.embedder && font.embedder.font;
    for (const ch of s){
      if (fk && typeof fk.hasGlyphForCodePoint==='function'){ out += fk.hasGlyphForCodePoint(ch.codePointAt(0)) ? ch : (WIN[ch] && [...WIN[ch]].every(x=>fk.hasGlyphForCodePoint(x.codePointAt(0))) ? WIN[ch] : '?'); continue; }
      const c=WIN[ch]||ch; try{ font.encodeText(c); out+=c; }catch{ out+='?'; }
    }
    return out;
  }

  // ---------- placeholder-aware text layout ----------
  // tokens: {t:'text', s} | {t:'box'} (checkbox) | {t:'field', w} (fixed text box) | {t:'fill'} (text box to end of line)
  function tokenize(text, allowFill=true){
    let lines=text.replace(/\r\n?/g,'\n').split('\n').map(l=>l.trim()).filter((l,i,a)=>l || (i>0&&i<a.length-1));
    // a short label-only line ("Comment:") joins the line before it
    const merged=[];
    for (const l of lines){
      if (merged.length && /^[^:]{1,24}:$/.test(l) && !/:$/.test(merged[merged.length-1])) merged[merged.length-1]+='   '+l;
      else merged.push(l);
    }
    return merged.map(line=>{
      const toks=[]; const re=/(_{3,})|(?:(^|\s)(_|☐|□|\[\s?\])(?=\s|$))/g; let last=0, m;
      while((m=re.exec(line))){
        const start=m.index + (m[2]?m[2].length:0);
        if (start>last) toks.push({t:'text', s:line.slice(last,start)});
        if (m[1]) toks.push({t:'field', n:m[1].length}); else toks.push({t:'box'});
        last=m.index+m[0].length;
      }
      if (last<line.length) toks.push({t:'text', s:line.slice(last)});
      const lastTok=toks[toks.length-1];
      // a short label at the end of the line ("Comment:", "Other:") gets a text box after it
      if (allowFill && lastTok && lastTok.t==='text' && /(^|[.?!]\s+|\s{2,})[^.?!:]{1,30}:\s*$/.test(lastTok.s)) toks.push({t:'fill'});
      return toks;
    });
  }
  const hasPlaceholders = text => tokenize(text).some(l=>l.some(t=>t.t!=='text'));
  function measure(font, tok, size){
    if (tok.t==='text') return font.widthOfTextAtSize(tok.s, size);
    if (tok.t==='box') return size*0.85 + size*0.35;
    if (tok.t==='field') return Math.max(50, tok.n*size*0.5);
    return 60;   // fill minimum
  }
  // split text tokens into words so lines can wrap
  function wrapTokens(font, lines, size, maxW){
    const out=[];
    for (const toks of lines){
      const words=[]; for (const t of toks){ if (t.t==='text'){ t.s.split(/(\s+)/).forEach(w=>{ if(w) words.push({t:'text',s:w}); }); } else words.push(t); }
      let cur=[], w=0;
      for (const wd of words){
        if (wd.t==='text' && /^\s+$/.test(wd.s)){ if(cur.length){ cur.push(wd); w+=measure(font,wd,size); } continue; }
        const ww=measure(font,wd,size);
        if (cur.length && w+ww>maxW){ while(cur.length && cur[cur.length-1].t==='text' && /^\s+$/.test(cur[cur.length-1].s)) cur.pop(); out.push(cur); cur=[]; w=0; }
        cur.push(wd); w+=ww;
      }
      out.push(cur);
    }
    return out;
  }
  const lineWidth=(font,line,size)=>line.reduce((a,t)=>a+(t.t==='fill'?60:measure(font,t,size)),0);

  // ---------- pass 1 ----------
  async function pass1(state, ctx){
    const { PDFDocument, rgb, PDFName, PDFDict } = PDFLib;
    const doc = await PDFDocument.load(state.bytes, { updateMetadata:false });
    if (doc.isEncrypted) throw new Error('This PDF is password-protected. Remove the password and try again.');
    const fontFor = await makeFontCache(doc);
    const form = doc.getForm();
    const pages = doc.getPages();
    const removeRects = pages.map(()=>[]);
    const moves=[];   // horizontal slides of kept boxes
    const nameUsed = new Set(form.getFields().map(f=>f.getName()));
    const uniq = base => { let n=(base||'Field').replace(/[.\s]+/g,' ').trim().slice(0,40)||'Field', k=n, i=2; while(nameUsed.has(k)) k=`${n} ${i++}`; nameUsed.add(k); return k; };
    const log=ctx.log, made={fields:0, boxes:0}, born=new Set();
    const track = f => { try{ for (const w of f.acroField.getWidgets()) { const r=doc.context.getObjectRef(w.dict); if(r) born.add(r.toString()); } }catch{} };

    // expand "also on pages" into concrete jobs
    const jobs=[];
    for (const c of state.changes){
      const st=UI.status(c); if (st==='skip'||st==='need') continue;
      if (c.action==='move') continue;   // pass 2
      jobs.push({c, page:c.page, rects:c.rects, base:c.base});
      if (c.repeat) for (const q of c.alsoPages){
        const bits=c.rects.map(r=>E.textInRect(state.pages[q].items,r));
        jobs.push({c, page:q, rects:c.rects, base:bits.find(b=>b.base)?.base||c.base, copy:true});
      }
    }

    // ---- prepare every job's geometry first (nothing drawn yet) ----
    const prepared=[], scrubRegions=pages.map(()=>[]);
    for (const job of jobs){
      const {c}=job; const pg=state.pages[job.page];
      let rects=job.rects, base=job.base;
      if (c.find.trim()){
        if (rects.length){
          // a highlight is the reviewer pointing: only look inside it
          const inside = { items: pg.items.filter(it=>rects.some(r=>E.overlapV(it.y0,it.y1,r[1],r[3])>0 && it.x1>r[0]-1 && it.x0<r[2]+1)) };
          const f=E.findText(inside,c.find); if (f){ rects=f.rects; base=f.base; }
        } else {
          const f=E.findText(pg,c.find);
          if (!f){ log.push(`#${c.n}: couldn’t find “${c.find}” on page ${job.page+1}, so it was skipped.`); continue; }
          rects=f.rects; base=f.base;
        }
      }
      if (!rects.length){ log.push(`#${c.n}: nothing is marked, so it was skipped.`); continue; }
      rects=rects.map(r=>r.slice());
      // the change covers only part of one run of text ("Date" inside "Date of birth:"): rewrite the whole run
      // with the change made inside it, so the old wording is truly deleted and the new run stays in one font
      let fullText=null;
      if ((c.action==='replace'||c.action==='remove') && rects.length===1 && !/\n/.test(c.text)){
        const r=rects[0];
        const hits=pg.items.filter(it=>it.str.trim() && E.overlapV(it.y0,it.y1,r[1],r[3])>(it.y1-it.y0)*0.5 && it.x1>r[0]+0.5 && it.x0<r[2]-0.5);
        // only when that run clearly stands alone: if other text touches it, the PDF may hold them as one piece,
        // so fall back to covering just the changed part
        const touches = it => pg.items.some(o=>o!==it && o.str && Math.abs(o.y-it.y)<0.6 && (Math.abs(o.x0-it.x1)<1.5 || Math.abs(it.x0-o.x1)<1.5));
        if (hits.length===1 && !touches(hits[0]) && (hits[0].x0<r[0]-1.5 || hits[0].x1>r[2]+1.5)){
          const it=hits[0], n=it.str.length, w=(it.x1-it.x0)||1;
          let s=Math.max(0,Math.round((r[0]-it.x0)/w*n)), e=Math.min(n,Math.round((r[2]-it.x0)/w*n));
          const want=(c.find.trim() || E.textInRect(pg.items,r).text || '').trim().toLowerCase();
          if (want){ let best=-1, bd=1e9, k=it.str.toLowerCase().indexOf(want); while(k>=0){ const d=Math.abs(k-s); if(d<bd){bd=d;best=k;} k=it.str.toLowerCase().indexOf(want,k+1); } if (best>=0){ s=best; e=best+want.length; } }
          const mid = c.action==='replace' ? c.text : '';
          fullText = (it.str.slice(0,s) + mid + it.str.slice(e)).replace(/\s{2,}/g,' ').replace(/^\s+/,'');
          rects=[[it.x0,it.y0,it.x1,it.y1]]; base=it;
        }
      }
      let boxesHere = pg.widgets.filter(w=>E.inside(w.rect,rects));
      // removing a label whose line holds nothing else (or replacing it with wording that brings its own
      // boxes): take the line's old fill-in boxes and blank lines too
      if (fullText==null && (c.action==='remove' || (c.action==='replace' && c.dropBoxes && hasPlaceholders(c.text)))){
        for (const r of [...rects]){
          const y0=base?Math.min(r[1],base.y0):r[1], y1=base?Math.max(r[3],base.y1):r[3];
          const onLine=it=>E.overlapV(it.y0,it.y1,y0,y1) > (it.y1-it.y0)*0.5;
          const rest=pg.items.filter(it=>it.str.trim() && onLine(it) && !(it.x0>=r[0]-1.5 && it.x1<=r[2]+1.5));
          if (rest.some(it=>!/^[\s_☐□○●▢]*$/.test(it.str))) continue;
          const orph=pg.widgets.filter(w=>E.overlapV(w.rect[1],w.rect[3],y0,y1) > (w.rect[3]-w.rect[1])*0.4 && !E.inside(w.rect,rects));
          for (const it of rest) rects.push([it.x0, it.y0, it.x1, it.y1]);
          for (const w of orph){ rects.push([w.rect[0], Math.max(w.rect[1], y0-2), w.rect[2], Math.min(w.rect[3], y1+2)]); boxesHere.push(w); }
        }
      }
      const keepBoxes = c.action==='replace' && !c.dropBoxes && boxesHere.length>0;
      const fam = familyFor(fontNameOf(state, job.page, base));
      const font = await fontFor(fam);
      const startSize = base ? base.size : Math.max(7,(rects[0][3]-rects[0][1])*0.72);
      let shift=null;
      if (keepBoxes && rects.length===1){
        const r=rects[0], firstX=Math.min(...boxesHere.map(b=>b.rect[0]));
        const need=font.widthOfTextAtSize(safeText(font,c.text.replace(/\s+/g,' ')), startSize)+10;
        if (r[0]+need > firstX){
          const groupW=r[2]-firstX, limit=E.roomRight(pg,r,base), newFirst=Math.min(r[0]+need, limit-groupW);
          if (newFirst > firstX+4) shift={dx:newFirst-firstX, labels:E.slicesInRect(pg.items,[firstX,r[1],r[2],r[3]]), boxes:boxesHere, maxW:newFirst-r[0]-8};
        }
      }
      if (keepBoxes && !shift){
        rects=rects.map(r=>{ const bx=pg.widgets.filter(w=>E.inside(w.rect,[r])).map(w=>w.rect[0]); return bx.length?[r[0],r[1],Math.max(r[0]+10,Math.min(...bx)-3),r[3]]:r; });
      }
      if (c.action==='remove' || c.action==='replace'){
        scrubRegions[job.page].push(...rects);
        if (shift) scrubRegions[job.page].push(...shift.labels.map(l=>[l.x, l.item.y0, l.x1, l.item.y1]));
      }
      prepared.push({job, c, pg, rects, base, boxesHere, keepBoxes, font, startSize, shift, fullText});
    }

    // ---- delete the old text for real (before anything new is drawn) ----
    let scrubbed=0;
    pages.forEach((page,pi)=>{ if (scrubRegions[pi].length){ try{ scrubbed+=Scrub.page(doc, page, state.pages[pi].items, scrubRegions[pi]); }catch(e){ console.warn('scrub',e); } } });
    ctx.stats.scrubbed=scrubbed;

    // ---- draw: every white cover first, then all new text (so one change's cover never hides another's text) ----
    for (const P of prepared){
      const {job, c, rects, base, boxesHere}=P; const page=pages[job.page];
      P.ink = c.action==='insert' ? [0,0,0] : E.inkColor(job.page, E.union(rects));
      const pad=1.2;
      if (c.action==='remove' || c.action==='replace'){
        for (const r of rects){
          const top=base?Math.max(r[3],base.y1):r[3], bot=base?Math.min(r[1],base.y0):r[1];
          page.drawRectangle({x:r[0]-pad, y:bot-pad, width:r[2]-r[0]+pad*2, height:top-bot+pad*2, color:rgb(1,1,1)});
        }
        if (c.action==='remove' || (c.action==='replace' && c.dropBoxes)){
          removeRects[job.page].push(...rects);
          for (const b of boxesHere){ const r=b.rect; page.drawRectangle({x:r[0]-1,y:r[1]-2,width:r[2]-r[0]+2,height:r[3]-r[1]+3,color:rgb(1,1,1)}); }
        }
        if (c.action==='remove' && c.closeGap && !job.copy) ctx.rowOps.push({type:'close', page:job.page, rects, n:c.n});
      }
    }
    for (const P of prepared){
      const {job, c, pg, rects, base, keepBoxes, font, startSize, shift, ink, fullText}=P; const page=pages[job.page];
      if (fullText!=null && !fullText.trim()) continue;          // the whole run was removed
      if (c.action==='replace' || c.action==='insert' || fullText!=null){
        const r0=rects[0], x=r0[0];
        const baseline = base ? base.y : r0[1]+(r0[3]-r0[1])*0.25;
        const maxW = shift ? shift.maxW : keepBoxes ? Math.max(30, rects[0][2]-x) : Math.max(40, E.roomRight(pg,E.union(rects),base)-x-3);
        const avail = (E.union(rects)[3]-E.union(rects)[1]) + startSize*0.3;
        const text = (fullText ?? c.text).replace(/\r\n?/g,'\n').split('\n').map(l=>safeText(font,l)).join('\n');
        // a label only gets a new text box if nothing on its line already serves as one
        const U=E.union(rects), ly0=base?base.y0:U[1], ly1=base?base.y1:U[3];
        const hasBoxAlready = keepBoxes || pg.widgets.some(w=>E.overlapV(w.rect[1],w.rect[3],ly0,ly1)>2 && w.rect[0]>=U[2]-3)
          || pg.items.some(it=>/_{3,}/.test(it.str) && E.overlapV(it.y0,it.y1,ly0,ly1)>0 && it.x0>=U[2]-3);
        // a rewritten run is the form's own content: its underscores stay underscores (only her new wording makes boxes)
        const tokLines = fullText!=null ? text.split('\n').map(l=>[{t:'text',s:l}]) : tokenize(text, !hasBoxAlready);
        let size=startSize, lines=wrapTokens(font,tokLines,size,maxW);
        const tooTall = () => lines.length>1 && lines.length*size*1.15 > Math.max(avail,size*1.3);
        const tooWide = () => lines.some(l=>lineWidth(font,l,size)>maxW+0.5);
        while (size>7 && (tooTall()||tooWide())){ size-=0.25; lines=wrapTokens(font,tokLines,size,maxW); }
        if (tooTall()){
          const over=Math.ceil(lines.length*size*1.15-Math.max(avail,size*1.3));
          log.push(`#${c.n}: the new text needs about ${over} pt more height than the space it replaces. It may overlap the line below; check the preview, or shorten it.`);
        } else if (size < startSize*0.85) log.push(`#${c.n}: the new text was set smaller (${size.toFixed(1)} pt) to fit. Check it in the preview.`);
        const color=rgb(...ink);
        const label = (c.text.split(/[\n:]/)[0]||'Field').slice(0,30);
        lines.forEach((line,li)=>{
          let cx=x; const y=baseline-li*size*1.15;
          const lineEnd = x+maxW;
          line.forEach((t,ti)=>{
            if (t.t==='text'){
              let s=t.s;
              // a rewritten run's blank line keeps the original's length (the substitute font draws underscores narrower)
              const m = fullText!=null && li===lines.length-1 && ti===line.length-1 ? s.match(/_{3,}\s*$/) : null;
              if (m && base){ s=s.slice(0,m.index); const uw=font.widthOfTextAtSize('_',size)||size*0.5;
                const head=font.widthOfTextAtSize(s,size), n=Math.max(3,Math.floor((base.x1-(cx+head))/uw)); s+= '_'.repeat(n); }
              if(!/^\s+$/.test(s) || ti>0) page.drawText(s,{x:cx,y,size,font,color}); cx+=font.widthOfTextAtSize(s,size); return; }
            if (t.t==='box'){
              const s=size*0.85, cb=form.createCheckBox(uniq(`${label} ${prevWord(line,ti)}`));
              cb.addToPage(page,{x:cx+1,y:y-size*0.08,width:s,height:s,borderWidth:0.8,borderColor:rgb(0.2,0.2,0.2),backgroundColor:rgb(1,1,1)});
              track(cb); made.boxes++; cx+=measure(font,t,size); return;
            }
            const w = t.t==='fill' ? Math.max(40, lineEnd-cx-4) : measure(font,t,size);
            const tf=form.createTextField(uniq(t.t==='fill' ? `${prevWord(line,ti)||label}` : `${label} field`));
            tf.addToPage(page,{x:cx+3,y:y-size*0.28,width:w-4,height:size*1.1,borderWidth:0,borderColor:undefined,backgroundColor:undefined});
            try{ tf.setFontSize(0); }catch{}
            page.drawLine({start:{x:cx+3,y:y-size*0.28},end:{x:cx+w-1,y:y-size*0.28},thickness:0.6,color:rgb(0.35,0.35,0.35)});
            track(tf); made.fields++; cx+=w;
          });
        });
        if (shift){
          for (const l of shift.labels){ const lf=await fontFor(familyFor(fontNameOf(state,job.page,l.item))); page.drawText(safeText(lf,l.str.trim()),{x:l.x+shift.dx,y:l.y,size:l.size,font:lf,color}); }
          moves.push({page:job.page, dx:shift.dx, rects:shift.boxes.map(b=>b.rect)});
        }
      }
    }

    // slide kept boxes
    for (const mv of moves){
      const annots=pages[mv.page].node.Annots(); if(!annots) continue;
      for (let i=0;i<annots.size();i++){
        const d=doc.context.lookup(annots.get(i)); if(!(d instanceof PDFDict) || d.get(PDFName.of('Subtype'))?.toString()!=='/Widget') continue;
        const R=d.lookup(PDFName.of('Rect')).asRectangle();
        if (mv.rects.some(r=>Math.abs(r[0]-R.x)<1&&Math.abs(r[1]-R.y)<1)) d.set(PDFName.of('Rect'), doc.context.obj([R.x+mv.dx,R.y,R.x+R.width+mv.dx,R.y+R.height]));
      }
    }
    // remove fill-in boxes on removed areas
    const dead=new Set();
    pages.forEach((page,pi)=>{
      if(!removeRects[pi].length) return; const annots=page.node.Annots(); if(!annots) return;
      for (let i=0;i<annots.size();i++){
        const ref=annots.get(i), d=doc.context.lookup(ref);
        if(!(d instanceof PDFDict) || d.get(PDFName.of('Subtype'))?.toString()!=='/Widget') continue;
        const R=d.lookup(PDFName.of('Rect'))?.asRectangle?.(); if(!R) continue;
        if (!born.has(ref.toString()) && E.inside([R.x,R.y,R.x+R.width,R.y+R.height], removeRects[pi])) dead.add(ref.toString());
      }
    });
    if (dead.size){
      for (const field of form.getFields()){
        const refs=field.acroField.getWidgets().map(w=>doc.context.getObjectRef(w.dict)?.toString());
        if (refs.length && refs.every(r=>dead.has(r))){ try{ form.removeField(field); }catch(e){ console.warn(e); } }
      }
      pages.forEach(page=>{ const a=page.node.Annots(); if(!a) return; for(let i=a.size()-1;i>=0;i--) if(dead.has(a.get(i).toString())) a.remove(i); });
    }
    // strip reviewer comments
    if (ctx.strip){
      pages.forEach(page=>{
        const a=page.node.Annots(); if(!a) return;
        for (let i=a.size()-1;i>=0;i--){ const d=doc.context.lookup(a.get(i)); const st=d instanceof PDFDict ? (d.get(PDFName.of('Subtype'))?.toString()||'').slice(1) : ''; if (E.STRIP_TYPES.has(st)) a.remove(i); }
      });
    }
    ctx.stats.removedBoxes=dead.size; ctx.stats.newFields=made.fields; ctx.stats.newBoxes=made.boxes;
    return await doc.save({ useObjectStreams:false, updateFieldAppearances:false });
  }
  function prevWord(line, idx){
    for (let i=idx-1;i>=0;i--){ if (line[i].t==='text' && line[i].s.trim()) return line[i].s.trim().replace(/[:.]+$/,'').split(/\s+/).slice(-3).join(' '); }
    return '';
  }

  // ---------- pass 2: rows ----------
  // All row operations on a page are planned together, in the page's original coordinates:
  // cut the page into horizontal segments at every row edge and target, drop the closed rows,
  // move rows to their targets, then lay the segments out again top to bottom. One rebuild per page.
  function planPage(state, pi, ops, log){
    const pg=state.pages[pi], v=pg.view, top=v[3];
    const allRemoved=ops.filter(o=>o.type==='close').flatMap(o=>o.rects);
    const floor=E.footerTop(pi,pg);
    const dels=[], moves=[];
    for (const op of ops){
      const band=E.rowBand(pi,pg,E.union(op.rects));
      if (!band){ log.push(`#${op.n}: couldn’t find the edges of that row, so it was left in place.`); continue; }
      const [b0,b1]=band;
      if (b0<=floor+0.5){ log.push(`#${op.n}: that row is in the footer area, so it was left in place.`); continue; }
      if (op.type==='close'){
        const others = pg.items.some(it=>it.str.trim() && !/^[\s_☐□○]*$/.test(it.str) && E.overlapV(it.y0,it.y1,b0,b1)>(it.y1-it.y0)*0.5
          && !allRemoved.some(r=>E.overlapV(it.y0,it.y1,r[1],r[3])>0 && it.x1>r[0]-1.5 && it.x0<r[2]+1.5));
        if (others){ log.push(`#${op.n}: that row still has other text in it, so the gap was left.`); continue; }
        dels.push({b0,b1,n:op.n});
      } else {
        let t = op.moveTo==='sectionEnd' ? E.sectionEnd(pi,pg,band) : op.moveY!=null ? E.cutBelow(pi,pg,op.moveY) : null;
        if (t==null){ log.push(`#${op.n}: couldn’t find where to put that row.`); continue; }
        t=Math.max(t,floor);
        if (t>b0-0.5 && t<b1+0.5){ log.push(`#${op.n}: that row is already there.`); continue; }
        moves.push({b0,b1,t,n:op.n});
      }
    }
    // a row can't be both closed and moved, and moved rows can't overlap each other
    const overl=(a,b)=>Math.min(a.b1,b.b1)-Math.max(a.b0,b.b0)>0.5;
    const okMoves=[];
    for (const m of moves){
      if (dels.some(d=>overl(d,m)) || okMoves.some(o=>overl(o,m))){ log.push(`#${m.n}: that row overlaps another change, so it wasn’t moved.`); continue; }
      okMoves.push(m);
    }
    if (!dels.length && !okMoves.length) return null;
    // segments between every cut
    const cuts=new Set([top, floor]);
    for (const d of dels){ cuts.add(d.b0); cuts.add(d.b1); }
    for (const m of okMoves){ cuts.add(m.b0); cuts.add(m.b1); cuts.add(m.t); }
    const ys=[...cuts].filter(y=>y>=floor-0.01 && y<=top+0.01).sort((a,b)=>b-a);
    let seq=[];
    for (let i=0;i<ys.length-1;i++) if (ys[i]-ys[i+1]>0.01) seq.push({hi:ys[i], lo:ys[i+1]});
    const within=(s,b)=> s.lo>=b.b0-0.01 && s.hi<=b.b1+0.01;
    seq=seq.filter(s=>!dels.some(d=>within(s,d)));
    for (const m of okMoves){
      const block=seq.filter(s=>within(s,m));
      seq=seq.filter(s=>!within(s,m));
      let at=seq.findIndex(s=>s.hi<=m.t+0.01);
      if (at<0) at=seq.length;
      seq.splice(at,0,...block);
    }
    let cursor=top; const strips=[];
    for (const s of seq){ const h=s.hi-s.lo; strips.push({y0:s.lo, y1:s.hi, dy:(cursor-h)-s.lo}); cursor-=h; }
    if (floor>v[1]) strips.push({y0:v[1], y1:floor, dy:0});            // footer never moves
    return { strips, count:dels.length+okMoves.length };
  }

  async function pass2(state, bytes, ctx){
    if (!ctx.rowOps.length) return bytes;
    const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, pushGraphicsState, popGraphicsState, rectangle, clip, endPath, concatTransformationMatrix, drawObject } = PDFLib;
    const doc=await PDFDocument.load(bytes,{updateMetadata:false});
    const byPage={}; for (const op of ctx.rowOps) (byPage[op.page]=byPage[op.page]||[]).push(op);
    for (const pi of Object.keys(byPage).map(Number)){
      const pg=state.pages[pi];
      if (pg.rotate){ ctx.log.push(`Page ${pi+1}: rows can’t be moved on a rotated page, so gaps were left.`); continue; }
      const plan=planPage(state, pi, byPage[pi], ctx.log);
      if (!plan) continue;
      await restrip(doc, pi, plan.strips);
      ctx.stats.rowOps+=plan.count;
    }
    return await doc.save({useObjectStreams:false, updateFieldAppearances:false});

    async function restrip(doc, pageIdx, strips){
      const old=doc.getPage(pageIdx), oldRef=old.ref;
      const emb=await doc.embedPage(old);                       // same document: fonts and images are shared, not copied
      const fresh=doc.insertPage(pageIdx,[old.getWidth(),old.getHeight()]);
      // keep the page's own settings (boxes, tags for accessibility, transparency group…)
      for (const [k,val] of old.node.entries()){
        const key=k.asString(); if (['/Contents','/Resources','/Annots','/Parent','/Type'].includes(key)) continue;
        fresh.node.set(k,val);
      }
      const name=fresh.node.newXObject('Pg', emb.ref);
      const mb=old.getMediaBox(), ops=[];
      for (const s of strips){
        if (s.y1-s.y0 < 0.01) continue;
        ops.push(pushGraphicsState(), rectangle(mb.x, s.y0+s.dy, mb.width, s.y1-s.y0), clip(), endPath(), concatTransformationMatrix(1,0,0,1,0,s.dy), drawObject(name), popGraphicsState());
      }
      fresh.pushOperators(...ops);
      const segAt = y => strips.find(s=>y>=s.y0-0.01 && y<s.y1+0.01);
      const annots=old.node.Annots(), keep=doc.context.obj([]), lost=[];
      if (annots){
        for (let i=0;i<annots.size();i++){
          const ref=annots.get(i), d=doc.context.lookup(ref);
          if (d instanceof PDFDict){
            const R=d.lookup(PDFName.of('Rect'))?.asRectangle?.();
            if (R){
              const s=segAt(R.y+R.height/2);
              if (!s){ lost.push(ref); continue; }
              if (s.dy) d.set(PDFName.of('Rect'), doc.context.obj([R.x,R.y+s.dy,R.x+R.width,R.y+R.height+s.dy]));
            }
            d.set(PDFName.of('P'), fresh.ref);
          }
          keep.push(ref);
        }
      }
      fresh.node.set(PDFName.of('Annots'), keep);
      if (lost.length){        // a fill-in box that sat in a closed row: take its field out too
        const gone=new Set(lost.map(r=>r.toString())), form=doc.getForm();
        for (const f of form.getFields()){ const refs=f.acroField.getWidgets().map(w=>doc.context.getObjectRef(w.dict)?.toString()); if (refs.length && refs.every(r=>gone.has(r))) try{ form.removeField(f); }catch{} }
      }
      doc.removePage(pageIdx+1);
      // links, bookmarks and accessibility tags that pointed at the old page now point at the new one
      const swap = obj => {
        if (obj instanceof PDFArray){ for (let i=0;i<obj.size();i++){ const x=obj.get(i); if (x instanceof PDFRef && x===oldRef) obj.set(i,fresh.ref); else if (x instanceof PDFArray || x instanceof PDFDict) swap(x); } }
        else if (obj instanceof PDFDict){ for (const [k,x] of obj.entries()){ if (x instanceof PDFRef && x===oldRef) obj.set(k,fresh.ref); else if (x instanceof PDFArray || x instanceof PDFDict) swap(x); } }
      };
      for (const [ref,obj] of doc.context.enumerateIndirectObjects()){ if (obj===old.node) continue; if (obj instanceof PDFArray || obj instanceof PDFDict) swap(obj); }
    }
  }

  async function build(state, opts){
    const ctx={ log:[], rowOps:[], strip:opts.strip, stats:{removedBoxes:0,newFields:0,newBoxes:0,rowOps:0} };
    let bytes = await pass1(state, ctx);
    for (const c of state.changes){
      const st=UI.status(c); if (c.action!=='move' || st==='skip' || st==='need') continue;
      ctx.rowOps.push({type:'move', page:c.page, rects:c.rects, moveTo:c.moveTo, moveY:c.moveY, n:c.n});
    }
    bytes = await pass2(state, bytes, ctx);
    return { out:bytes, log:ctx.log, stats:ctx.stats };
  }

  return { build, tokenize, hasPlaceholders, familyFor };
})();
