import test from 'node:test';
import assert from 'node:assert/strict';
import {createApiClient} from '../dist/api-client.js';

const email='recovery@example.test',code='012345',password='a-new-recovery-password';
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});

test('email recovery confirmation sends code and password only in an anonymous POST body without storing them',async()=>{
  const writes=[],calls=[];
  const client=createApiClient({storage:{getItem:()=>null,removeItem(){},setItem:(...args)=>writes.push(args)},fetchImpl:async(url,init)=>{calls.push({url,init});return json({ok:true});}});
  assert.equal(typeof client.confirmRecovery,'function');
  assert.deepEqual(await client.confirmRecovery(email,code,password),{ok:true});
  assert.equal(calls[0].url,'/api/auth/confirm');assert.equal(calls[0].init.method,'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body),{email,code,password});
  assert.equal(calls[0].init.headers.get('authorization'),null);assert.equal(calls[0].init.credentials,'same-origin');
  assert.deepEqual(writes,[]);assert.equal(client.session(),null);
});

for(const action of ['recover','confirmRecovery']){
  test(`closing or switching account screens cancels ${action} and rejects even a late successful response`,async()=>{
    let release,signal;
    const client=createApiClient({storage:null,fetchImpl:async(url,init)=>{signal=init.signal;return new Promise(resolve=>{release=()=>resolve(json({requiresCode:true,ok:true}));});}});
    assert.equal(typeof client[action],'function');
    const pending=client[action](email,code,password).catch(error=>error);
    client.cancelAuthentication();assert.equal(signal.aborted,true);release();
    assert.equal((await pending).code,'REQUEST_ABORTED');assert.equal(client.session(),null);
  });
}

test('confirmation preserves safe invalid-code and incomplete-reset feedback without retrying or signing in',async()=>{
  for(const [status,code,message] of [[400,'INVALID_CODE','That recovery code is invalid or has expired. Request a new code.'],[503,'PASSWORD_RESET_INCOMPLETE','Your password may have changed. Try signing in with the new password, or request another recovery code.']]){
    let calls=0;
    const client=createApiClient({storage:null,fetchImpl:async()=>{calls++;return json({error:{code,message}},status);}});
    assert.equal(typeof client.confirmRecovery,'function');
    await assert.rejects(client.confirmRecovery(email,'012345',password),error=>error.status===status&&error.code===code&&error.message===message);
    assert.equal(calls,1);assert.equal(client.session(),null);
  }
});

test('starting another account operation cancels an earlier recovery confirmation',async()=>{
  let release,signal;
  const client=createApiClient({storage:null,fetchImpl:async(url,init)=>{
    if(url.endsWith('/auth/confirm')){signal=init.signal;return new Promise(resolve=>release=()=>resolve(json({ok:true})));}
    return json({session:{user:{id:'verified-user',email}}});
  }});
  assert.equal(typeof client.confirmRecovery,'function');
  const old=client.confirmRecovery(email,code,password).catch(error=>error);
  await client.signin(email,password);assert.equal(signal.aborted,true);release();
  assert.equal((await old).code,'REQUEST_ABORTED');assert.equal(client.session().user.id,'verified-user');
});
