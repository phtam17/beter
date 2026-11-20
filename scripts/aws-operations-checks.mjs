import {readFile,writeFile,mkdir,rename,chmod,access} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {createAwsControl} from './aws-deploy.mjs';
const defaultDir=resolve('.data/aws-deploy');
async function readJson(path){try{return JSON.parse(await readFile(path,'utf8'));}catch{throw Error('Complete private AWS deployment/rehearsal state is required.');}}
async function saveJson(directory,name,value){await mkdir(directory,{recursive:true,mode:0o700});await chmod(directory,0o700);const temporary=join(directory,randomUUID()+'.json');await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(temporary,join(directory,name));}
async function context({privateDir=defaultDir,control=createAwsControl({privateDir}),now=new Date(),funded=false}={}){
 const state=await readJson(join(privateDir,'state.json'));
 if(state.schemaVersion!==1||state.launchOpen!==false||!state.stackId||!/^\d{12}$/.test(state.accountId||'')||!/^[-a-z0-9]+$/.test(state.region||''))throw Error('A complete closed staging deployment is required.');
 if(funded&&!(Date.parse(state.cutoffAt+'Z')>now.getTime()+3600000))throw Error('Review funding and allow at least one hour before the cutoff for a disposable rehearsal.');
 const call=(service,operation,input={})=>control.call(service,operation,input,['--region',state.region]);
 if((await call('sts','get-caller-identity')).Account!==state.accountId)throw Error('The connected AWS account does not match the reviewed staging account.');
 const stack=(await call('cloudformation','describe-stacks',{StackName:state.stackId})).Stacks?.[0];
 const parameters=Object.fromEntries((stack?.Parameters||[]).map(p=>[p.ParameterKey,p.ParameterValue]));
 if(!['CREATE_COMPLETE','UPDATE_COMPLETE'].includes(stack?.StackStatus)||parameters.Environment!=='staging'||parameters.LaunchOpen!=='false')throw Error('Wait for a complete closed staging stack before operations checks.');
 if(funded&&(parameters.ScheduleState!=='DISABLED'||parameters.CreditCutoffAt!==state.cutoffAt))throw Error('Keep hosted staging schedules disabled with the reviewed funding cutoff for backup checks.');
 const outputs=Object.fromEntries((stack.Outputs||[]).map(p=>[p.OutputKey,p.OutputValue]));
 const match=/^arn:([^:]+):rds:([^:]+):(\d{12}):cluster:([a-z0-9-]+)$/.exec(outputs.DatabaseClusterArn||'');
 if(!match||match[2]!==state.region||match[3]!==state.accountId)throw Error('The hosted database must belong to the reviewed staging account and region.');
 return{privateDir,now,state,parameters,outputs,call,partition:match[1],sourceId:match[4]};
}
async function source(ctx){const db=(await ctx.call('rds','describe-db-clusters',{DBClusterIdentifier:ctx.outputs.DatabaseClusterArn})).DBClusters?.[0];if(db?.DBClusterArn!==ctx.outputs.DatabaseClusterArn||db?.DBClusterIdentifier!==ctx.sourceId||db.Engine!=='aurora-postgresql')throw Error('The hosted source database identity does not match the reviewed stack.');return db;}
async function isolation(ctx,db){
 const ids=(db.VpcSecurityGroups||[]).map(group=>group.VpcSecurityGroupId);if(!ids.length)return{ingress:false,routes:false};
 const groups=(await ctx.call('ec2','describe-security-groups',{GroupIds:ids})).SecurityGroups||[];
 const vpcs=new Set(groups.map(group=>group.VpcId));const ingress=groups.length===ids.length&&groups.every(group=>Array.isArray(group.IpPermissions)&&group.IpPermissions.length===0)&&vpcs.size===1;
 if(!ingress)return{ingress:false,routes:false};
 const routes=(await ctx.call('ec2','describe-route-tables',{Filters:[{Name:'vpc-id',Values:[groups[0].VpcId]}]})).RouteTables||[];
 return{ingress,routes:routes.length>0&&routes.every(table=>(table.Routes||[]).every(route=>!route.NatGatewayId&&!String(route.GatewayId||'').startsWith('igw-')))};
}
export async function checkHostedOperations(options={}){
 const ctx=await context(options),db=await source(ctx),network=await isolation(ctx,db);
 const writers=(await ctx.call('rds','describe-db-instances',{Filters:[{Name:'db-cluster-id',Values:[ctx.sourceId]}]})).DBInstances||[];
 const checks=[{id:'database-encrypted',ok:db.StorageEncrypted===true},{id:'database-backups',ok:db.BackupRetentionPeriod>=3},{id:'database-data-api',ok:db.HttpEndpointEnabled===true},{id:'database-auto-pause',ok:db.ServerlessV2ScalingConfiguration?.MinCapacity===0&&db.ServerlessV2ScalingConfiguration?.MaxCapacity<=2&&db.ServerlessV2ScalingConfiguration?.SecondsUntilAutoPause<=600},{id:'database-no-ingress',ok:network.ingress},{id:'database-private-routes',ok:network.routes},{id:'database-private-writers',ok:writers.length>0&&writers.every(writer=>writer.DBClusterIdentifier===ctx.sourceId&&writer.PubliclyAccessible===false)}];
 let confirmed=false,pending=0,next;do{const response=await ctx.call('sns','list-subscriptions-by-topic',{TopicArn:ctx.outputs.AlertTopicArn,...(next?{NextToken:next}:{})});for(const sub of response.Subscriptions||[]){if(sub.Protocol==='email'&&sub.Endpoint?.toLowerCase()===ctx.parameters.AlertEmail?.toLowerCase()){if(sub.SubscriptionArn?.startsWith('arn:'))confirmed=true;else pending++;}}next=response.NextToken;}while(next);
 checks.push({id:'alerts-confirmed',ok:confirmed,pending});
 for(const name of ['WorkerSuccess','ReadinessSuccess']){const start=new Date(ctx.now.getTime()-15*60000);const result=await ctx.call('cloudwatch','get-metric-statistics',{Namespace:'Beter',MetricName:name,Dimensions:[{Name:'Environment',Value:'staging'}],StartTime:start.toISOString(),EndTime:ctx.now.toISOString(),Period:60,Statistics:['Minimum']});const points=(result.Datapoints||[]).filter(point=>Date.parse(point.Timestamp)>=start.getTime()&&Date.parse(point.Timestamp)<=ctx.now.getTime());checks.push({id:name,ok:points.length>0&&points.every(point=>point.Minimum===1),samples:points.length});}
 const report={checkedAt:ctx.now.toISOString(),ok:checks.every(check=>check.ok),checks};await saveJson(ctx.privateDir,'operations-report.json',report);return report;
}
// Catalog-only schema hashes plus exact table counts; no user row contents leave the database.
export const restoreProofSql=`with tables as (
 select c.oid,n.nspname,c.relname,c.relrowsecurity,c.relowner,c.relacl from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('auth','public') and c.relkind='r'
), proof as (
 select t.nspname||'.'||t.relname as name,
 (xpath('//count/text()',query_to_xml(format('select count(*) as count from %I.%I',t.nspname,t.relname),true,false,'')))[1]::text as row_count,
 md5(jsonb_build_object('columns',(select jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid)) order by a.attnum) from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=t.oid and a.attnum>0 and not a.attisdropped),'constraints',(select jsonb_agg(pg_get_constraintdef(c.oid) order by c.conname) from pg_constraint c where c.conrelid=t.oid),'indexes',(select jsonb_agg(pg_get_indexdef(i.indexrelid) order by i.indexrelid::regclass::text) from pg_index i where i.indrelid=t.oid),'policies',(select jsonb_agg(jsonb_build_array(p.polname,p.polcmd,p.polroles::text,pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid)) order by p.polname) from pg_policy p where p.polrelid=t.oid),'rls',t.relrowsecurity,'owner',t.relowner::regrole::text,'acl',t.relacl::text)::text) as schema_hash from tables t
 union all select '__functions','0',md5(coalesce(string_agg(pg_get_functiondef(p.oid)||p.proowner::regrole::text||coalesce(p.proacl::text,''),E'\n' order by n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)),'')) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('auth','public') and p.prokind='f'
 union all select '__migrations',count(*)::text,md5(coalesce(string_agg(id||':'||checksum,E'\n' order by id),'')) from auth.beter_migrations
) select name,row_count,schema_hash from proof order by name`;
function normalizedProof(rows){
 const required=['auth.beter_migrations','auth.users','public.beter_bets','public.beter_ledger','public.beter_portfolios','__functions','__migrations'];
 if(!Array.isArray(rows)||rows.length>200||required.some(name=>!rows.some(row=>row.name===name))||new Set(rows.map(row=>row.name)).size!==rows.length||rows.some(row=>typeof row.name!=='string'||!/^\d+$/.test(row.row_count||'')||!/^[a-f0-9]{32}$/.test(row.schema_hash||''))||!rows.some(row=>row.name==='auth.beter_migrations'&&Number(row.row_count)>0))throw Error('The database restore proof is incomplete; apply and verify migrations first.');
 return rows.map(({name,row_count,schema_hash})=>({name,row_count,schema_hash})).sort((a,b)=>a.name.localeCompare(b.name));
}
async function proof(ctx,resourceArn,secretArn){let rows;try{const response=await ctx.call('rds-data','execute-statement',{resourceArn,secretArn,database:ctx.outputs.DatabaseName||'beter',sql:restoreProofSql,formatRecordsAs:'JSON'});rows=JSON.parse(response.formattedRecords);}catch{throw Error('Database restore proof query did not complete; inspect private service diagnostics.');}return normalizedProof(rows);}
function tags(record){return[{Key:'Application',Value:'Beter'},{Key:'Purpose',Value:'disposable-restore-rehearsal'},{Key:'BeterRehearsalId',Value:record.id},{Key:'BeterSourceClusterArn',Value:record.sourceArn},{Key:'BeterSnapshotId',Value:record.snapshotId},{Key:'BeterDeleteAfter',Value:record.deleteAfter}];}
async function record(ctx){const value=await readJson(join(ctx.privateDir,'backup-rehearsal.json'));if(value.sourceArn!==ctx.outputs.DatabaseClusterArn||value.sourceId!==ctx.sourceId||!/^beter-rehearsal-[a-z0-9-]+$/.test(value.restoreId||'')||value.restoreId===ctx.sourceId||value.writerId!==value.restoreId+'-writer'||value.snapshotId!==value.restoreId+'-snapshot'||!value.id||value.accountId!==ctx.state.accountId||value.region!==ctx.state.region)throw Error('Disposable rehearsal ownership does not match this source deployment.');return value;}
async function owned(ctx,arn,item){const actual=(await ctx.call('rds','list-tags-for-resource',{ResourceName:arn})).TagList||[];for(const expected of tags(item).slice(1,5))if(!actual.some(tag=>tag.Key===expected.Key&&tag.Value===expected.Value))throw Error('Disposable resource ownership tags do not match; no cleanup or restore was attempted.');}
async function snapshot(ctx,item){const response=await ctx.call('rds','describe-db-cluster-snapshots',{DBClusterSnapshotIdentifier:item.snapshotId});const value=response.DBClusterSnapshots?.[0];if(!value)return null;if(value.DBClusterIdentifier!==item.sourceId||value.DBClusterSnapshotIdentifier!==item.snapshotId||value.DBClusterSnapshotArn!==item.snapshotArn||value.StorageEncrypted!==true||value.SnapshotType!=='manual')throw Error('The rehearsal snapshot does not match the encrypted source identity.');await owned(ctx,value.DBClusterSnapshotArn,item);return value;}
async function restored(ctx,item){let response;try{response=await ctx.call('rds','describe-db-clusters',{DBClusterIdentifier:item.restoreId});}catch(error){if(error.code==='DBClusterNotFoundFault')return null;throw error;}const db=response.DBClusters?.[0];if(!db)return null;const expected=`arn:${ctx.partition}:rds:${ctx.state.region}:${ctx.state.accountId}:cluster:${item.restoreId}`;if(db.DBClusterArn!==expected||db.DBClusterArn===item.sourceArn||db.DBClusterIdentifier!==item.restoreId)throw Error('The disposable restored cluster does not match the recorded identity.');await owned(ctx,db.DBClusterArn,item);return db;}
async function writer(ctx,item){try{return(await ctx.call('rds','describe-db-instances',{DBInstanceIdentifier:item.writerId})).DBInstances?.[0]||null;}catch(error){if(error.code==='DBInstanceNotFound')return null;throw error;}}
const summary=(item,stage)=>({stage,rehearsalId:item.id,snapshotId:item.snapshotId,restoreId:item.restoreId});
export async function startBackupRehearsal(options={}){
 if(options.quiescent!==true)throw Error('Explicitly confirm a quiescent closed staging test window before taking a backup.');
 const ctx=await context({...options,funded:true});try{await access(join(ctx.privateDir,'backup-rehearsal.json'));throw Error('An earlier rehearsal has recovery state; resume or explicitly clean up its disposable resources.');}catch(error){if(error.code!=='ENOENT')throw error;}
 const db=await source(ctx),network=await isolation(ctx,db);if(db.Status!=='available'||db.StorageEncrypted!==true||!network.ingress||!network.routes||!db.DBSubnetGroup)throw Error('The source must be available, encrypted, and isolated before a snapshot rehearsal.');
 const baseline=await proof(ctx,db.DBClusterArn,ctx.outputs.DatabaseMasterSecretArn),id=randomUUID(),restoreId='beter-rehearsal-'+ctx.now.toISOString().replace(/\D/g,'').slice(0,14)+'-'+id.slice(0,6);
 const item={id,accountId:ctx.state.accountId,region:ctx.state.region,sourceArn:db.DBClusterArn,sourceId:db.DBClusterIdentifier,engineVersion:db.EngineVersion,subnetGroup:db.DBSubnetGroup,securityGroupIds:db.VpcSecurityGroups.map(group=>group.VpcSecurityGroupId),restoreId,writerId:restoreId+'-writer',snapshotId:restoreId+'-snapshot',snapshotArn:`arn:${ctx.partition}:rds:${ctx.state.region}:${ctx.state.accountId}:cluster-snapshot:${restoreId}-snapshot`,baseline,startedAt:ctx.now.toISOString(),deleteAfter:new Date(Math.min(ctx.now.getTime()+4*3600000,Date.parse(ctx.state.cutoffAt+'Z'))).toISOString()};
 await saveJson(ctx.privateDir,'backup-rehearsal.json',item);
 await ctx.call('rds','create-db-cluster-snapshot',{DBClusterIdentifier:item.sourceId,DBClusterSnapshotIdentifier:item.snapshotId,Tags:tags(item)});return summary(item,'SNAPSHOT_CREATING');
}
export async function advanceBackupRehearsal(options={}){
 const ctx=await context({...options,funded:true}),item=await record(ctx),snap=await snapshot(ctx,item);if(!snap||snap.Status!=='available')return summary(item,'SNAPSHOT_CREATING');
 let db=await restored(ctx,item);
 if(!db){await ctx.call('rds','restore-db-cluster-from-snapshot',{DBClusterIdentifier:item.restoreId,SnapshotIdentifier:item.snapshotArn,Engine:'aurora-postgresql',EngineVersion:item.engineVersion,EngineMode:'provisioned',DBSubnetGroupName:item.subnetGroup,VpcSecurityGroupIds:item.securityGroupIds,KmsKeyId:snap.KmsKeyId,DeletionProtection:false,BackupRetentionPeriod:1,CopyTagsToSnapshot:true,Tags:tags(item)});return summary(item,'CLUSTER_RESTORING');}
 if(db.Status!=='available')return summary(item,'CLUSTER_RESTORING');
 if(db.StorageEncrypted!==true||db.DBSubnetGroup!==item.subnetGroup||JSON.stringify((db.VpcSecurityGroups||[]).map(g=>g.VpcSecurityGroupId).sort())!==JSON.stringify([...item.securityGroupIds].sort()))throw Error('The restored cluster lost its private encrypted configuration.');
 if(db.ServerlessV2ScalingConfiguration?.MinCapacity!==0||db.ServerlessV2ScalingConfiguration?.MaxCapacity!==1||!db.MasterUserSecret?.SecretArn){await ctx.call('rds','modify-db-cluster',{DBClusterIdentifier:item.restoreId,ServerlessV2ScalingConfiguration:{MinCapacity:0,MaxCapacity:1,SecondsUntilAutoPause:600},ManageMasterUserPassword:true,ApplyImmediately:true});return summary(item,'CLUSTER_CONFIGURING');}
 const instance=await writer(ctx,item);if(!instance){await ctx.call('rds','create-db-instance',{DBInstanceIdentifier:item.writerId,DBClusterIdentifier:item.restoreId,DBInstanceClass:'db.serverless',Engine:'aurora-postgresql',PubliclyAccessible:false,AutoMinorVersionUpgrade:true,Tags:tags(item)});return summary(item,'WRITER_CREATING');}
 if(instance.DBClusterIdentifier!==item.restoreId||instance.PubliclyAccessible!==false)throw Error('The disposable writer must remain private in its restored cluster.');
 if(instance.DBInstanceStatus!=='available'||db.MasterUserSecret.SecretStatus!=='active')return summary(item,'WRITER_CREATING');
 if(db.HttpEndpointEnabled!==true){await ctx.call('rds','enable-http-endpoint',{ResourceArn:db.DBClusterArn});return summary(item,'DATA_API_ENABLING');}
 return summary(item,'READY_FOR_VERIFY');
}
export async function verifyBackupRehearsal(options={}){
 const ctx=await context({...options,funded:true}),item=await record(ctx),snap=await snapshot(ctx,item),db=await restored(ctx,item),instance=await writer(ctx,item);
 if(snap?.Status!=='available'||db?.Status!=='available'||db.StorageEncrypted!==true||db.HttpEndpointEnabled!==true||db.ServerlessV2ScalingConfiguration?.MinCapacity!==0||db.ServerlessV2ScalingConfiguration?.MaxCapacity!==1||db.DBSubnetGroup!==item.subnetGroup||!db.MasterUserSecret?.SecretArn||db.MasterUserSecret.SecretStatus!=='active'||instance?.DBClusterIdentifier!==item.restoreId||instance?.DBInstanceStatus!=='available'||instance.PubliclyAccessible!==false)throw Error('Wait for a private encrypted restored writer and Data API before verifying proof.');
 const network=await isolation(ctx,db);if(!network.ingress||!network.routes)throw Error('The restored database must remain private before querying restore proof.');
 const actual=await proof(ctx,db.DBClusterArn,db.MasterUserSecret.SecretArn),baseline=normalizedProof(item.baseline);if(JSON.stringify(actual)!==JSON.stringify(baseline))throw Error('The restored schema and row-count proof does not match the recorded source baseline.');
 item.verifiedAt=ctx.now.toISOString();item.proofHash=createHash('sha256').update(JSON.stringify(actual)).digest('hex');await saveJson(ctx.privateDir,'backup-rehearsal.json',item);
 return{...summary(item,'VERIFIED'),verified:true,tablesCompared:actual.filter(row=>!row.name.startsWith('__')).length,proofHash:item.proofHash,recoverySeconds:Math.max(0,Math.ceil((ctx.now.getTime()-Date.parse(item.startedAt))/1000))};
}
export async function cleanupBackupRehearsal(options={}){
 if(options.deleteDisposable!==true)throw Error('Explicitly request deletion of only tagged disposable rehearsal resources.');
 const ctx=await context(options),item=await record(ctx),snap=await snapshot(ctx,item),db=await restored(ctx,item),instance=await writer(ctx,item);
 if(instance){if(!snap||!db||instance.DBClusterIdentifier!==item.restoreId||instance.DBInstanceIdentifier!==item.writerId||!instance.DBInstanceArn)throw Error('Disposable writer ownership does not match; no deletion attempted.');await owned(ctx,instance.DBInstanceArn,item);if(instance.DBInstanceStatus!=='deleting')await ctx.call('rds','delete-db-instance',{DBInstanceIdentifier:item.writerId,SkipFinalSnapshot:true,DeleteAutomatedBackups:true});return summary(item,'WRITER_DELETING');}
 if(db){if(!snap)throw Error('A matching source snapshot is required before disposable cluster cleanup.');if(db.DeletionProtection===true)throw Error('Disposable cluster deletion protection changed; inspect its identity before cleanup.');if((db.DBClusterMembers||[]).length)return summary(item,'WRITER_DELETING');if(db.Status!=='deleting')await ctx.call('rds','delete-db-cluster',{DBClusterIdentifier:item.restoreId,SkipFinalSnapshot:true,DeleteAutomatedBackups:true});return summary(item,'CLUSTER_DELETING');}
 if(snap){if(snap.Status!=='deleting')await ctx.call('rds','delete-db-cluster-snapshot',{DBClusterSnapshotIdentifier:item.snapshotId});return summary(item,'SNAPSHOT_DELETING');}
 item.cleanedAt=ctx.now.toISOString();await saveJson(ctx.privateDir,'backup-rehearsal.json',item);return summary(item,'CLEANED');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{const [action,...flags]=process.argv.slice(2);if(flags.some(flag=>!['--quiescent','--delete-disposable'].includes(flag)))throw Error('Use only the documented rehearsal flags.');const options={quiescent:flags.includes('--quiescent'),deleteDisposable:flags.includes('--delete-disposable')};const run={check:checkHostedOperations,'backup-start':startBackupRehearsal,'backup-advance':advanceBackupRehearsal,'backup-verify':verifyBackupRehearsal,'backup-cleanup':cleanupBackupRehearsal}[action];if(!run)throw Error('Choose check, backup-start, backup-advance, backup-verify, or backup-cleanup.');console.log(JSON.stringify(await run(options)));}catch(error){console.error(JSON.stringify({ok:false,message:error instanceof Error?error.message:'AWS operations check failed.'}));process.exitCode=1;}
}
