import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { latestRequests, requestStatus, nextAction, renderRequestTimeline, renderRequestTracking, loadReviews } from '../src/workspace/requests.js'
import { trackingState } from '../src/tracking.js'
import { createUiResponder, isUiRoute } from '../serve.js'
import { createUiTestServer } from './test-server.js'

const requestId='11111111-1111-4111-8111-111111111111'
const revision=(id='a',at='2026-11-04T12:00:00Z')=>({requestId,revisionId:id,events:[{at}],screeningStatus:'pending_screening',baselineVersion:'v1'})

test('request lists group revisions and order by received time without mutating source data',()=>{
  const rows=[revision('old','2026-10-01T00:00:00Z'),{...revision('other','2026-11-03T00:00:00Z'),requestId:'other'},revision('new')]
  assert.deepEqual(latestRequests(rows).map(r=>r.revisionId),['new','other'])
  assert.equal(rows[0].revisionId,'old')
})
test('display status uses evolving review state rather than immutable screeningStatus',()=>{
  const r=revision()
  for(const [review,expected] of [[undefined,'loading'],[{status:'needs_clarification'},'needs_clarification'],[{status:'screening_passed',preview:{}},'preview_ready'],[{status:'screening_passed',preview:{},confirmed:true},'confirmed']])assert.equal(requestStatus(r,review),expected)
  assert.equal(requestStatus({...r,screeningStatus:'blocked'},{confirmed:true}),'blocked')
})
test('primary actions respect screening availability, leases, correction and confirmation gates',()=>{
  const r=revision()
  const cases=[
    [{enabled:false,status:'pending_screening'},null],
    [{enabled:true,status:'pending_screening'},'screening'],
    [{enabled:true,status:'screening'},'refresh'],
    [{enabled:true,status:'screening',leaseExpired:true},'screening'],
    [{enabled:true,status:'needs_clarification'},'correct'],
    [{enabled:true,status:'screening_blocked'},'screening'],
    [{enabled:true,status:'screening_failed',retryable:true},'screening'],
    [{enabled:true,status:'screening_passed'},'preview'],
    [{enabled:true,status:'screening_passed',preview:{}},'review'],
    [{enabled:true,status:'screening_passed',preview:{},confirmed:true},'correct'],
    [{enabled:true,rejection:{}},'correct']
  ]
  for(const [state,action] of cases)assert.equal(nextAction(r,state)[1],action)
  assert.equal(nextAction({...r,screeningStatus:'blocked'},{enabled:false})[1],'correct')
})
test('new tracking has six implemented stages, escapes server text and never claims a release',()=>{
  const state={enabled:true,status:'screening_passed',preview:{},confirmed:true,message:'<img src=x onerror=alert(1)>'}
  const html=renderRequestTracking({...revision(),baselineVersion:'<script>'},state)
  assert.match(html,/Request confirmed\. Handoff queued\./)
  assert.match(html,/&lt;img/)
  assert.doesNotMatch(html,/<script>|<img/)
  assert.match(html,/Download unavailable/)
  assert.match(html,/disabled/)
  assert.equal((renderRequestTimeline(revision(),state).match(/<li /g)||[]).length,6)
  assert.match(renderRequestTimeline(revision(),undefined),/Loading current review state/)
})
test('integrated stages advance through independent reviews and stop at the failed stage', () => {
  const r = revision()
  const review = { enabled: true, status: 'screening_passed', preview: {}, confirmed: true }
  const phases = [
    ['queued', 'Downstream handoff'],
    ['DRAFTING_LOGIC', 'Clinical drafting'],
    ['WAITING_FOR_LOGIC_CHECKS', 'Logic checks'],
    ['WAITING_FOR_CLINICAL_APPROVAL', 'Clinical approval'],
    ['COMPILING', 'Configuration build'],
    ['VERIFYING', 'Build verification'],
    ['WAITING_FOR_RELEASE_APPROVAL', 'Release approval']
  ]
  for (const [offset, [status, label]] of phases.entries()) {
    const workflow = { status, label }
    const state = { ...review, workflow }
    const model = trackingState(r, state)
    assert.equal(model.steps[model.current].label, label)
    assert.deepEqual(model.steps.map(step => step.state), [
      ...Array(5 + offset).fill('complete'), 'current', ...Array(7 - offset).fill('upcoming')
    ])
    assert.match(renderRequestTimeline(r, state), new RegExp(`Stage ${6 + offset} of 13`))
  }

  const failed = trackingState(r, { ...review, workflow: { status: 'FAILED', stoppedAt: 'VERIFYING', label: 'Verification failed' } })
  assert.equal(failed.steps[failed.current].label, 'Build verification')
  assert.equal(failed.steps[failed.current].state, 'attention')
  assert.equal(failed.steps[failed.current + 1].state, 'upcoming')

  const released = { ...review, workflow: { status: 'RELEASE_APPROVED', label: 'Approved for download', downloadable: true } }
  assert.ok(trackingState(r, released).steps.every(step => step.state === 'complete'))
  assert.match(renderRequestTimeline(r, released), /Workflow complete/)
  assert.doesNotMatch(renderRequestTimeline(r, released), /aria-current="step"/)
  assert.equal(nextAction(r, released)[1], 'download')
})
test('review loading uses at most four concurrent reads, isolates errors and respects navigation cancellation',async()=>{
  let active=0,max=0,results=[]
  const rows=Array.from({length:11},(_,i)=>revision(String(i)))
  await loadReviews(rows,async r=>{active++;max=Math.max(max,active);await new Promise(resolve=>setImmediate(resolve));active--;if(r.revisionId==='2')throw new Error('Unavailable');return {status:'pending_screening'}},(r,result)=>results.push([r,result]))
  assert.equal(max,4);assert.equal(results.length,11)
  assert.equal(results.find(([r])=>r.revisionId==='2')[1].error,'Unavailable')
  let current=true,reads=0
  results=[]
  await loadReviews(rows,async()=>{reads++;current=false;return {}},(r,result)=>results.push(result),()=>current)
  assert.equal(reads,1);assert.equal(results.length,0)
})
test('static hosting preserves security headers, deep links and a strict asset allowlist',async()=>{
  const serve=createUiResponder()
  for(const path of ['/','/protocols',`/protocols/${requestId}/draft`,`/requests/${requestId}`,'/collections/infectious-diseases','/saved','/recent'])assert.equal(isUiRoute(path),true)
  for(const path of ['/api/requests','/workspace/test-server.js','/vendor/pdf.mjs','/../.env','/protocols/sample'])assert.equal(isUiRoute(path),false)
  for(const path of ['/workspace/boot.js','/workspace/requests.js','/workspace.css','/assets/cht-logo.svg',`/requests/${requestId}`]){
    let headers,content
    assert.equal(await serve({method:'GET'},{writeHead(status,value){assert.equal(status,200);headers=value},end(value){content=value}},path),true)
    assert.equal(headers['Content-Security-Policy'],"default-src 'self'; base-uri 'none'; frame-ancestors 'none'")
    assert.equal(headers['Cache-Control'],'no-store');assert.ok(content.length)
  }
  assert.equal(await serve({method:'GET'},{},'/runtime.js'),false)
  assert.equal(await serve({method:'POST'},{},'/'),false)
  const boot=await readFile(new URL('../src/workspace/boot.js',import.meta.url),'utf8')
  const app=await readFile(new URL('../src/app.js',import.meta.url),'utf8')
  assert.doesNotMatch(boot+app,/chtPreview|local-preview|test-only-alice/)
})
test('same-origin host exercises real intake and review contracts through queued handoff',async t=>{
  const fixture=createUiTestServer(),server=fixture.server
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)))
  const base=`http://127.0.0.1:${server.address().port}`
  const call=async(path,body,token='test-only-alice',key='test-ui-submission-key')=>{
    const response=await fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':key},...(body&&{body:JSON.stringify(body)})})
    return {status:response.status,body:await response.json()}
  }
  const payload={goal:'  Follow-up task  ',pathway:'Follow-up',targetUsers:'CHWs',acceptanceCriteria:'Show the task after assessment.',baselineVersion:'v1',guidelineUrls:[]}
  const saved=await call('/api/requests',payload),r=saved.body
  assert.equal(r.normalizedRequirements.goal,'Follow-up task')
  assert.equal(r.sources.length,1)
  assert.equal((await call('/api/requests',payload)).body.revisionId,r.revisionId)
  const detail=`/api/requests/${r.requestId}`,baseRevision=`${detail}/revisions/${r.revisionId}`
  assert.equal((await call(detail,undefined,'test-only-bob')).status,404)
  assert.equal((await call(`${baseRevision}/screening`)).body.status,'pending_screening')
  assert.equal(fixture.screenCalls(),0)
  await call(`${baseRevision}/screening`,{})
  const preview=(await call(`${baseRevision}/preview`,{})).body
  const binding={attemptId:preview.attemptId,previewId:preview.preview.id,previewHash:preview.preview.hash,feedback:''}
  assert.equal((await call(`${baseRevision}/confirmation`,{...binding,previewHash:'stale'})).status,409)
  const confirmed=(await call(`${baseRevision}/confirmation`,binding)).body
  assert.equal(confirmed.confirmed,true);assert.equal(confirmed.handoff,'queued')
  assert.equal((await call(`${baseRevision}/screening`,{})).status,409)
  const correction=(await call(detail,{...payload,goal:'Corrected follow-up'},'test-only-alice','test-ui-correction-key')).body
  assert.notEqual(correction.revisionId,r.revisionId);assert.equal(correction.requestId,r.requestId)
  assert.equal((await call(`${detail}/revisions/${correction.revisionId}/screening`)).body.status,'pending_screening')
  assert.equal(fixture.screenCalls(),1)
  assert.equal((await call(`${baseRevision}/confirmation`,binding)).status,409)
  const blocked=(await call('/api/requests',{...payload,attachment:{name:'guide.pdf',base64:Buffer.from('pdf').toString('base64')}},'test-only-alice','test-ui-unsupported-file')).body
  assert.equal(blocked.screeningStatus,'blocked')
})
