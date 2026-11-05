// Test-only host: real intake/review services, in-memory storage and an injected screener.
// Never imported by npm start or by any browser asset.
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createUiResponder } from '../serve.js'
import { submit, hash, HttpError } from '../../intake/intake.js'
import { createReview } from '../../intake/review.js'
import { screeningConfig } from '../../intake/screening.js'

export function createUiTestServer() {
  const revisions=[], reservations=new Map(), objects=new Map(), phases=new Map(), heads=new Map()
  const registry={v1:hash('test baseline')}, traffic=[]
  let screenCalls=0
  const store={
    async history(author,id){return revisions.filter(r=>r.authorId===author&&(!id||r.requestId===id))},
    async revision(author,id,revisionId){return revisions.find(r=>r.authorId===author&&r.requestId===id&&r.revisionId===revisionId)},
    async reserve(author,key,proposed){const id=`${author}:${key}`;if(!reservations.has(id))reservations.set(id,proposed);return reservations.get(id)},
    async source(key,bytes){objects.set(key,bytes);return {bucket:'test-only',key,versionId:'1',sha256:hash(bytes)}},
    async readSource(source){return objects.get(source.key)},
    async finish(author,key,value){const reservation=reservations.get(`${author}:${key}`);if(!reservation.result){reservation.result=value;revisions.push(value);heads.set(value.requestId,value.revisionId)}return reservation.result},
    async phase(author,id,revisionId){return structuredClone(phases.get(`${author}:${id}:${revisionId}`))},
    async savePhase(author,id,revisionId,previous,next,event,current){
      const key=`${author}:${id}:${revisionId}`,saved=phases.get(key)
      if(saved?.version!==previous?.version||current&&heads.get(id)!==revisionId)return null
      const value={...structuredClone(next),version:(saved?.version||0)+1}
      phases.set(key,value);return structuredClone(value)
    }
  }
  const config=screeningConfig({INTAKE_SCREENING_ENABLED:'true',BEDROCK_MODEL_ID:'test',BEDROCK_GUARDRAIL_ID:'test',BEDROCK_GUARDRAIL_VERSION:'1'})
  const review=createReview({store,registry,config,screen:async input=>{
    screenCalls++
    const clarification=input.requirements.goal.includes('[clarify]')
    return {result:{decision:clarification?'needs_clarification':'pass',summary:clarification?'Clarify the requested timing.':'The submitted requirements are complete.',suggestions:[],issues:clarification?[{code:'TIMING',field:'acceptanceCriteria',question:'When should the task appear?'}]:[],evidence:[{source:input.requirementsSource,location:'Submitted requirements'}]}}
  }})
  const serveUi=createUiResponder()
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost'),path=url.pathname
    const send=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body))}
    try {
      if(await serveUi(req,res,path))return
      if(path==='/test-authorize') {res.writeHead(302,{Location:`/?code=test-code&state=${encodeURIComponent(url.searchParams.get('state'))}`});return res.end()}
      if(path==='/logout'){res.writeHead(302,{Location:'/signed-out'});return res.end()}
      if(path==='/api/sign-in')return send(200,{hostedUrl:`http://${req.headers.host}`,clientId:'ui-test',redirectUri:`http://${req.headers.host}/`})
      if(path==='/oauth2/authorize'){res.writeHead(302,{Location:`/test-authorize?state=${encodeURIComponent(url.searchParams.get('state'))}`});return res.end()}
      let raw=Buffer.alloc(0)
      if(req.method==='POST'){const chunks=[];for await(const chunk of req)chunks.push(chunk);raw=Buffer.concat(chunks)}
      traffic.push({method:req.method,path,body:raw.toString(),key:req.headers['idempotency-key']})
      if(path==='/api/session')return send(200,{token:'test-only-alice'})
      const author=req.headers.authorization==='Bearer test-only-alice'?'alice':req.headers.authorization==='Bearer test-only-bob'?'bob':null
      if(!author)throw new HttpError(401,'Sign in to continue.')
      if(path==='/api/profile')return send(200,{authorId:author,username:'Test product owner',roles:['PO']})
      if(path==='/api/versions')return send(200,Object.keys(registry))
      const match=/^\/api\/requests(?:\/([a-f0-9-]{36})(?:\/revisions\/([a-f0-9-]{36})\/(screening|preview|confirmation))?)?$/.exec(path)
      if(!match)throw new HttpError(404,'Request not found.')
      const [,id,revisionId,action]=match
      if(action){
        if(req.method==='GET'&&action==='screening')return send(200,await review.get(author,id,revisionId))
        if(req.method!=='POST')throw new HttpError(405,'Method not allowed.')
        const body=JSON.parse(raw.toString()||'{}')
        return send(200,await (action==='screening'?review.screen(author,id,revisionId):action==='preview'?review.preview(author,id,revisionId):review.confirm(author,id,revisionId,body)))
      }
      if(req.method==='GET'){
        const rows=await store.history(author,id)
        if(id&&!rows.length)throw new HttpError(404,'Request not found.')
        return send(200,rows)
      }
      if(req.method==='POST')return send(200,await submit({store,registry,author,requestId:id,key:req.headers['idempotency-key'],raw}))
      throw new HttpError(405,'Method not allowed.')
    }catch(error){send(error.status||500,error.status?error.message:'Test host failed.')}
  })
  return {server,traffic,revisions,phases,screenCalls:()=>screenCalls}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const {server}=createUiTestServer()
  server.listen(3197,'127.0.0.1',()=>console.log('UI test host: http://127.0.0.1:3197'))
}
