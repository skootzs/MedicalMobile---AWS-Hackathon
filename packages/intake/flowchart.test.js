import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFlowchartGenerator } from './flowchart.js'

const config={region:'us-west-2',maxInputBytes:12000,timeoutMs:1000,guardrailIdentifier:'guard',guardrailVersion:'1'}

test('generates a chart with one guarded model call and strips a code fence',async t=>{
  const previous=process.env.FLOWCHART_MODEL_ID;process.env.FLOWCHART_MODEL_ID='test-profile'
  t.after(()=>{if(previous===undefined)delete process.env.FLOWCHART_MODEL_ID;else process.env.FLOWCHART_MODEL_ID=previous})
  const requests=[]
  const client={send:async (command,options)=>{
    requests.push({input:command.input,options})
    return {stopReason:'end_turn',output:{message:{content:[{text:'```mermaid\nflowchart TD\n A["Start"] --> B["Review"]\n```'}]}}}
  }}
  const result=await createFlowchartGenerator(config,client)({requirements:{goal:'Assess'},summary:'A request.'})
  assert.equal(result,'flowchart TD\n A["Start"] --> B["Review"]')
  assert.equal(requests.length,1)
  assert.equal(requests[0].input.modelId,'test-profile')
  assert.equal(requests[0].input.guardrailConfig.guardrailIdentifier,'guard')
  assert.equal(requests[0].input.inferenceConfig.maxTokens,2000)
  assert.ok(requests[0].options.abortSignal)
})

test('does not accept a guardrail intervention or empty response',async t=>{
  const previous=process.env.FLOWCHART_MODEL_ID;process.env.FLOWCHART_MODEL_ID='test-profile'
  t.after(()=>{if(previous===undefined)delete process.env.FLOWCHART_MODEL_ID;else process.env.FLOWCHART_MODEL_ID=previous})
  for(const response of [{stopReason:'guardrail_intervened'},{stopReason:'end_turn',output:{message:{content:[{text:''}]}}}]){
    const generator=createFlowchartGenerator(config,{send:async()=>response})
    await assert.rejects(generator({requirements:{},summary:'Example'}))
  }
})
