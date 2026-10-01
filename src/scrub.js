// ============================================================================
// scrub.js — truly delete text runs from a page's content stream (not just cover them).
// Walks the content stream, tracks where each text-show operation starts, matches it to the
// text pdf.js found there, and drops the operation when all of that text sits inside a removed area.
// Anything it can't be sure about is left alone (the white cover still hides it).
// ============================================================================
const Scrub = (() => {
  const WS=new Set([0,9,10,12,13,32]), DELIM=new Set('()<>[]{}/%'.split('').map(c=>c.charCodeAt(0)));
  // tokenize into [{t:'op'|'num'|'other', v, s, e}] with byte offsets
  function* tokens(b){
    let i=0; const n=b.length;
    while (i<n){
      const c=b[i];
      if (WS.has(c)){ i++; continue; }
      if (c===37){ while(i<n && b[i]!==10 && b[i]!==13) i++; continue; }          // % comment
      const s=i;
      if (c===40){ let depth=0; do{ if(b[i]===92){ i+=2; continue; } if(b[i]===40) depth++; else if(b[i]===41) depth--; i++; } while(i<n && depth>0); yield {t:'other',s,e:i}; continue; }
      if (c===60 && b[i+1]===60){ i+=2; yield {t:'dictopen',s,e:i}; continue; }
      if (c===62 && b[i+1]===62){ i+=2; yield {t:'dictclose',s,e:i}; continue; }
      if (c===60){ while(i<n && b[i]!==62) i++; i++; yield {t:'other',s,e:i}; continue; }
      if (c===91||c===93||c===123||c===125){ i++; yield {t:c===91?'aopen':c===93?'aclose':'other',s,e:i}; continue; }
      if (c===47){ i++; while(i<n && !WS.has(b[i]) && !DELIM.has(b[i])) i++; yield {t:'other',s,e:i}; continue; }
      while(i<n && !WS.has(b[i]) && !DELIM.has(b[i])) i++;
      if (i===s){ i++; continue; }
      let word=''; for(let k=s;k<i;k++) word+=String.fromCharCode(b[k]);
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) yield {t:'num',v:parseFloat(word),s,e:i};
      else if (word==='true'||word==='false'||word==='null') yield {t:'other',s,e:i};
      else if (word==='BI') throw new Error('inline-image');   // binary data inside: don't risk it
      else yield {t:'op',v:word,s,e:i};
    }
  }
  const mul=(m,n)=>[m[0]*n[0]+m[1]*n[2], m[0]*n[1]+m[1]*n[3], m[2]*n[0]+m[3]*n[2], m[2]*n[1]+m[3]*n[3], m[4]*n[0]+m[5]*n[2]+n[4], m[4]*n[1]+m[5]*n[3]+n[5]];
  const SHOW=new Set(['Tj','TJ',"'",'"']);

  // returns [{s,e,x,y,known}] for every text-show op (s = start of its operands)
  function textOps(bytes){
    const out=[]; let ctm=[1,0,0,1,0,0], stack=[], tm=[1,0,0,1,0,0], tlm=[1,0,0,1,0,0], tl=0, rise=0, known=false;
    let operands=[], opStart=null, depth=0;
    for (const tk of tokens(bytes)){
      if (opStart===null) opStart=tk.s;
      if (tk.t==='aopen'||tk.t==='dictopen'){ depth++; continue; }
      if (tk.t==='aclose'||tk.t==='dictclose'){ depth--; continue; }
      if (depth>0) continue;
      if (tk.t!=='op'){ operands.push(tk); continue; }
      const nums=operands.filter(o=>o.t==='num').map(o=>o.v), op=tk.v;
      switch(op){
        case 'q': stack.push(ctm.slice()); break;
        case 'Q': ctm=stack.pop()||[1,0,0,1,0,0]; break;
        case 'cm': if (nums.length>=6) ctm=mul(nums.slice(-6),ctm); break;
        case 'BT': tm=[1,0,0,1,0,0]; tlm=[1,0,0,1,0,0]; known=true; break;
        case 'Tm': if (nums.length>=6){ tm=nums.slice(-6); tlm=tm.slice(); known=true; } break;
        case 'Td': case 'TD': if (nums.length>=2){ const [tx,ty]=nums.slice(-2); if(op==='TD') tl=-ty; tlm=mul([1,0,0,1,tx,ty],tlm); tm=tlm.slice(); known=true; } break;
        case 'TL': if (nums.length) tl=nums[nums.length-1]; break;
        case 'Ts': if (nums.length) rise=nums[nums.length-1]; break;
        case 'T*': tlm=mul([1,0,0,1,0,-tl],tlm); tm=tlm.slice(); known=true; break;
      }
      if (op==="'"||op==='"'){ tlm=mul([1,0,0,1,0,-tl],tlm); tm=tlm.slice(); known=true; }
      if (SHOW.has(op)){
        const m=mul(tm,ctm);
        // ' and " also move to the next line (and " sets spacing): deleting them must keep that part
        const keep = op==="'" ? ' T* ' : op==='"' && nums.length>=2 ? ` ${nums[nums.length-2]} Tw ${nums[nums.length-1]} Tc T* ` : '';
        out.push({ s:opStart, e:tk.e, x:m[4], y:m[5]+rise*m[3], known, keep });
        known=false;   // after showing text, the pen has moved by an unknown width
      }
      operands=[]; opStart=null;
    }
    return out;
  }

  // decide which ops to drop for one page
  function plan(bytes, items, regions){
    const ops=textOps(bytes);
    const live=items.filter(i=>i.str.trim());
    const startsByLine=new Map();
    for (const o of ops){ if (!o.known) continue; const k=Math.round(o.y); (startsByLine.get(k)||startsByLine.set(k,[]).get(k)).push(o.x); }
    const inRegion = it => regions.some(r=> it.x0>=r[0]-1.5 && it.x1<=r[2]+1.5 && Engine.overlapV(it.y0,it.y1,r[1],r[3]) > (it.y1-it.y0)*0.5);
    const drop=[];
    for (const o of ops){
      if (!o.known) continue;
      const first=live.find(it=>Math.abs(it.x0-o.x)<0.8 && Math.abs(it.y-o.y)<0.8);
      if (!first || !inRegion(first)) continue;
      // every piece of text from this op's start up to the next op start on the line must be inside
      const others=(startsByLine.get(Math.round(o.y))||[]).filter(x=>x>o.x+0.5).sort((a,b)=>a-b);
      const stop=others.length?others[0]:Infinity;
      const run=live.filter(it=>Math.abs(it.y-o.y)<0.8 && it.x0>=o.x-0.5 && it.x0<stop-0.5);
      if (run.length && run.every(inRegion)) drop.push(o);
    }
    return drop;
  }
  function apply(bytes, drop){
    if (!drop.length) return bytes;
    drop.sort((a,b)=>a.s-b.s);
    const parts=[]; let at=0; const enc=new TextEncoder();
    for (const d of drop){ if (d.s<at) continue; parts.push(bytes.subarray(at,d.s)); if (d.keep) parts.push(enc.encode(d.keep)); at=d.e; }
    parts.push(bytes.subarray(at));
    const len=parts.reduce((a,p)=>a+p.length,0), out=new Uint8Array(len); let o=0;
    for (const p of parts){ out.set(p,o); o+=p.length; }
    return out;
  }

  // scrub a pdf-lib page in place. Returns how many text runs were deleted.
  function page(doc, pdfPage, items, regions){
    const { PDFName, PDFArray, PDFRawStream, decodePDFRawStream } = PDFLib;
    if (!regions.length) return 0;
    const contents=pdfPage.node.get(PDFName.of('Contents')); if (!contents) return 0;
    const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
    // join all streams (operators can't span streams in valid PDFs, but state carries across)
    const decoded=[];
    for (const ref of refs){
      const st=doc.context.lookup(ref);
      if (!(st instanceof PDFRawStream)) return 0;      // something unusual: leave the page alone
      try{ decoded.push(decodePDFRawStream(st).decode()); }catch{ return 0; }
    }
    const total=decoded.reduce((a,d)=>a+d.length+1,0), all=new Uint8Array(total); let o=0;
    for (const d of decoded){ all.set(d,o); o+=d.length; all[o++]=10; }
    let drop;
    try{ drop=plan(all, items, regions); }catch(e){ return 0; }     // anything odd: leave this page's text covered, not deleted
    if (!drop.length) return 0;
    const cleaned=apply(all, drop);
    const stream=doc.context.flateStream(cleaned);
    const ref=doc.context.register(stream);
    pdfPage.node.set(PDFName.of('Contents'), ref);
    return drop.length;
  }
  return { page, textOps, plan };
})();
