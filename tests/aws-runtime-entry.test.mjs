import test from 'node:test';import assert from 'node:assert/strict';import {createRuntime} from '../server/runtime.ts';
test('the normal server entry routes AWS setup through its private-secret runtime',async()=>{
 await assert.rejects(()=>createRuntime({env:{BETER_BACKEND:'aws'}}),error=>error.code==='AWS_RUNTIME_UNAVAILABLE'&&error.status===503);
});
