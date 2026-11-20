import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
test('the app serves its existing licensed typography without third-party network requests',async()=>{
 const html=await readFile(new URL('../dist/index.html',import.meta.url),'utf8');assert.doesNotMatch(html,/(?:href|src)=["']https?:\/\//i);assert.match(html,/href="\.\/fonts\.css"/);
 const css=await readFile(new URL('../dist/fonts.css',import.meta.url),'utf8');assert.match(css,/font-family:\s*['"]Barlow['"]/);assert.match(css,/font-family:\s*['"]Barlow Condensed['"]/);assert.equal((css.match(/font-display:\s*swap/g)||[]).length,3);
 const paths=[...css.matchAll(/url\(['"]?(\.\/[^)'"\s]+)/g)].map(x=>x[1]);assert.equal(paths.length,3);for(const path of paths){const bytes=await readFile(new URL('../dist/'+path.slice(2),import.meta.url));assert.equal(bytes.subarray(0,4).toString(),'wOF2');}
 assert.match(await readFile(new URL('../dist/fonts/OFL.txt',import.meta.url),'utf8'),/SIL OPEN FONT LICENSE/);
});
