"""Full test suite. Run: python3 tests/suite.py"""
import json, sys, os
import zipfile, traceback, pymupdf
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT + "/tests")
from run import session, load, changes, preview_and_download
from playwright.sync_api import sync_playwright

FX = ROOT + "/tests/fx"
OUT = ROOT + "/tests/out"
results = []

def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))

def text_of(path, i=0):
    return pymupdf.open(path)[i].get_text()

def fields_of(path):
    return {w.field_name: w.field_type_string for p in pymupdf.open(path) for w in p.widgets()}

def annots_of(path):
    return sum(1 for p in pymupdf.open(path) for a in (p.annots() or []))

def y_of(path, needle, page=0):
    r = pymupdf.open(path)[page].search_for(needle)
    return r[0].y0 if r else None

PHRASES = [
    ("change to: Do they have a PCP?", 1, "Highlight", "replace", "Do they have a PCP?"),
    ("Change this to Client Name", 1, "Highlight", "replace", "Client Name"),
    ('can we change to, "additional comments including X', 1, "Highlight", "replace", "Additional comments including X"),
    ("Please reword to: Date of birth", 1, "Highlight", "replace", "Date of birth"),
    ("Rename to 'Phone number'", 1, "Highlight", "replace", "Phone number"),
    ("replace with Referral source", 1, "Highlight", "replace", "Referral source"),
    ("should read: Preferred pronouns", 1, "Highlight", "replace", "Preferred pronouns"),
    ("Should be 'Island Health', right?", 1, "Highlight", "replace", "Island Health"),
    ("-> Housing history", 1, "Highlight", "replace", "Housing history"),
    ('Change "Client" to "Patient"', 0, "Text", "replace", "Patient"),
    ("let's remove this", 1, "Highlight", "remove", None),
    ("Delete", 1, "Highlight", "remove", None),
    ("please take this out.", 1, "Highlight", "remove", None),
    ("we should get rid of this section", 1, "Highlight", "remove", None),
    ("remove this line", 1, "Highlight", "remove", None),
    ("", 1, "StrikeOut", "remove", None),
    ("add: (optional)", 1, "Caret", "insert", "(optional)"),
    ("Insert: per month", 1, "Highlight", "insert", "Per month"),
    ("remove and add instead: Comments:", 1, "Highlight", "replace", "Comments:"),
    ("could this be the last line in this section?", 1, "Highlight", "move", None),
    ("Move this above the pet question", 1, "Highlight", "move", None),
    ("Why is this here?", 1, "Highlight", "skip", None),
    ("Not sure this is needed", 1, "Highlight", "skip", None),
    ("Change to Island Health CAA Supplemental", 0, "Text", "replace", "Island Health CAA Supplemental"),
    ("Typo", 1, "Highlight", "skip", None),
    ("<script>alert(1)</script>", 1, "Highlight", "replace", "<script>alert(1)</script>"),
]

def t_phrases(pg):
    ok = 0
    for note, hl, st, ea, et in PHRASES:
        r = pg.evaluate("([n,h,s])=>__app.Engine.interpret({note:n,targetText:h?'Some highlighted text':'',subtype:s})", [note, hl, st])
        good = r["action"] == ea and (et is None or r["text"].lower() == et.lower())
        if not good: print("   phrase miss:", note, "->", r["action"], r["text"])
        ok += good
    check(f"phrasings {ok}/{len(PHRASES)}", ok == len(PHRASES))

def t_form1(pw):
    b, pg, errs = session(pw); load(pg, ROOT + "/tests/real/form1-16-comments.pdf")
    cs = changes(pg)
    check("form1: 16 comments read", len(cs) == 16, len(cs))
    check("form1: none left needing her", all(c["status"] != "need" for c in cs), [c["n"] for c in cs if c["status"] == "need"])
    check("form1: title sticky guessed + repeats", cs[0]["find"] == "MHSU CAA SUPPLEMENTAL" and cs[0]["also"] == [1, 2], cs[0])
    check("form1: move detected", any(c["action"] == "move" and c["moveTo"] == "sectionEnd" for c in cs))
    out = f"{OUT}/s_form1.pdf"; both = f"{OUT}/s_form1.zip"
    preview_and_download(pg, out, both)
    d = pymupdf.open(out)
    check("form1: comments stripped", annots_of(out) == 0)
    check("form1: title changed on all pages", all("Island Health CAA Supplimental" in d[i].get_text() and "MHSU CAA SUPPLEMENTAL" not in d[i].get_text() for i in range(3)))
    check("form1: subtitle removed on all pages", all("to support referrals" not in d[i].get_text() for i in range(3)))
    p2 = d[1]
    ya, yp = y_of(out, "Any additional information", 1), y_of(out, "partner or family member", 1)
    check("form1: row moved to end of section", ya and yp and ya > yp, (ya, yp))
    f = fields_of(out)
    check("form1: new checkboxes for meal program", sum(1 for k, v in f.items() if k.startswith("On-site meal program") and v == "CheckBox") == 2, [k for k in f if "meal" in k.lower()])
    check("form1: comment boxes added", sum(1 for k in f if k.startswith("Comment")) == 3, [k for k in f if "omment" in k])
    check("form1: PCP wording", "Do they have a PCP?" in d[2].get_text())
    check("form1: removed rows gone", "History of smoking indoors" not in d[2].get_text() and "Secure entry" not in d[1].get_text())
    z = zipfile.ZipFile(both); names = z.namelist()
    check("download both: zip has 3 files", len(names) == 3 and z.testzip() is None, names)
    check("download both: original intact", z.read([n for n in names if "original" in n][0]) == open(ROOT + "/tests/real/form1-16-comments.pdf", "rb").read())
    check("form1: no script errors", not errs, errs)
    pg.screenshot(path=f"{OUT}/s_form1_ui.png", full_page=False)
    # history survives a reload
    pg.reload(); pg.wait_for_selector(".hrow", timeout=15000)
    rows = pg.locator(".hrow").count()
    check("history: saved and listed after reload", rows >= 1, rows)
    pg.screenshot(path=f"{OUT}/s_history.png")
    pg.locator(".hrow").first.locator("button[data-a='cont']").click()
    pg.wait_for_function("() => !document.querySelector('#work').hidden", timeout=30000)
    check("history: continue editing opens the updated file as round 2", pg.evaluate("__app.state.version") == 2)
    b.close()

def t_form2(pw):
    b, pg, errs = session(pw); load(pg, ROOT + "/tests/real/form2-1-comment.pdf")
    out = f"{OUT}/s_form2.pdf"; preview_and_download(pg, out)
    t = text_of(out, 2)
    check("form2: new wording", "Additional comments including if there are interventions / de-escalation methods to mitigate" in t)
    check("form2: fields kept", len(fields_of(out)) == len(fields_of(ROOT + "/tests/real/form2-1-comment.pdf")))
    check("form2: no errors", not errs, errs)
    b.close()

def t_features(pw):
    b, pg, errs = session(pw); load(pg, f"{FX}/features.pdf")
    cs = changes(pg)
    check("fx: 4 changes", len(cs) == 4, cs)
    # turn on close-the-gap for the removed phone row
    pg.evaluate("""()=>{ const c=__app.state.changes.find(c=>/Phone/.test(c.targetText)); c.closeGap=true; }""")
    out = f"{OUT}/s_features.pdf"; done = preview_and_download(pg, out)
    t = text_of(out)
    check("fx: phone row removed", "Phone number" not in t)
    check("fx: strike-through removed", "Emergency contact" not in t)
    check("fx: sticky find/replace", "Client intake form" in t and "Intake form" not in t.replace("Client intake form", ""))
    f = fields_of(out)
    check("fx: placeholder checkboxes", sum(1 for k, v in f.items() if v == "CheckBox") == 2, f)
    check("fx: removed rows' fields gone", "q3" not in f and "q4" not in f, list(f))
    y_base, y_new = y_of(f"{FX}/base.pdf", "Notes:"), y_of(out, "Notes:")
    check("fx: gap closed (rows below moved up)", y_new is not None and y_base - y_new > 20, (y_base, y_new))
    wn = [w for p in pymupdf.open(out) for w in p.widgets() if w.field_name == "q6"]
    wb = [w for p in pymupdf.open(f"{FX}/base.pdf") for w in p.widgets() if w.field_name == "q6"]
    check("fx: field moved with its row", wn and wb and wb[0].rect.y0 - wn[0].rect.y0 > 20, (wb and wb[0].rect, wn and wn[0].rect))
    check("fx: footer stayed put", abs(y_of(out, "Footer:") - y_of(f"{FX}/base.pdf", "Footer:")) < 0.5)
    check("fx: no errors", not errs, errs)
    pymupdf.open(out)[0].get_pixmap(dpi=80).save(f"{OUT}/s_features.png")
    b.close()

def t_move(pw):
    b, pg, errs = session(pw); load(pg, f"{FX}/move.pdf")
    out = f"{OUT}/s_move.pdf"; preview_and_download(pg, out)
    ys = {k: y_of(out, k) for k in ["Date of birth:", "Notes:", "Client name:"]}
    check("move: row is now last", ys["Date of birth:"] > ys["Notes:"] > ys["Client name:"], ys)
    f = {w.field_name: w.rect for p in pymupdf.open(out) for w in p.widgets()}
    check("move: its field moved too", f["q2"].y0 > f["q6"].y0, (f["q2"], f["q6"]))
    pymupdf.open(out)[0].get_pixmap(dpi=80).save(f"{OUT}/s_move.png")
    check("move: no errors", not errs, errs)
    b.close()

def t_header(pw):
    b, pg, errs = session(pw); load(pg, f"{FX}/header.pdf")
    cs = changes(pg)
    check("header: offered on page 2, on by default", cs[0]["also"] == [1] and cs[0]["repeat"] is True, cs[0])
    out = f"{OUT}/s_header.pdf"; preview_and_download(pg, out)
    d = pymupdf.open(out)
    check("header: changed on both pages", all("DRAFT" not in d[i].get_text() and "Community Services" in d[i].get_text() for i in range(2)))
    b.close()

def t_manual(pw):
    b, pg, errs = session(pw); load(pg, f"{FX}/clean.pdf")
    check("manual: clean PDF opens with guidance", pg.locator(".card").count() == 1 and "No reviewer comments" in pg.inner_text("#cards"))
    # drag across "Address:" with the mouse
    box = pg.locator(".pagewrap.before").first.bounding_box()
    pdfw, pdfh = 612, 792
    r = pymupdf.open(f"{FX}/clean.pdf")[0].search_for("Address:")[0]
    sx, sy = box["x"] + (r.x0 - 2) / pdfw * box["width"], box["y"] + (r.y0 - 2) / pdfh * box["height"]
    ex, ey = box["x"] + (r.x1 + 2) / pdfw * box["width"], box["y"] + (r.y1 + 2) / pdfh * box["height"]
    pg.mouse.move(sx, sy); pg.mouse.down(); pg.mouse.move(ex, ey, steps=5); pg.mouse.up()
    cs = changes(pg)
    check("manual: drag made a change card", len(cs) == 1 and cs[0]["target"] == "Address:", cs)
    pg.fill(".card textarea", "Street address:")
    out = f"{OUT}/s_manual.pdf"; preview_and_download(pg, out)
    check("manual: change applied", "Street address:" in text_of(out))
    check("manual: compare images shown", pg.locator(".cmp img").count() >= 2)
    pg.screenshot(path=f"{OUT}/s_manual_ui.png")
    check("manual: no errors", not errs, errs)
    b.close()

def t_errors(pw):
    for f, want in [("locked.pdf", "password"), ("notapdf.pdf", "isn’t a readable PDF")]:
        b, pg, errs = session(pw); load(pg, f"{FX}/{f}")
        msg = pg.inner_text("#err")
        check(f"error: {f} explained", want in msg and not pg.evaluate("!document.querySelector('#work').hidden"), msg)
        b.close()
    b, pg, errs = session(pw); load(pg, f"{FX}/scanned.pdf")
    check("error: scanned page flagged", "scanned" in pg.inner_text("#banner"))
    b.close()
    b, pg, errs = session(pw); load(pg, f"{FX}/rotated.pdf")
    cs = changes(pg)
    check("error: rotated page changes held back", all(c["status"] in ("skip", "need") for c in cs), cs)
    b.close()
    b, pg, errs = session(pw)
    pg.set_input_files("#file", f"{FX}/features.pdf")
    pg.wait_for_selector("#work:not([hidden])"); pg.wait_for_function("() => !document.querySelector('.busy')")
    pg.evaluate("()=>{ const go=document.querySelector('#go'); go.click(); go.click(); go.click(); }")
    pg.wait_for_function("() => __app.state.out", timeout=60000)
    check("error: repeated clicks don't break the build", not errs, errs)
    b.close()

def t_review_regressions(pw):
    # neighbouring rows closed together + a move on the same page (review #1)
    b, pg, errs = session(pw); load(pg, f"{FX}/multi.pdf")
    pg.evaluate("()=>{ for (const c of __app.state.changes) if (c.action==='remove') c.closeGap=true; }")
    out = f"{OUT}/s_multi.pdf"; done = preview_and_download(pg, out)
    t = text_of(out)
    keep = ["Intake form", "Client name:", "Date of birth:", "Smoker:", "Notes:", "Footer:"]
    check("multi: nothing else lost", all(k in t for k in keep), [k for k in keep if k not in t])
    check("multi: removed rows gone", "Phone number" not in t and "Emergency contact" not in t)
    ys = {k: y_of(out, k) for k in ["Date of birth:", "Smoker:", "Notes:", "Client name:"]}
    check("multi: order is DOB, Smoker, Notes, Client name", ys["Date of birth:"] < ys["Smoker:"] < ys["Notes:"] < ys["Client name:"], ys)
    check("multi: rows closed up", y_of(f"{FX}/base.pdf", "Smoker:") - ys["Smoker:"] > 40, (y_of(f"{FX}/base.pdf", "Smoker:"), ys["Smoker:"]))
    f = {w.field_name: w.rect for p in pymupdf.open(out) for w in p.widgets()}
    check("multi: fields follow rows", set(f) == {"q1", "q2", "q5", "q6"} and abs(f["q1"].y0 - (pymupdf.open(out)[0].search_for("Client name:")[0].y0)) < 8, {k: round(v.y0) for k, v in f.items()})
    check("multi: file didn't bloat", len(open(out, "rb").read()) < 3 * len(open(f"{FX}/multi.pdf", "rb").read()) + 60000)
    pymupdf.open(out)[0].get_pixmap(dpi=80).save(f"{OUT}/s_multi.png")
    check("multi: no errors", not errs, errs); b.close()
    # owner-password lock explained up front (review #4)
    b, pg, errs = session(pw); load(pg, f"{FX}/ownerlocked.pdf")
    check("locked for editing: explained on open", "locked against editing" in pg.inner_text("#err"), pg.inner_text("#err")); b.close()
    # find stays inside the highlight; whole words only (review #2, #3)
    b, pg, errs = session(pw); load(pg, f"{FX}/datefind.pdf")
    out = f"{OUT}/s_datefind.pdf"; preview_and_download(pg, out); t = text_of(out)
    check("find: only the highlighted Date changed", "Day of birth:" in t and "Date of birth" not in t and "Date of visit:" in t and "Username:" in t and "Update date:" in t, t)
    r = pg.evaluate("""()=>{ const items=[{str:'Username:',x0:40,x1:100,y:700,y0:697,y1:709,size:12},{str:'Name:',x0:40,x1:75,y:676,y0:673,y1:685,size:12}];
        const f=__app.Engine.findText({items},'name'); return f && Math.round(f.rects[0][1]); }""")
    check("find: whole words only", r == 673, r)
    r = pg.evaluate("""()=>{ const items=[{str:'Name:      Date of',x0:40,x1:200,y:700,y0:697,y1:709,size:12},{str:'birth:',x0:204,x1:234,y:700,y0:697,y1:709,size:12}];
        const f=__app.Engine.findText({items},'date of birth'); return f && f.rects[0].map(Math.round); }""")
    check("find: spaced-out lines map correctly", r and 130 < r[0] < 145 and 226 <= r[2] <= 232, r)
    b.close()
    # accidental mouse drag isn't a Ready change (review #8)
    b, pg, errs = session(pw); load(pg, f"{FX}/clean.pdf")
    box = pg.locator(".pagewrap.before").first.bounding_box()
    r = pymupdf.open(f"{FX}/clean.pdf")[0].search_for("Name:")[0]
    pg.mouse.move(box["x"] + (r.x0 - 2) / 612 * box["width"], box["y"] + (r.y0 - 2) / 792 * box["height"]); pg.mouse.down()
    pg.mouse.move(box["x"] + (r.x1 + 2) / 612 * box["width"], box["y"] + (r.y1 + 2) / 792 * box["height"], steps=4); pg.mouse.up()
    check("manual: untouched drag needs her", changes(pg)[0]["status"] == "need", changes(pg)); b.close()
    # continue editing names versions (review #15)
    b, pg, errs = session(pw); load(pg, f"{FX}/header.pdf")
    out = f"{OUT}/s_v1.pdf"; preview_and_download(pg, out)
    pg.reload(); pg.wait_for_selector(".hrow")
    pg.locator(".hrow").first.locator("button[data-a='cont']").click(); pg.wait_for_selector("#work:not([hidden])")
    check("history: second round is v2", pg.evaluate("__app.state.version") == 2 and pg.evaluate("__app.state.name") == "header", pg.evaluate("[__app.state.name, __app.state.version]"))
    b.close()

def t_phone(pw):
    b, pg, errs = session(pw, viewport=(390, 844), mobile=True)
    pg.screenshot(path=f"{OUT}/s_phone_start.png")
    load(pg, ROOT + "/tests/real/form1-16-comments.pdf")
    sw = pg.evaluate("document.documentElement.scrollWidth"); iw = pg.evaluate("innerWidth")
    check("phone: no sideways scrolling", sw <= iw, (sw, iw))
    pg.screenshot(path=f"{OUT}/s_phone_work.png")
    pg.click("#markBtn")
    box = pg.locator(".pagewrap.before").first.bounding_box()
    # touch drag via pointer events
    pg.evaluate("""([x0,y0,x1,y1])=>{ const el=document.querySelector('.pagewrap.before');
      const ev=(t,x,y)=>el.dispatchEvent(new PointerEvent(t,{bubbles:true,clientX:x,clientY:y,pointerId:7,pointerType:'touch',isPrimary:true}));
      ev('pointerdown',x0,y0); ev('pointermove',(x0+x1)/2,(y0+y1)/2); ev('pointermove',x1,y1); ev('pointerup',x1,y1); }""",
        [box["x"] + box["width"] * 0.03, box["y"] + box["height"] * 0.12, box["x"] + box["width"] * 0.2, box["y"] + box["height"] * 0.15])
    n = pg.evaluate("__app.state.changes.filter(c=>c.manual).length")
    check("phone: finger drag marks a change", n == 1, n)
    pg.screenshot(path=f"{OUT}/s_phone_card.png")
    b.close()

def t_dark(pw):
    b = pw.chromium.launch(); ctx = b.new_context(color_scheme="dark", viewport={"width": 1300, "height": 900}); pg = ctx.new_page()
    pg.goto("file://" + ROOT + "/dist/index.html"); load(pg, ROOT + "/tests/real/form2-1-comment.pdf")
    bg = pg.evaluate("getComputedStyle(document.body).backgroundColor")
    check("dark mode: dark background", bg in ("rgb(0, 0, 0)",), bg)
    pg.screenshot(path=f"{OUT}/s_dark.png"); b.close()

with sync_playwright() as pw:
    b, pg, errs = session(pw); t_phrases(pg); b.close()
    for t in [t_form1, t_form2, t_features, t_move, t_header, t_manual, t_errors, t_review_regressions, t_phone, t_dark]:
        try: t(pw)
        except Exception as e:
            traceback.print_exc(); check(t.__name__ + " crashed", False, str(e)[:200])

failed = [r for r in results if not r[1]]
print(f"\n{len(results)-len(failed)}/{len(results)} passed")
for f in failed: print("FAILED:", f[0], f[2])
