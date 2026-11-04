/** Test-only LOCAL configuration and disk-backed immutable objects. Never AWS defaults. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { DynamoDBClient, CreateTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoOrchestratorStore } from '../../src/storage/dynamodb.ts';
import type { DynamoStoreOptions } from '../../src/storage/dynamodb.ts';
import type { DurableObjects, ImmutableObjectReference } from '../../src/storage/durable-objects.ts';
import { sha256 } from '../../src/storage/durable-objects.ts';
import { provisionalSnapshotValidator } from '../../src/snapshots.ts';
import { r7Layout } from '../../src/storage/r7-layout.ts';
import { resolveReviewActor } from './review-fixtures.ts';
export class LocalDiskObjects implements DurableObjects {
  #directory: string;
  constructor(directory: string) { this.#directory=resolve(directory); }
  #path(key: string) { const path=resolve(this.#directory,key);if(!path.startsWith(this.#directory+sep))throw Error('Invalid object key');return path; }
  async putIfAbsent(key:string,bytes:Uint8Array):Promise<ImmutableObjectReference> {
    const path=this.#path(key);await mkdir(resolve(path,'..'),{recursive:true});
    try { await writeFile(path,bytes,{flag:'wx'}); }
    catch(error) { if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;if(!Buffer.from(bytes).equals(await readFile(path)))throw Error('Immutable object conflict'); }
    const digest=sha256(bytes);return {uri:`s3://r2-local-fixtures/${key}`,versionId:digest,sha256:digest,size:bytes.length};
  }
  async read(ref:ImmutableObjectReference) { if(ref.versionId!==ref.sha256)throw Error('Invalid local object version');if(!ref.uri.startsWith('s3://r2-local-fixtures/'))throw Error('Wrong fixture bucket');return readFile(this.#path(ref.uri.slice('s3://r2-local-fixtures/'.length))); }
}
/** Use the published R7 index/key mapping without editing R7's infrastructure. */
export const localLayout=r7Layout;
export function localClient(endpoint:string) {
  const url=new URL(endpoint);if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.protocol!=='http:')throw Error('Integration tests require loopback DynamoDB Local');
  const client=new DynamoDBClient({endpoint,region:'local',credentials:{accessKeyId:'fictional',secretAccessKey:'fictional'},maxAttempts:1,requestHandler:{connectionTimeout:1500,requestTimeout:5000}});
  return {client,document:DynamoDBDocumentClient.from(client,{marshallOptions:{removeUndefinedValues:false}})};
}
export async function createLocalTable(client:DynamoDBClient,tableName:string) {
  if(!tableName.startsWith('r2-local-test-'))throw Error('Only unique test tables may be created');
  await client.send(new CreateTableCommand({TableName:tableName,KeySchema:[{AttributeName:'pk',KeyType:'HASH'},{AttributeName:'sk',KeyType:'RANGE'}],
    AttributeDefinitions:['pk','sk','gsi1pk','gsi1sk','gsi2pk','gsi2sk'].map(AttributeName=>({AttributeName,AttributeType:'S'})),BillingMode:'PAY_PER_REQUEST',
    StreamSpecification:{StreamEnabled:true,StreamViewType:'NEW_AND_OLD_IMAGES'},
    GlobalSecondaryIndexes:[{IndexName:'GSI1',KeySchema:[{AttributeName:'gsi1pk',KeyType:'HASH'},{AttributeName:'gsi1sk',KeyType:'RANGE'}],Projection:{ProjectionType:'ALL'}},
      {IndexName:'GSI2',KeySchema:[{AttributeName:'gsi2pk',KeyType:'HASH'},{AttributeName:'gsi2sk',KeyType:'RANGE'}],Projection:{ProjectionType:'ALL'}}]}));
}
export function durableLocalStore(document:DynamoDBDocumentClient,tableName:string,directory:string,options:Partial<DynamoStoreOptions>={}) {
  return new DynamoOrchestratorStore({client:document,tableName,objects:new LocalDiskObjects(directory),layout:localLayout,
    resolveActor:resolveReviewActor,validateSnapshot:provisionalSnapshotValidator,...options});
}
