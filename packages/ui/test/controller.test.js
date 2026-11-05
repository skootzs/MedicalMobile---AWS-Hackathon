import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browser } from './browser-fixture.js'

const id='11111111-1111-4111-8111-111111111111',rid='22222222-2222-4222-8222-222222222222'
const revision={requestId:id,revisionId:rid,normalizedRequirements:{goal:'Saved goal',pathway:'Follow-up',targetUsers:'CHWs',acceptanceCriteria:'Show a task'},baselineVersion:'v1',screeningStatus:'pending_screening',sources:[],references:[],corrections:[],events:[{at:'2026-11-04T12:00:00Z',status:'received'}]}
function bridge() {
  const calls=[]
  const workspace={connect(value){this.actions=value},authenticated(profile){calls.push(['profile',profile])},start(path){calls.push(['start',path])},requestNavigation(path){calls.push(['navigate',path])},signedOut(){calls.push(['signedOut'])},message(){},renderTracking(){return false},loadListReviews(){},requestOpened(id){calls.push(['opened',id])}}
  return {workspace,calls}
}
test('UI bridge uses verified identity, fresh form context and attachment focus without posting',async()=>{
  const {workspace,calls}=bridge()
  const page=await browser('/','?code=code&state=state',{workspace})
  assert.equal(calls.find(c=>c[0]==='profile')[1].authorId,'alice')
  assert.equal(calls.find(c=>c[0]==='start')[1],'/')
  const before=page.requests.length
  workspace.actions.newRequest(true)
  assert.equal(page.location.pathname,'/requests/new')
  assert.equal(page.byId('attachment').focused,true)
  assert.equal(page.byId('form-title').textContent,'New request')
  assert.equal(page.requests.length,before)
})
test('uncertain submission retries retain exact bytes and key, while start fresh allocates another key',async()=>{
  let posts=0
  const page=await browser('/','?code=code&state=state',{'/api/requests':options=>options.method==='POST'?(posts++,{httpStatus:503,body:'Temporarily unavailable'}):[]})
  for(const [key,value] of Object.entries({...revision.normalizedRequirements,baselineVersion:'v1',guidelineUrls:''}))page.byId('request').elements[key].value=value
  const event={preventDefault(){},submitter:{}}
  await page.byId('request').handlers.submit(event)
  await page.byId('request').handlers.submit(event)
  const attempts=page.requests.filter(r=>r.options.method==='POST'&&r.path==='/api/requests')
  assert.equal(posts,2)
  assert.equal(attempts[0].options.body,attempts[1].options.body)
  assert.equal(attempts[0].options.headers['Idempotency-Key'],attempts[1].options.headers['Idempotency-Key'])
  page.byId('new-request').onclick()
  await page.byId('request').handlers.submit(event)
  const last=page.requests.at(-1)
  assert.notEqual(last.options.headers['Idempotency-Key'],attempts[0].options.headers['Idempotency-Key'])
})
test('expired session clears request data and notifies the shell',async()=>{
  const {workspace,calls}=bridge()
  const page=await browser('/','?code=code&state=state',{workspace,'/api/requests':()=>({httpStatus:401,body:'Session expired'})})
  assert.ok(calls.some(c=>c[0]==='signedOut'))
  assert.equal(page.byId('intake').hidden,true)
  assert.equal(page.byId('welcome').hidden,false)
  assert.deepEqual(page.byId('details').children,[])
  assert.equal(page.byId('message').textContent,'Session expired')
})
test('opening and refreshing a request only reads review state, including clarification and disabled screening',async()=>{
  for(const state of [{enabled:false,status:'pending_screening'},{enabled:true,status:'screening',leaseExpired:true},{enabled:true,status:'needs_clarification',result:{summary:'Clarify',issues:[{field:'pathway',question:'Which pathway?'}],evidence:[]}}]){
    const {workspace}=bridge()
    const page=await browser('/','?code=code&state=state',{workspace,[`/api/requests/${id}`]:[revision],[`/api/requests/${id}/revisions/${rid}/screening`]:state})
    await workspace.actions.navigate(`/requests/${id}`)
    // Navigation's event-style bridge returns immediately; settle the pending reads.
    await new Promise(resolve=>setImmediate(resolve))
    assert.ok(page.requests.some(r=>r.path.endsWith('/screening')))
    assert.equal(page.byId('message').textContent,'')
    assert.equal(page.requests.filter(r=>r.path.endsWith('/screening')&&r.options.method==='POST').length,0)
  }
})
test('a stale confirmation refreshes history and review state without repeating the mutation',async()=>{
  const {workspace}=bridge()
  const state={enabled:true,status:'screening_passed',attemptId:'attempt',preview:{id:'preview',hash:'hash',content:{requirements:revision.normalizedRequirements,baselineVersion:'v1',sources:[]}}}
  const page=await browser('/','?code=code&state=state',{workspace,[`/api/requests/${id}`]:[revision],[`/api/requests/${id}/revisions/${rid}/screening`]:state,[`/api/requests/${id}/revisions/${rid}/confirmation`]:{httpStatus:409,body:'Stale preview'}})
  workspace.actions.navigate(`/requests/${id}`)
  await new Promise(resolve=>setImmediate(resolve))
  const descendants=node=>[node,...(node.children||[]).flatMap(descendants)]
  const button=descendants(page.byId('details')).find(node=>node.textContent==='Confirm this exact revision')
  assert.ok(button, page.byId('message').textContent)
  await button.onclick()
  assert.equal(page.requests.filter(r=>r.path.endsWith('/confirmation')).length,1)
  assert.equal(page.requests.filter(r=>r.path===`/api/requests/${id}`).length,2)
  assert.match(page.byId('message').textContent,/Request and review state refreshed/)
})
test('screening shows a busy button until the backend responds and restores it on failure',async()=>{
  const {workspace}=bridge(),busy=[]
  workspace.screeningBusy=(revisionId,value)=>busy.push([revisionId,value])
  let finish
  const pending=new Promise(resolve=>{finish=resolve})
  const page=await browser('/','?code=code&state=state',{workspace,[`/api/requests/${id}`]:[revision],[`/api/requests/${id}/revisions/${rid}/screening`]:options=>options.method==='POST'?pending:{enabled:true,status:'pending_screening'}})
  await workspace.actions.navigate(`/requests/${id}`)
  const descendants=node=>[node,...(node.children||[]).flatMap(descendants)]
  const button=descendants(page.byId('details')).find(node=>node.textContent==='Screen this revision')
  const operation=button.onclick()
  assert.equal(button.disabled,true)
  assert.equal(button.textContent,'Screening…')
  assert.equal(button['aria-busy'],'true')
  assert.equal(button['data-screening-busy'],'true')
  finish({httpStatus:503,body:'Screening temporarily unavailable'})
  await operation
  assert.equal(button.disabled,false)
  assert.equal(button.textContent,'Screen this revision')
  assert.equal(button['aria-busy'],'false')
  assert.deepEqual(busy,[[rid,true],[rid,false]])
})
test('creating a preview opens its revision and brings the returned summary into view',async()=>{
  const {workspace}=bridge()
  const base=`/api/requests/${id}/revisions/${rid}`
  const passed={enabled:true,status:'screening_passed',attemptId:'attempt',result:{summary:'Complete.',issues:[],evidence:[]}}
  const preview={id:'preview',hash:'exact-server-hash',content:{requirements:revision.normalizedRequirements,baselineVersion:'v1',summary:'The saved request is ready for review.',sources:[]}}
  const page=await browser('/','?code=code&state=state',{workspace,[`/api/requests/${id}`]:[revision],[`${base}/screening`]:passed,[`${base}/preview`]:{...passed,preview}})
  await workspace.actions.navigate(`/requests/${id}`)
  const descendants=node=>[node,...(node.children||[]).flatMap(descendants)]
  const create=descendants(page.byId('details')).find(node=>node.textContent==='Create preview')
  const entry=page.byId('details').children.find(node=>node.className==='revision-entry')
  entry.open=false
  await create.onclick()
  const shown=descendants(page.byId('details')).find(node=>node.className==='request-preview')
  assert.ok(shown)
  assert.equal(entry.open,true)
  assert.equal(shown.scrolled,true)
  assert.equal(shown.focused,true)
  assert.ok(descendants(shown).some(node=>node.textContent==='Saved goal'))
  assert.ok(descendants(shown).some(node=>node.textContent===preview.content.summary))
  assert.ok(descendants(shown).some(node=>node.textContent==='Confirm this exact revision'))
  assert.equal(page.requests.filter(r=>r.path.endsWith('/preview')).length,1)
  assert.equal(page.requests.filter(r=>r.path.endsWith('/confirmation')).length,0)
})
test('passing screening creates the preview once and failures leave a manual retry',async()=>{
  const {workspace}=bridge()
  const base=`/api/requests/${id}/revisions/${rid}`
  const passed={enabled:true,status:'screening_passed',attemptId:'attempt',result:{summary:'Complete.',issues:[],evidence:[]}}
  const page=await browser('/','?code=code&state=state',{workspace,[`/api/requests/${id}`]:[revision],
    [`${base}/screening`]:options=>options.method==='POST'?passed:{enabled:true,status:'pending_screening'},
    [`${base}/preview`]:{httpStatus:503,body:'Could not generate the flowchart.'}})
  await workspace.actions.navigate(`/requests/${id}`)
  const descendants=node=>[node,...(node.children||[]).flatMap(descendants)]
  await descendants(page.byId('details')).find(node=>node.textContent==='Screen this revision').onclick()
  assert.equal(page.requests.filter(r=>r.path.endsWith('/preview')).length,1)
  assert.ok(descendants(page.byId('details')).some(node=>node.textContent==='Create preview'))
})

test('demo preview shows the sample flowchart and keeps request details and confirmation',async()=>{
  const {workspace}=bridge()
  const base=`/api/requests/${id}/revisions/${rid}`
  const preview={id:'preview',hash:'hash',content:{requirements:revision.normalizedRequirements,baselineVersion:'v1',summary:'Ready',sources:[],flowchartMermaid:'flowchart TD\n A-->B'}}
  const page=await browser('/','?code=code&state=state',{workspace,[`/api/requests/${id}`]:[revision],
    [`${base}/screening`]:{enabled:true,status:'screening_passed',attemptId:'attempt',preview,demoExample:{pathwayId:'child_cough'}}})
  await workspace.actions.navigate(`/requests/${id}`)
  const descendants=node=>[node,...(node.children||[]).flatMap(descendants)]
  const all=descendants(page.byId('details'))
  assert.ok(all.some(node=>node.textContent==='Draft workflow preview — clinical review required'))
  assert.ok(all.some(node=>node.textContent?.includes('not generated from your request or guideline')))
  assert.ok(all.some(node=>node.className==='flowchart-preview'))
  assert.ok(!all.some(node=>node.textContent==='Explore an example decision map'))
  assert.ok(all.some(node=>node.textContent==='Your request details'))
  assert.ok(all.some(node=>node.textContent==='Saved goal'))
  assert.ok(all.some(node=>node.textContent==='Confirm this exact revision'))
})
