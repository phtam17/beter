import test from 'node:test';
import assert from 'node:assert/strict';
import {createApiClient} from '../dist/api-client.js';

const pendingKey='beter-logout-pending-v1';
const user={id:'private-user',email:'private@example.test'};
const session={user,expires_at:Math.floor(Date.now()/1000)+3600};
const response=body=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
function storage(initial={}){const values=new Map(Object.entries(initial));return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};}
const offline=()=>{throw new Error('offline');};

test('failed logout persists a non-secret intent before losing the connection',async()=>{
  const saved=storage();
  const client=createApiClient({storage:saved,fetchImpl:async url=>url.endsWith('/auth/signin')?response({session}):offline()});
  await client.signin(user.email,'long-password');
  await assert.rejects(client.signout(),error=>error.code==='NETWORK_ERROR');
  assert.equal(saved.getItem(pendingKey),'1');
  assert.deepEqual(client.logoutState(),{pending:true,persistent:true});
  assert.equal(client.session(),null);
});

test('reload retries pending logout before it can restore a cookie account',async()=>{
  const saved=storage({[pendingKey]:'1'}),calls=[];
  const client=createApiClient({storage:saved,fetchImpl:async url=>{calls.push(url);return response(url.endsWith('/auth/signout')?{ok:true}:{session});}});
  assert.equal(await client.restoreSession(),null);
  assert.deepEqual(calls,['/api/auth/signout']);
  assert.equal(saved.getItem(pendingKey),null);
  assert.deepEqual(client.logoutState(),{pending:false,persistent:false});
});

test('a failed pending logout never asks to restore the cookie session',async()=>{
  const calls=[],saved=storage({[pendingKey]:'1'});
  const client=createApiClient({storage:saved,fetchImpl:async url=>{calls.push(url);return offline();}});
  await assert.rejects(client.restoreSession(),error=>error.code==='NETWORK_ERROR');
  assert.deepEqual(calls,['/api/auth/signout']);
  assert.equal(client.session(),null);
  assert.equal(saved.getItem(pendingKey),'1');
});

test('an existing tab refuses private reads when another tab has requested logout',async()=>{
  const saved=storage(),calls=[];
  const client=createApiClient({storage:saved,fetchImpl:async url=>{calls.push(url);return response({session});}});
  await client.signin(user.email,'long-password');
  saved.setItem(pendingKey,'1');
  assert.equal(client.session(),null);
  await assert.rejects(client.portfolio(),error=>error.code==='SIGNOUT_PENDING');
  assert.deepEqual(calls,['/api/auth/signin']);
});

test('new sign-in cannot bypass an unfinished logout',async()=>{
  const saved=storage({[pendingKey]:'1'}),calls=[];
  const client=createApiClient({storage:saved,fetchImpl:async url=>{calls.push(url);return offline();}});
  await assert.rejects(client.signin(user.email,'long-password'),error=>error.code==='NETWORK_ERROR');
  assert.deepEqual(calls,['/api/auth/signout']);
});

test('new sign-in waits for in-flight logout before it can set another cookie',async()=>{
  let release;const calls=[],saved=storage();
  const client=createApiClient({storage:saved,fetchImpl:async url=>{
    calls.push(url);
    if(url.endsWith('/auth/signout'))return new Promise(resolve=>release=()=>resolve(response({ok:true})));
    return response({session});
  }});
  await client.signin(user.email,'long-password');
  const signingOut=client.signout();
  const signingIn=client.signin(user.email,'long-password');
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,['/api/auth/signin','/api/auth/signout']);
  release();await signingOut;await signingIn;
  assert.equal(client.session().user.id,user.id);
  assert.equal(saved.getItem(pendingKey),null);
});

test('denied storage exposes an honest non-persistent pending state',async()=>{
  const denied={getItem(){throw Error('blocked');},setItem(){throw Error('blocked');},removeItem(){throw Error('blocked');}};
  const client=createApiClient({storage:denied,fetchImpl:async url=>url.endsWith('/auth/signin')?response({session}):offline()});
  await client.signin(user.email,'long-password');
  await assert.rejects(client.signout());
  assert.deepEqual(client.logoutState(),{pending:true,persistent:false});
  assert.equal(client.session(),null);
});

test('completed logout preserves unrelated personal practice and clears only its pending marker',async()=>{
  const saved=storage({'beter-practice-personal-v1':'personal-history',[pendingKey]:'1'});
  const client=createApiClient({storage:saved,fetchImpl:async()=>response({ok:true})});
  await client.signout();
  assert.equal(saved.getItem('beter-practice-personal-v1'),'personal-history');
  assert.equal(saved.getItem(pendingKey),null);
  assert.equal(client.session(),null);
});

test('another tab completing logout clears the shared pending notice without restoring identity',async()=>{
  const saved=storage({[pendingKey]:'1'});
  const client=createApiClient({storage:saved,fetchImpl:async()=>response({session})});
  assert.equal(client.logoutState().pending,true);
  saved.removeItem(pendingKey);
  assert.deepEqual(client.logoutState(),{pending:false,persistent:false});
  assert.equal(client.session(),null);
});
