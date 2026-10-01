"""Inline the app, libraries, worker and subsetted fonts into one offline file: dist/index.html."""
import base64, json, os
d=os.path.dirname(os.path.abspath(__file__))+'/'
def rd(p): return open(d+p, encoding='utf-8').read()
def js(p): return rd(p).replace('</script','<\\/script')
fonts={}
for f in ['Carlito-Regular','Carlito-Bold','LiberationSans-Regular','LiberationSans-Bold','LiberationSerif-Regular','LiberationSerif-Bold']:
    fonts[f]=base64.b64encode(open(d+'fonts/'+f+'.ttf','rb').read()).decode()
app='\n'.join(js('src/'+m) for m in ['engine.js','scrub.js','apply.js','store.js','app.js'])
t=rd('src/shell.html')
for k,v in [('/*CSS*/',rd('src/styles.css')),('/*PDFJS*/',js('node_modules/pdfjs-dist/build/pdf.min.js')),('/*PDFLIB*/',js('node_modules/pdf-lib/dist/pdf-lib.min.js')),
            ('/*FONTKIT*/',js('node_modules/@pdf-lib/fontkit/dist/fontkit.umd.min.js')),('/*WORKER*/',base64.b64encode(open(d+'node_modules/pdfjs-dist/build/pdf.worker.min.js','rb').read()).decode()),
            ('/*FONTS*/',json.dumps(fonts)),('/*APP*/',app)]:
    assert k in t, k
    t=t.replace(k, v.replace('\\','\\\\') if False else v, 1)
out=d+'dist/index.html'; os.makedirs(d+'dist',exist_ok=True)
open(out,'w',encoding='utf-8').write(t)
print(os.path.getsize(out)//1024,'KB')
