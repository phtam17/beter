// Opt-in local SCRAM protocol verification; refuses remote or occupied databases.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Client} from 'pg';
const implementation=await import('../scripts/aws-migrate.mjs');
const value=process.env.TEST_AWS_SCRAM_URL;if(!value)throw Error('Use a fresh local PostgreSQL database ending in _test with TEST_AWS_SCRAM_URL.');
const url=new URL(value),database=decodeURIComponent(url.pathname.slice(1)),host=url.searchParams.get('host')||url.hostname;
if(!['postgres:','postgresql:'].includes(url.protocol)||!database.endsWith('_test')||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!(host.startsWith('/')||['127.0.0.1','localhost','::1'].includes(host)))throw Error('SCRAM verification refuses a remote or non-test database.');
test('client-derived SCRAM verifier authenticates a real PostgreSQL login while wrong passwords fail',async()=>{
  assert.equal(typeof implementation.createScramVerifier,'function');const admin=new Client({connectionString:value});await admin.connect();
  const password='protocol-fixture-password-1234567890';
  try{
    assert.equal((await admin.query("select exists(select 1 from pg_tables where schemaname in ('auth','public')) as occupied")).rows[0].occupied,false,'Refusing an occupied database.');
    await admin.query(await readFile(new URL('../aws/sql/bootstrap.sql',import.meta.url),'utf8'));
    const verifier=implementation.createScramVerifier(password);await admin.query('select auth.beter_runtime_configure($1)',[verifier]);assert.equal((await admin.query("select rolpassword from pg_authid where rolname='beter_runtime'")).rows[0].rolpassword,verifier);
    for(const accepted of [true,false]){
      const client=new Client({host:url.hostname,port:Number(url.port||5432),database,user:'beter_runtime',password:accepted?password:'deliberately-wrong-protocol-fixture',connectionTimeoutMillis:5000,ssl:false});
      try{if(accepted){await client.connect();assert.equal((await client.query('select current_user as name')).rows[0].name,'beter_runtime');}else await assert.rejects(()=>client.connect(),error=>error.code==='28P01');}finally{await client.end();}
    }
  }finally{await admin.end();}
});
