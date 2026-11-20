import test from 'node:test';
import assert from 'node:assert/strict';
const {routeVercelUrl}=await import('../api/index.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return{};throw e;});
test('the hosted API rewrite restores nested account and worker endpoint paths',()=>{assert.equal(typeof routeVercelUrl,'function','Hosted static-site API routing must preserve nested endpoints.');assert.equal(routeVercelUrl('/api/index?route=auth%2Fsignin'),'/api/auth/signin');assert.equal(routeVercelUrl('/api/index?route=jobs/process&x=1'),'/api/jobs/process?x=1');});
test('hosted routing does not allow external or traversal destinations',()=>{assert.equal(typeof routeVercelUrl,'function');assert.equal(routeVercelUrl('/api/index?route=https://evil.example'),'/api/not-found');assert.equal(routeVercelUrl('/api/index?route=../portfolio'),'/api/not-found');assert.equal(routeVercelUrl('/api/config?route=jobs/process'),'/api/config?route=jobs/process');});
