/** Executed in a NEW Node process by the real DynamoDB Local integration test. */
import { localClient,durableLocalStore } from './dynamodb-local-fixtures.ts';
import { durableApi,localHeaders } from './dynamodb-api-fixture.ts';
const [endpoint,table,directory,requestId]=process.argv.slice(2);
if(!table?.startsWith('r2-local-test-'))throw Error('Local test table required');
const c=localClient(endpoint), db=durableLocalStore(c.document,table,directory), h=durableApi(db);
try {
  const response=await h.api.inject({method:'GET',url:`/api/requests/${requestId}/review-context?category=CLINICAL`,headers:localHeaders('clinic')});
  const queue=await h.api.inject({method:'GET',url:'/api/reviews/queue?category=CLINICAL',headers:localHeaders('clinic')});
  console.log(JSON.stringify({code:response.statusCode,context:response.json(),queueCode:queue.statusCode,queue:queue.json(),audits:(await db.listAudit(requestId)).length,snapshots:(await db.listSnapshots(requestId)).length}));
} finally {await h.api.close();c.client.destroy();}
