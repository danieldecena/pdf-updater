"""Build small PDFs that exercise each feature and each failure mode."""
import pymupdf, os
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter
from reportlab.lib.colors import black

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fx")
os.makedirs(OUT, exist_ok=True)
W, H = letter

def table_form(path, rows, title="Intake form"):
    """A bordered table of question rows, each with a text field — like the real forms."""
    c = canvas.Canvas(path, pagesize=letter)
    c.setFont("Helvetica-Bold", 14); c.drawString(40, H - 50, title)
    c.setFont("Helvetica", 11)
    top = H - 80; rh = 24
    c.setLineWidth(0.8); c.rect(30, top - rh * len(rows), W - 60, rh * len(rows))
    for i, q in enumerate(rows):
        y = top - rh * (i + 1)
        if i: c.line(30, y + rh, W - 30, y + rh)
        c.drawString(36, y + 8, q)
        x = 36 + c.stringWidth(q, "Helvetica", 11) + 8
        c.acroForm.textfield(name=f"q{i+1}", x=x, y=y + 5, width=W - 40 - x, height=14, borderWidth=0, fontSize=10)
        c.setLineWidth(0.5); c.line(x, y + 5, W - 40, y + 5); c.setLineWidth(0.8)
    c.setFont("Helvetica", 9); c.drawString(40, 30, "Footer: office@example.org")
    c.showPage(); c.save()

def annotate(src, dst, items):
    """items: (page, kind, find_text or rect, note)"""
    d = pymupdf.open(src)
    for page, kind, what, note in items:
        p = d[page]
        if kind == "sticky":
            a = p.add_text_annot(what, note)
        else:
            quads = p.search_for(what, quads=True)
            assert quads, f"not found: {what}"
            a = {"highlight": p.add_highlight_annot, "strike": p.add_strikeout_annot, "underline": p.add_underline_annot}[kind](quads)
            if note: a.set_info(content=note)
        a.set_info(title="Reviewer"); a.update()
    d.save(dst)

ROWS = ["Client name:", "Date of birth:", "Phone number:", "Emergency contact:", "Smoker:", "Notes:"]

# 1. close the gap + strike-through + placeholder + sticky find/replace + header repeat
table_form(f"{OUT}/base.pdf", ROWS)
annotate(f"{OUT}/base.pdf", f"{OUT}/features.pdf", [
    (0, "highlight", "Phone number:", "let's remove this"),
    (0, "strike", "Emergency contact:", ""),
    (0, "highlight", "Smoker:", "change to: Smoker: yes _ no _"),
    (0, "sticky", (W - 60, H - 50), 'Change "Intake form" to "Client intake form"'),
])

# 2. a row move to the end of its section
annotate(f"{OUT}/base.pdf", f"{OUT}/move.pdf", [(0, "highlight", "Date of birth:", "could this be the last line in this section?")])

# 3. two pages with a repeated header
c = canvas.Canvas(f"{OUT}/twopage.pdf", pagesize=letter)
for n in range(2):
    c.setFont("Helvetica", 9); c.drawString(40, H - 30, "DRAFT - Community Services")
    c.setFont("Helvetica", 12); c.drawString(40, H - 80, f"Page {n+1} body text goes here.")
    c.showPage()
c.save()
annotate(f"{OUT}/twopage.pdf", f"{OUT}/header.pdf", [(0, "highlight", "DRAFT - Community Services", "change to: Community Services")])

# 4. clean PDF (no comments) for do-it-myself mode
table_form(f"{OUT}/clean.pdf", ["Name:", "Address:", "City:"], title="Clean form")

# 5. encrypted
d = pymupdf.open(f"{OUT}/base.pdf"); d.save(f"{OUT}/locked.pdf", encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw="secret", owner_pw="owner")

# 6. scanned (image only)
d = pymupdf.open(f"{OUT}/base.pdf"); pix = d[0].get_pixmap(dpi=72)
s = pymupdf.open(); pg = s.new_page(width=W, height=H); pg.insert_image(pg.rect, pixmap=pix); s.save(f"{OUT}/scanned.pdf")

# 7. rotated page with a comment
d = pymupdf.open(f"{OUT}/features.pdf"); d[0].set_rotation(90); d.save(f"{OUT}/rotated.pdf")

# 9. two neighbouring rows closed + a move on the same page
annotate(f"{OUT}/base.pdf", f"{OUT}/multi.pdf", [
    (0, "highlight", "Phone number:", "let's remove this"),
    (0, "highlight", "Emergency contact:", "let's remove this"),
    (0, "highlight", "Client name:", "could this be the last line in this section?"),
])
# 10. locked against editing (owner password only — opens without a password)
d = pymupdf.open(f"{OUT}/base.pdf"); d.save(f"{OUT}/ownerlocked.pdf", encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw="owner", user_pw="", permissions=pymupdf.PDF_PERM_PRINT)
# 11. find inside a highlight: the third "Date" is the one marked
c = canvas.Canvas(f"{OUT}/dates.pdf", pagesize=letter); c.setFont("Helvetica", 12)
for i, t in enumerate(["Date of visit:", "Username:", "Update date:", "Date of birth:"]): c.drawString(40, H - 80 - 24 * i, t)
c.showPage(); c.save()
annotate(f"{OUT}/dates.pdf", f"{OUT}/datefind.pdf", [(0, "highlight", "Date of birth:", 'Change "Date" to "Day"')])

# 8. not a PDF
open(f"{OUT}/notapdf.pdf", "w").write("hello, this is not a pdf")

print(sorted(os.listdir(OUT)))
