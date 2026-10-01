// ============================================================================
// engine.js — reading a PDF, understanding reviewer notes, page geometry.
// Pure helpers; no DOM except the analysis canvases kept in `Engine.canvases`.
// ============================================================================
const Engine = (() => {
  const COMMENT_TYPES = new Set(['Highlight','Underline','StrikeOut','Squiggly','Text','Popup','Caret','FreeText']);
  // markup that isn't an edit instruction (drawings, stamps); listed for her and removed with the comments
  const MARK_TYPES = new Set(['Ink','Square','Circle','Line','Polygon','PolyLine','Stamp','FileAttachment','Sound']);
  const STRIP_TYPES = new Set([...COMMENT_TYPES, ...MARK_TYPES]);

  // ---------- geometry ----------
  const overlapV = (a0,a1,b0,b1) => Math.max(0, Math.min(a1,b1)-Math.max(a0,b0));
  const union = rs => [Math.min(...rs.map(r=>r[0])),Math.min(...rs.map(r=>r[1])),Math.max(...rs.map(r=>r[2])),Math.max(...rs.map(r=>r[3]))];
  function inside(wr, rects){
    const cx=(wr[0]+wr[2])/2, cy=(wr[1]+wr[3])/2;
    return rects.some(r=> cx>=r[0]-1 && cx<=r[2]+1 && cy>=r[1]-3 && cy<=r[3]+3);
  }
  function mergeLines(rs){
    const out=[];
    for (const r of [...rs].sort((a,b)=>b[1]-a[1]||a[0]-b[0])){
      const hit=out.find(o=>overlapV(o[1],o[3],r[1],r[3]) > Math.min(o[3]-o[1],r[3]-r[1])*0.5);
      if (hit){ hit[0]=Math.min(hit[0],r[0]); hit[2]=Math.max(hit[2],r[2]); hit[1]=Math.min(hit[1],r[1]); hit[3]=Math.max(hit[3],r[3]); }
      else out.push([...r]);
    }
    return out;
  }
  function quadRects(a){
    let q=a.quadPoints; const rects=[];
    if (q && q.length){
      if (typeof q[0]==='number'){ const t=[]; for(let i=0;i+7<q.length;i+=8) t.push([{x:q[i],y:q[i+1]},{x:q[i+2],y:q[i+3]},{x:q[i+4],y:q[i+5]},{x:q[i+6],y:q[i+7]}]); q=t; }
      for (const quad of q){ if(!quad||quad.length<4) continue; const xs=quad.map(p=>p.x), ys=quad.map(p=>p.y); rects.push([Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)]); }
    }
    if (!rects.length && Array.isArray(a.rect) && a.rect.length===4) rects.push([...a.rect]);
    return rects.filter(r=>r.every(Number.isFinite) && r[2]>r[0] && r[3]>r[1]);
  }
  function itemBox(it){
    const t=it.transform, size=Math.hypot(t[2],t[3])||it.height||10;
    return { x0:t[4], x1:t[4]+it.width, y:t[5], y0:t[5]-size*0.22, y1:t[5]+size*0.78, size, str:it.str, font:it.fontName };
  }
  function slicesInRect(items, r){
    const out=[];
    for (const b of items){
      if (!b.str.trim() || overlapV(b.y0,b.y1,r[1],r[3]) < (b.y1-b.y0)*0.45) continue;
      if (b.x1 <= r[0]+0.5 || b.x0 >= r[2]-0.5) continue;
      const n=b.str.length, w=(b.x1-b.x0)||1;
      const s=Math.max(0,Math.round((r[0]-b.x0)/w*n)), e=Math.min(n,Math.round((r[2]-b.x0)/w*n));
      const str=b.str.slice(s,e); if (!str.trim()) continue;
      out.push({ x:b.x0+s/n*w, x1:b.x0+e/n*w, y:b.y, size:b.size, str, item:b });
    }
    return out.sort((a,b)=> Math.abs(a.y-b.y) < Math.max(a.size,b.size)*0.5 ? a.x-b.x : b.y-a.y);
  }
  function textInRect(items, r){
    const parts=slicesInRect(items,r);
    let base=null, txt='';
    parts.forEach((p,i)=>{ if(i && p.x-parts[i-1].x1 > p.size*0.12 && !/\s$/.test(txt)) txt+=' '; txt+=p.str; if(!base||p.size>base.size) base=p.item; });
    return { text: txt.replace(/\s+/g,' ').trim(), base };
  }
  // find text on a line: case-insensitive, whole words only, spaces collapsed (with an exact character map)
  function lineGroups(items){
    const rows=[];
    for (const b of items){ if(!b.str) continue; const row=rows.find(r=>Math.abs(r.y-b.y)<Math.max(0.8,b.size*0.25)); if(row) row.items.push(b); else rows.push({y:b.y,items:[b]}); }
    return rows.map(r=>r.items.sort((a,b)=>a.x0-b.x0));
  }
  const isWord = ch => !!ch && /[\p{L}\p{N}]/u.test(ch);
  function findText(pg, needle){
    const n=needle.replace(/\s+/g,' ').trim().toLowerCase(); if(!n) return null;
    for (const row of lineGroups(pg.items)){
      let s='', map=[];                     // map[i] = [item, charIndex] or null for an inserted gap space
      row.forEach((b,bi)=>{
        if (bi && b.x0-row[bi-1].x1 > b.size*0.12 && !/\s$/.test(s)){ s+=' '; map.push(null); }
        for (let ci=0;ci<b.str.length;ci++){ const ch=b.str[ci];
          if (/\s/.test(ch)){ if (/\s$/.test(s) || !s) continue; s+=' '; map.push([b,ci]); }
          else { s+=ch; map.push([b,ci]); } }
      });
      const low=s.toLowerCase();
      let i=low.indexOf(n);
      while (i>=0){
        const okL = !isWord(n[0]) || !isWord(low[i-1]), okR = !isWord(n[n.length-1]) || !isWord(low[i+n.length]);
        if (okL && okR){
          const at = k => { for(let j=k;j>=0;j--) if(map[j]) return map[j]; return map.find(Boolean); };
          const [b0,c0]=at(i), [b1,c1]=at(i+n.length-1);
          const x0=b0.x0+c0/(b0.str.length||1)*(b0.x1-b0.x0), x1=b1.x0+(c1+1)/(b1.str.length||1)*(b1.x1-b1.x0);
          return { rects:[[x0, Math.min(b0.y0,b1.y0), x1, Math.max(b0.y1,b1.y1)]], base:b0 };
        }
        i=low.indexOf(n,i+1);
      }
    }
    return null;
  }
  // how far right new text can run on this line before hitting other content
  function roomRight(pg, r, base){
    const y0=base?base.y0:r[1], y1=base?base.y1:r[3];
    let limit = (pg.view?pg.view[2]:pg.width) - 18;
    for (const b of pg.items){
      if (!b.str.trim() || overlapV(b.y0,b.y1,y0,y1) < (y1-y0)*0.3) continue;
      if (b.x1 > r[2]+0.5) limit=Math.min(limit, Math.max(b.x0, r[2]));
    }
    for (const w of pg.widgets){
      if (overlapV(w.rect[1],w.rect[3],y0,y1) < 2) continue;
      if (w.rect[0] >= r[0]+2 && !inside(w.rect,[r])) limit=Math.min(limit, Math.max(w.rect[0], r[2]));
    }
    return limit;
  }

  // ---------- understanding a reviewer note ----------
  function clean(s){
    s = s.replace(/\r\n?/g,'\n').trim();
    s = s.replace(/[,;]?\s*(right|correct|ok|okay|yes|no)\s*\?\s*$/i,'').trim();
    s = s.replace(/(\w)-\s+(\w)/g,'$1-$2');
    s = s.replace(/^[,:\s]+/,'');
    s = s.replace(/^["“‘'«]+/,'').replace(/["”’'»]+$/,'');
    if (/^\[[^\]]*\]$/.test(s)) s = s.slice(1,-1);
    return s.trim();
  }
  const REPLACE_PATTERNS = [
    /^(?:please\s+|can\s+we\s+|could\s+we\s+|let'?s\s+|we\s+should\s+)?(?:change|update|reword|rename|rewrite|replace|edit|switch|amend)(?:\s+(?:this|it|that|the\s+text|text|wording|title|heading|label))?\s+(?:to|with|as|into)\s*[:,\-–—]?\s*([\s\S]+)$/i,
    /^(?:change|replace|update)\s*(?:to)?\s*[:\-–—]\s*([\s\S]+)$/i,
    /^(?:it\s+|this\s+|that\s+)?(?:should|could|would|must|needs?\s+to)\s+(?:be|read|say|state)\s*[:,\-–—]?\s*([\s\S]+)$/i,
    /^(?:new\s+(?:text|wording|title|label)|reads?|wording|text)\s*[:\-–—]\s*([\s\S]+)$/i,
    /^(?:→|->|=>|replace\s+w\/)\s*([\s\S]+)$/i,
  ];
  const REMOVE_ONLY = /^(?:please\s+|can\s+we\s+|could\s+we\s+|let'?s\s+|lets\s+|we\s+should\s+|i\s+would\s+|i'?d\s+)?(?:remove|delete|cut|drop|take\s+out|take\s+(?:this|it|that|these)\s+out|get\s+rid\s+of|omit|strike|eliminate|lose|scrap)(?:\s+(?:this|it|that|these|the|whole|entire|line|row|section|question|field|part|sentence|word|bit|one|item|please))*\s*[.!]*\s*$/i;
  const REMOVE_THEN_ADD = /^(?:please\s+|let'?s\s+)?(?:remove|delete|cut|drop|take\s+out)\b[^:]*?(?:and\s+)?(?:add|put|replace|use|insert)(?:\s+(?:in|this|it|instead|with))*\s*(?:instead)?\s*[:\-–—]\s*([\s\S]+)$/i;
  const CHANGE_X_TO_Y = /(?:change|replace|rename|update)\s+["“'‘]([^"”'’]+)["”'’]\s+(?:to|with)\s+["“'‘]?([^"”'’]+?)["”'’]?\s*[.?!]?$/i;
  const INSERT = /^(?:please\s+|let'?s\s+)?(?:add|insert|include|put)(?:\s+(?:in|this|here|the\s+word|text))*\s*[:\-–—]\s*([\s\S]+)$/i;
  const MOVE = /\b(move|reorder|swap|put\s+.*\b(?:first|last|above|below|after|before|underneath)|last\s+(?:line|row|item|question)|first\s+(?:line|row|item|question)|across\s+from|at\s+the\s+(?:end|bottom|top))\b/i;
  const MOVE_LAST = /\b(last\s+(?:line|row|item|question|one)|at\s+the\s+(?:end|bottom)|to\s+the\s+(?:end|bottom))\b/i;
  const VAGUE = /^(typo|spelling|sp\.?|grammar|fix|fix this|wording|unclear|ok|okay|good|great|yes|no|agree|agreed|nice|done|same|same here|see above|\?+|!+)\W*$/i;

  function interpretRaw(c){
    const note=(c.note||'').trim();
    const r={ action:'skip', text:'', find:'', level:'need', why:'' };
    const hasTarget=!!c.targetText;
    const isQuestion = /,?\s*(right|correct|ok|okay)\s*\?\s*$/i.test(note) || (/\?\s*$/.test(note) && /^(should|shall|is|does|do|maybe|perhaps|what\s+if|how\s+about|could|would|can)\b/i.test(note));
    if (!note && c.subtype==='StrikeOut') return {...r, action:'remove', level:'ok', why:'Crossed-out text will be removed.'};
    if (!note && c.subtype==='Caret') return {...r, action:'insert', why:'An insert mark with no text. Type what should be added.'};
    if (!note) return {...r, why:'Highlighted with no note. Choose what to do, or leave it as is.'};
    let m;
    if ((m=note.match(CHANGE_X_TO_Y))) return {...r, action:'replace', find:m[1].trim(), text:clean(m[2]), level:isQuestion?'warn':'ok', why:`Find “${m[1].trim()}” and change it.`};
    if ((m=note.match(REMOVE_THEN_ADD))) return {...r, action:'replace', dropHint:true, text:clean(m[1]).replace(/[.]$/,''), level:'warn', why:'Remove the marked part and put the new text in its place.'};
    if (REMOVE_ONLY.test(note)){
      if (!hasTarget) return {...r, action:'remove', why:'The note says to remove something, but nothing is marked. Type the text to remove.'};
      return {...r, action:'remove', level:'ok', why:'The marked part, and any fill-in boxes on it, will be removed.'};
    }
    if (MOVE.test(note)){
      if (hasTarget && MOVE_LAST.test(note) && !/\b(and|then)\b/i.test(note))
        return {...r, action:'move', moveTo:'sectionEnd', level:'warn', why:'This row will move to the end of its section. Check the preview.'};
      const firstRemove=/^(?:let'?s\s+)?(?:remove|delete)\b/i.test(note);
      return {...r, action: firstRemove&&hasTarget ? 'remove' : hasTarget ? 'move' : 'skip', level:'need',
        why: firstRemove ? 'This asks to remove and also rearrange. The removal is set up; for the rest, choose “Move row” on the other rows, or do it by hand.'
                         : 'Choose where this row should go: pick “Move row”, then click the row it should follow.'};
    }
    for (const p of REPLACE_PATTERNS){
      if ((m=note.match(p))){
        const text=clean(m[1]); if(!text) break;
        if (!hasTarget && c.subtype!=='Caret') return {...r, action:'replace', text, level:'need', why:'This is a sticky note, so it doesn’t point at any text. Type the text that should change into Find.'};
        const lvl = isQuestion || /\n/.test(text) || text.length>Math.max(60,(c.targetText||'').length*2.5) ? 'warn':'ok';
        return {...r, action:'replace', text, level:lvl, why: isQuestion?'The reviewer asked this as a question. Confirm before applying.':'The marked text will be replaced.'};
      }
    }
    if ((m=note.match(INSERT)) || c.subtype==='Caret'){
      const text=m?clean(m[1]):note;
      return {...r, action:'insert', text, level:c.subtype==='Caret'?'ok':'warn', why:'New text will be added at the marked spot.'};
    }
    if (VAGUE.test(note)) return {...r, why:'The note flags a problem but doesn’t say what the fix is. Type the corrected text, or leave it as is.'};
    if (hasTarget && !isQuestion && note.length<160 && !/\b(why|maybe|consider|think|unclear|confusing|check|not sure|\?)\b/i.test(note))
      return {...r, action:'replace', text:clean(note), level:'warn', why:'The note has no instruction word, so it’s probably the new wording. Confirm.'};
    return {...r, why:'This note isn’t a clear edit instruction. Choose what to do, or leave it as is.'};
  }
  function interpret(c){
    const res=interpretRaw(c);
    if (res.text && c.targetText && /^[A-Z]/.test(c.targetText) && /^[a-z]/.test(res.text)) res.text=res.text[0].toUpperCase()+res.text.slice(1);
    return res;
  }

  // ---------- analysis canvas: ink colour, row bands ----------
  const canvases = [];   // per page: { cv, vp, scale }
  function px(pageIdx){ return canvases[pageIdx]; }
  function toCanvasY(c, y){ return Math.round(c.vp.convertToViewportPoint(0,y)[1]); }
  function toPdfY(c, yc){ return c.vp.convertToPdfPoint(0,yc)[1]; }
  function inkColor(pageIdx, r){
    const c=px(pageIdx); if(!c) return [0,0,0];
    const [x0,y0,x1,y1]=c.vp.convertToViewportRectangle(r).map(Math.round);
    const L=Math.max(0,Math.min(x0,x1)), T=Math.max(0,Math.min(y0,y1)), W=Math.max(1,Math.abs(x1-x0)), H=Math.max(1,Math.abs(y1-y0));
    let d; try{ d=c.cv.getContext('2d').getImageData(L,T,W,H).data; }catch{ return [0,0,0]; }
    const sum=[0,0,0]; let n=0;
    for (let i=0;i<d.length;i+=4){ if (0.299*d[i]+0.587*d[i+1]+0.114*d[i+2] > 140) continue; sum[0]+=d[i]; sum[1]+=d[i+1]; sum[2]+=d[i+2]; n++; }
    if (!n) return [0,0,0];
    const col=sum.map(v=>v/n/255);
    return Math.max(...col)-Math.min(...col) < 0.08 ? [0,0,0] : col;
  }
  // classify every pixel row of the page: 'rule' (a ruled line across), 'blank', or 'ink'
  function rowProfile(pageIdx, pg){
    const c=px(pageIdx); if(!c) return null;
    if (c.profile) return c.profile;
    const W=c.cv.width, H=c.cv.height, x0=Math.round(W*0.01), x1=Math.round(W*0.99);
    let d; try{ d=c.cv.getContext('2d').getImageData(0,0,W,H).data; }catch{ return null; }
    // rows covered by underscore fill-lines or fill-in boxes are not borders
    const notRule=new Uint8Array(H);
    for (const b of pg.items){ if (/_{3,}/.test(b.str)){ for(let y=toCanvasY(c,b.y1);y<=toCanvasY(c,b.y0-2);y++) if(y>=0&&y<H) notRule[y]=1; } }
    for (const w of pg.widgets){ for(let y=toCanvasY(c,w.rect[3]);y<=toCanvasY(c,w.rect[1]);y++) if(y>=0&&y<H) notRule[y]=1; }
    const kind=new Array(H), lineish=new Uint8Array(H), empty=new Uint8Array(H), span=x1-x0;
    for (let y=0;y<H;y++){
      let ink=0;
      for (let x=x0;x<x1;x++){ const i=(y*W+x)*4; if (0.299*d[i]+0.587*d[i+1]+0.114*d[i+2] < 235) ink++; }
      lineish[y] = ink/span>0.5 ? 1 : 0;
      kind[y] = ink/span<0.02 ? 'blank' : 'ink';
      if (ink===0) empty[y]=1;
    }
    // a ruled line is a thin run (≤ 2.5 pt) of rows inked across most of the width
    const maxRun=Math.max(2, Math.round(2.5*c.scale));
    for (let y=0;y<H;){
      if (!lineish[y]){ y++; continue; }
      let y2=y; while(y2+1<H && lineish[y2+1]) y2++;
      if (y2-y+1 <= maxRun) for (let k=y;k<=y2;k++) if (!notRule[k]) kind[k]='rule';
      y=y2+1;
    }
    c.profile={ kind, empty, H, scale:c.scale };
    return c.profile;
  }
  // Row band around a marked rect: [bottomY, topY] in PDF units, cutting at the bottom edge of
  // the separator above and the bottom edge of the separator below (so the row takes its own bottom rule).
  function rowBand(pageIdx, pg, r){
    const prof=rowProfile(pageIdx,pg); if(!prof) return null;
    const c=px(pageIdx), {kind,H}=prof, s=c.scale;
    let top=toCanvasY(c,r[3]), bot=toCanvasY(c,r[1]);
    // upward: find separator; cut at its bottom edge
    // a blank run followed by a ruled line belongs to the row: prefer the line
    let y=top-1, upCut=null;
    while (y>0){
      if (kind[y]==='rule'){ upCut=y+2; break; }
      if (kind[y]==='blank'){ let y2=y; while(y2>0&&kind[y2-1]==='blank') y2--;
        if (y2>0 && kind[y2-1]==='rule'){ y=y2-1; continue; }
        if (y-y2+1>=Math.max(2,3*s)){ upCut=Math.round((y+y2)/2)+1; break; } y=y2-1; continue; }
      y--;
    }
    y=bot+1; let downCut=null;
    while (y<H){
      if (kind[y]==='rule'){ let y2=y; while(y2+1<H&&kind[y2+1]==='rule') y2++; downCut=y2+2; break; }
      if (kind[y]==='blank'){ let y2=y; while(y2+1<H&&kind[y2+1]==='blank') y2++;
        if (y2+1<H && kind[y2+1]==='rule'){ y=y2+1; continue; }
        if (y2-y+1>=Math.max(2,3*s)){ downCut=Math.round((y+y2)/2); break; } y=y2+1; continue; }
      y++;
    }
    if (upCut==null || downCut==null || downCut<=upCut) return null;
    return [toPdfY(c,downCut), toPdfY(c,upCut)];
  }
  // end of the section a band belongs to: last separator before a wide blank gap (or page content end)
  function sectionEnd(pageIdx, pg, band){
    const prof=rowProfile(pageIdx,pg); if(!prof) return null;
    const c=px(pageIdx), {kind,empty,H}=prof, s=c.scale;
    let y=toCanvasY(c,band[0]), ruleCut=null, blankCut=null;
    while (y<H){
      if (empty[y]){ let y2=y; while(y2+1<H&&empty[y2+1]) y2++; if (y2-y+1>=10*s) break; }   // gap between boxes: section over
      if (kind[y]==='rule'){ let y2=y; while(y2+1<H&&kind[y2+1]==='rule') y2++; ruleCut=y2+2; y=y2+1; continue; }
      if (kind[y]==='blank'){ let y2=y; while(y2+1<H&&kind[y2+1]==='blank') y2++; if (y2-y+1>=3*s) blankCut=Math.round((y+y2)/2); y=y2+1; continue; }
      y++;
    }
    const cut = ruleCut ?? blankCut; if (cut==null) return null;
    return toPdfY(c,cut);
  }
  // separator cut at or just below a clicked y (place a moved row after the clicked row)
  function cutBelow(pageIdx, pg, yPdf){
    const b=rowBand(pageIdx,pg,[0,yPdf-0.5,pg.width,yPdf+0.5]);
    return b ? b[0] : null;
  }
  // top of the footer zone (content below it never shifts), or 0
  function footerTop(pageIdx, pg){
    const prof=rowProfile(pageIdx,pg); if(!prof) return 0;
    const c=px(pageIdx), {kind,H}=prof, s=c.scale;
    let y=H-1; while(y>0 && kind[y]==='blank') y--;          // footer bottom
    const fb=y; while(y>0 && kind[y]!=='blank') y--;          // footer top
    let gap=y; while(gap>0 && kind[gap]==='blank') gap--;
    if (fb-y < H*0.08 && y > H*0.85 && (y-gap)>=10*s) return toPdfY(c,Math.round((y+gap)/2));
    return pg.view ? pg.view[1] : 0;
  }

  // ---------- reading ----------
  async function read(bytes){
    const pdf = await pdfjsLib.getDocument({data:bytes.slice(), isEvalSupported:false}).promise;
    const meta = { pureXfa: !!pdf.isPureXfa, signed:false };
    const pages=[], changes=[];
    for (let p=1;p<=pdf.numPages;p++){
      const page=await pdf.getPage(p);
      const vp=page.getViewport({scale:1, rotation:0});
      const tc=await page.getTextContent();
      const items=tc.items.filter(i=>typeof i.str==='string').map(itemBox);
      const annots=await page.getAnnotations();
      const widgets=annots.filter(a=>a.subtype==='Widget').map(a=>({rect:a.rect, name:a.fieldName, type:a.fieldType}));
      if (widgets.some(w=>w.type==='Sig')) meta.signed=true;
      const [vx0,vy0]=page.view;
      pages.push({ page, vp, items, widgets, width:vp.width, height:vp.height, view:page.view.slice(),
        rotate: page.rotate||0, offset: (vx0||vy0) ? [vx0,vy0] : null,
        isScan: !items.some(i=>i.str.trim()) });
      for (const a of annots){
        if (MARK_TYPES.has(a.subtype)){
          const note=String(a.contentsObj?.str ?? a.contents ?? '').trim();
          changes.push(newChange({ id:a.id, page:p-1, subtype:a.subtype, note, author:String(a.titleObj?.str ?? a.title ?? '').trim(),
            rects:[], pinRect:Array.isArray(a.rect)?a.rect:[0,0,10,10], targetText:'', base:null, markOnly:true }));
          continue;
        }
        if (!COMMENT_TYPES.has(a.subtype) || a.subtype==='Popup') continue;
        const note=String(a.contentsObj?.str ?? a.contents ?? '').trim();
        const author=String(a.titleObj?.str ?? a.title ?? '').trim();
        if (a.inReplyTo){ const parent=changes.find(c=>c.id===a.inReplyTo); if(parent){ if(note) parent.replies.push((author?author+': ':'')+note); continue; } }
        const rects = a.subtype==='Text' ? [] : mergeLines(quadRects(a));
        let targetText='', base=null;
        if (rects.length && a.subtype!=='Caret' && a.subtype!=='FreeText'){
          const bits=rects.map(r=>textInRect(items,r));
          targetText=bits.map(b=>b.text).filter(Boolean).join(' ');
          base=bits.find(b=>b.base)?.base||null;
        }
        changes.push(newChange({ id:a.id, page:p-1, subtype:a.subtype, note, author, rects,
          pinRect:Array.isArray(a.rect)?a.rect:(rects[0]||[0,0,10,10]), targetText, base }));
      }
    }
    return { pdf, pages, changes, meta };
  }
  function newChange(o){
    return Object.assign({ replies:[], include:true, find:'', text:'', action:'skip', level:'need', why:'',
      boxes:[], dropBoxes:false, closeGap:false, moveTo:null, moveY:null, alsoPages:[], repeat:null, manual:false }, o);
  }
  // post-process once pages are rendered (needs canvases for some guesses)
  function finish(pages, changes){
    const words=s=>(s.toLowerCase().match(/[a-z0-9]{3,}/g)||[]).map(w=>w.slice(0,5));
    for (const c of changes){
      const pg=pages[c.page];
      c.boxes = c.rects.length ? pg.widgets.filter(w=>inside(w.rect,c.rects)) : [];
      if (c.manual) continue;
      if (c.markOnly){ Object.assign(c,{action:'skip', include:false, level:'skip', why:`A ${c.subtype==='Stamp'?'stamp':'drawing'} rather than an edit${c.note?' (its note is shown above)':''}. Nothing to apply; it’s removed with the other comments.`}); continue; }
      Object.assign(c, interpret(c));
      c.dropBoxes = c.action==='remove' || !!c.dropHint || (typeof Apply!=='undefined' && Apply.hasPlaceholders(c.text));
      // sticky note: guess the line it means
      if (!c.rects.length && c.subtype==='Text' && c.action==='replace' && c.text && !c.find){
        const want=new Set(words(c.text));
        if (want.size>=2){
          const lines={}; for(const b of pg.items){ if(!b.str.trim()) continue; const k=Math.round(b.y/2); (lines[k]=lines[k]||[]).push(b); }
          let best=null;
          for (const k in lines){ const txt=lines[k].sort((a,b)=>a.x0-b.x0).map(b=>b.str).join(' ').replace(/\s+/g,' ').trim(); const have=words(txt); if(!have.length) continue;
            const hits=have.filter(w=>want.has(w)).length, score=hits/have.length; if(hits>=2&&score>=0.5&&(!best||score>best.score)) best={score,txt}; }
          if (best){ c.find=best.txt; c.level='warn'; c.why=`This is a sticky note, so it doesn’t point at any text. It most likely means “${best.txt}”. Check Find.`; }
        }
      }
      if (c.action==='skip' && c.level==='need') c.include=false;
      repeatPages(pages, c);
      guardPage(pg, c);
    }
  }
  // same text in the same spot on other pages (headers, footers)
  function repeatPages(pages, c){
    c.alsoPages=[]; 
    const pg=pages[c.page];
    let rects=c.rects, target=c.targetText;
    if (!rects.length && c.find && c.find.trim()){ const f=findText(pg,c.find); if (f){ rects=f.rects; target=c.find.trim(); } }
    if (!rects.length || !target){ c.repeat=false; return; }
    const norm=s=>s.replace(/\s+/g,' ').trim().toLowerCase();
    const u=union(rects);
    for (let q=0;q<pages.length;q++){
      if (q===c.page || pages[q].isScan || pages[q].rotate) continue;
      if (c.rects.length){
        const t=c.rects.map(r=>textInRect(pages[q].items,r).text).join(' ');
        if (t && norm(t)===norm(target)) c.alsoPages.push(q);
      } else {
        const f=findText(pages[q],target); if (f && Math.abs(f.rects[0][1]-u[1])<3 && Math.abs(f.rects[0][0]-u[0])<6) c.alsoPages.push(q);
      }
    }
    const v=pg.view||[0,0,pg.width,pg.height], rel=y=>(y-v[1])/(v[3]-v[1]);
    const inMargin = rel(u[1]) > 0.85 || rel(u[3]) < 0.15;
    if (c.repeat==null || !c._repeatSet) c.repeat = c.alsoPages.length>0 && inMargin;
  }
  function guardPage(pg, c){
    if (pg.rotate){ c.include=false; c.action='skip'; c.level='need'; c.why='This page is rotated, so it can’t be edited safely here. Change it by hand.'; }
    else if (pg.isScan){ c.include=false; c.action='skip'; c.level='need'; c.why='This page is a scanned image, so its text can’t be changed.'; }
  }

  return { COMMENT_TYPES, MARK_TYPES, STRIP_TYPES, overlapV, union, inside, mergeLines, slicesInRect, textInRect, findText, roomRight,
    interpret, clean, canvases, inkColor, rowBand, sectionEnd, cutBelow, footerTop, read, finish, newChange, repeatPages, guardPage };
})();
