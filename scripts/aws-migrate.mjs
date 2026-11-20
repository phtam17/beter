import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {resolve,basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {splitSql} from '../server/sql.ts';
import {createDataApiDatabase,createPostgresDatabase} from '../server/aws-database.ts';
export {splitSql};

function migrationError(code,id){const error=new Error(code==='MIGRATION_DRIFT'?'Applied migration checksum differs from the reviewed source.':'Database migration failed; inspect the private deployment record.');error.code=code;if(id)error.migrationId=id;return error;}
export async function loadAwsMigrations({root=resolve(import.meta.dirname,'..')}={}){
  const files=[{id:'aws-000-bootstrap.sql',path:resolve(root,'aws/sql/bootstrap.sql')}];
  const directory=resolve(root,'supabase/migrations');for(const name of(await readdir(directory)).filter(name=>/^\d.*\.sql$/.test(name)).sort())files.push({id:basename(name),path:resolve(directory,name)});
  files.push({id:'aws-999-finalize.sql',path:resolve(root,'aws/sql/finalize.sql')});
  return Promise.all(files.map(async file=>({id:file.id,sql:await readFile(file.path,'utf8')})));
}
export async function applyAwsMigrations({database,migrations,dryRun=false,runtimePassword}={}){
  if(!database||!Array.isArray(migrations)||!migrations.length)throw new TypeError('The migration list is empty or invalid.');
  const seen=new Set();
  const prepared=migrations.map(file=>{
    if(!file||typeof file.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(file.id)||seen.has(file.id)||typeof file.sql!=='string')throw new TypeError('Invalid migration identifier or SQL source.');
    seen.add(file.id);const statements=splitSql(file.sql);if(statements.some(statement=>Buffer.byteLength(statement,'utf8')>65536))throw new TypeError('A migration statement exceeds the supported limit.');
    return{...file,statements,checksum:createHash('sha256').update(file.sql).digest('hex')};
  });
  const report={applied:[],alreadyApplied:[],pending:[],runtimeConfigured:false};
  try{
    if(dryRun){
      const exists=await database.query("select to_regclass('auth.beter_migrations') is not null as present");
      for(const file of prepared){const existing=exists.rows[0]?.present?await database.query('select checksum from auth.beter_migrations where id=:id',{id:file.id}):{rows:[]};if(existing.rows.length){if(existing.rows[0].checksum!==file.checksum)throw migrationError('MIGRATION_DRIFT',file.id);report.alreadyApplied.push(file.id);}else report.pending.push(file.id);}
      return report;
    }
    await database.query('create schema if not exists auth');
    await database.query('create table if not exists auth.beter_migrations(id text primary key,checksum text not null,applied_at timestamptz not null default clock_timestamp())');
    await database.query('revoke all on auth.beter_migrations from public');
    for(const file of prepared){
      try{
        const changed=await database.transaction(async query=>{
          await query.query("select pg_advisory_xact_lock(hashtextextended('beter-aws-migrations',0))");
          const existing=await query.query('select checksum from auth.beter_migrations where id=:id',{id:file.id});
          if(existing.rows.length){if(existing.rows[0].checksum!==file.checksum)throw migrationError('MIGRATION_DRIFT',file.id);return false;}
          for(const sql of file.statements)await query.query(sql);
          await query.query('insert into auth.beter_migrations(id,checksum) values(:id,:checksum)',{id:file.id,checksum:file.checksum});return true;
        });
        (changed?report.applied:report.alreadyApplied).push(file.id);
      }catch(error){if(error.code==='MIGRATION_DRIFT')throw error;throw migrationError('MIGRATION_FAILED',file.id);}
    }
    if(runtimePassword!==undefined){await database.transaction(query=>query.query('select auth.beter_runtime_configure(:password) as configured',{password:runtimePassword}));report.runtimeConfigured=true;}
    return report;
  }catch(error){if(['MIGRATION_DRIFT','MIGRATION_FAILED'].includes(error.code))throw error;throw migrationError('MIGRATION_FAILED');}
}
export async function runAwsMigrationCli(args,{env=process.env,writeOutput=text=>process.stdout.write(text+'\n'),database:injectedDatabase,loadMigrations=loadAwsMigrations,readRuntimePassword}={}){
  if(args.length!==1||!['--check','--apply'].includes(args[0])){writeOutput(JSON.stringify({ok:false,code:'INVALID_ARGUMENTS',message:'Choose --check or --apply. Configure private credentials through the environment.'}));return 2;}
  let database=injectedDatabase;
  try{
    if(!database)database=env.BETER_DATABASE_URL?createPostgresDatabase({connectionString:env.BETER_DATABASE_URL,allowLocalInsecure:env.BETER_DATABASE_ALLOW_LOCAL_INSECURE==='true'}):createDataApiDatabase({resourceArn:env.BETER_DATABASE_RESOURCE_ARN,secretArn:env.BETER_DATABASE_ADMIN_SECRET_ARN,database:env.BETER_DATABASE_NAME||'beter',region:env.AWS_REGION});
    let runtimePassword;
    if(args[0]==='--apply'&&readRuntimePassword)runtimePassword=await readRuntimePassword();
    const result=await applyAwsMigrations({database,migrations:await loadMigrations(),dryRun:args[0]==='--check',runtimePassword});writeOutput(JSON.stringify({ok:true,mode:args[0].slice(2),...result}));return 0;
  }catch(error){writeOutput(JSON.stringify({ok:false,code:['MIGRATION_DRIFT','MIGRATION_FAILED'].includes(error.code)?error.code:'MIGRATION_SETUP_REQUIRED',...(error.migrationId?{migrationId:error.migrationId}:{}),message:'Migration was not confirmed. Check the reviewed source, private setup, and deployment record.'}));return 1;}
  finally{if(!injectedDatabase)await database?.close?.();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await runAwsMigrationCli(process.argv.slice(2));
