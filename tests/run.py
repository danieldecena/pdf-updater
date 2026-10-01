"""End-to-end harness: load a PDF in the app, optionally tweak changes, preview, download."""
import json, sys, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
from playwright.sync_api import sync_playwright

APP = "file://" + ROOT + "/dist/index.html"

def session(pw, viewport=(1400, 1000), mobile=False):
    b = pw.chromium.launch()
    ctx = b.new_context(viewport={"width": viewport[0], "height": viewport[1]}, accept_downloads=True,
                        is_mobile=mobile, has_touch=mobile, device_scale_factor=2 if mobile else 1)
    pg = ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append("pageerror: " + str(e)))
    pg.on("console", lambda m: m.type == "error" and errs.append("console: " + m.text))
    pg.goto(APP)
    return b, pg, errs

def load(pg, pdf):
    pg.set_input_files("#file", pdf)
    pg.wait_for_function("() => !document.querySelector('#work').hidden || document.querySelector('#err').textContent", timeout=60000)
    pg.wait_for_function("() => !document.querySelector('.busy')", timeout=60000)

def changes(pg):
    return pg.evaluate("""() => __app.state.changes.map(c => ({n:c.n, page:c.page+1, note:(c.note||'').slice(0,60),
        target:(c.targetText||'').slice(0,50), action:c.action, text:String(c.text).slice(0,70), find:c.find, status:__app.UI.status(c),
        also:c.alsoPages, repeat:c.repeat, moveTo:c.moveTo}))""")

def preview_and_download(pg, out, both=None):
    pg.click("#go")
    pg.wait_for_function("() => __app.state.out || !document.querySelector('#done').hidden", timeout=120000)
    pg.wait_for_function("() => !document.querySelector('.busy')", timeout=120000)
    done = pg.inner_text("#done")
    if not pg.evaluate("() => !!__app.state.out"):
        return done
    with pg.expect_download(timeout=60000) as dl:
        pg.click("#go")
    dl.value.save_as(out)
    if both:
        with pg.expect_download(timeout=60000) as dl2:
            pg.click("#both")
        dl2.value.save_as(both)
    return done

if __name__ == "__main__":
    pdf, out = sys.argv[1], sys.argv[2]
    with sync_playwright() as pw:
        b, pg, errs = session(pw)
        load(pg, pdf)
        print("ERR:", pg.inner_text("#err"))
        for c in changes(pg): print(json.dumps(c))
        print("SUM:", pg.inner_text("#sum"))
        print("DONE:", preview_and_download(pg, out))
        pg.screenshot(path=out.replace('.pdf', '_ui.png'))
        print("ERRORS:", errs)
        b.close()
