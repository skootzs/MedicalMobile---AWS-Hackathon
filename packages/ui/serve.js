import { readFile } from 'node:fs/promises'

const assets = new Map([
  ['/styles.css',['src/styles.css','text/css']],
  ['/workspace.css',['src/workspace.css','text/css']],
  ['/app.js',['src/app.js','text/javascript']],
  ['/tracking.js',['src/tracking.js','text/javascript']],
  ['/flowchart-renderer.js',['dist/flowchart-renderer.js','text/javascript']],
  ...['boot','workspace','icons','data','state','requests'].map(name=>[`/workspace/${name}.js`,[`src/workspace/${name}.js`,'text/javascript']]),
  ...['cht-logo','cht-mark'].map(name=>[`/assets/${name}.svg`,[`assets/${name}.svg`,'image/svg+xml']])
])
export const isUiRoute = path => /^\/(?:saved|recent|signed-out|protocols(?:\/[a-f0-9-]{36}(?:\/draft)?)?|collections(?:\/[a-z0-9-]+)?|guidelines\/[a-z0-9-]+|requests(?:\/(?:new|[a-f0-9-]{36}))?)?$/.test(path)
export function createUiResponder() {
  return async (req,res,path) => {
    if(req.method!=='GET')return false
    const asset=assets.get(path) || (isUiRoute(path)?['index.html','text/html']:null)
    if(!asset)return false
    const content=await readFile(new URL(asset[0],import.meta.url))
    const csp = "default-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"
    res.writeHead(200,{'Content-Type':`${asset[1]}; charset=utf-8`,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Content-Security-Policy':csp})
    res.end(content)
    return true
  }
}
