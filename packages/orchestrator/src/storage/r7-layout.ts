import type { DynamoLayout } from './dynamodb.ts';
/** Read-only reference: r7-infra d766d02, infra/terraform/dynamodb.tf and docs/job-delivery.md.
 * R7 owns the table. R2 owns record suffixes (audit attempt suffix prevents collisions).
 * No provisioner, table name, AWS credentials or default storage selection here. */
export const r7Layout: DynamoLayout = {
  jobsByRequestIndex:{name:'GSI1',partitionAttribute:'gsi1pk',sortAttribute:'gsi1sk',partitionValue:id=>`REQ#${id}`,sortValue:createdAt=>`JOB#${createdAt}`},
  reviewerIndex:{name:'GSI2',partitionAttribute:'gsi2pk',sortAttribute:'gsi2sk',partitionValue:status=>{
    const roles:Record<string,string>={NEEDS_SD_REVIEW:'service_designer',WAITING_FOR_CLINICAL_APPROVAL:'clinician',WAITING_FOR_RELEASE_APPROVAL:'release_approver'};
    return roles[status]?`INBOX#${roles[status]}`:null;
  },sortValue:createdAt=>createdAt},
  revisionSortKey:revision=>`REV#${String(revision).padStart(6,'0')}`,
  receiptSortKey:eventId=>`RECEIPT#${eventId}`,
  evidenceSortKey:e=>`EVIDENCE#${e.kind}#${e.recordId}`,
  auditSortKey:a=>`AUDIT#${a.recordedAt}#${a.eventId}#${a.auditId}`,
};
