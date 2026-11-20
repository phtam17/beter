import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const externalUrl=process.env.E2E_BASE_URL;
const critical=/\/(?:server-flow|production-readiness)\.spec\.mjs$/;
export default defineConfig({
  testDir:'./e2e',fullyParallel:false,workers:1,timeout:30000,
  reporter:[['list'],['html',{open:'never',outputFolder:'artifacts/playwright-report'}]],
  use:{baseURL:externalUrl||'http://127.0.0.1:4173',headless:true,viewport:{width:1440,height:1000},screenshot:'only-on-failure',trace:'retain-on-failure'},
  projects:[
    {name:'chromium',use:{browserName:'chromium',launchOptions:existsSync(chrome)?{executablePath:chrome}:{}}},
    {name:'firefox',testMatch:critical,use:{browserName:'firefox'}},
    {name:'webkit',testMatch:critical,use:{browserName:'webkit'}},
  ],
  webServer:externalUrl?undefined:{command:'npm start',url:'http://127.0.0.1:4173',reuseExistingServer:false,timeout:60000,env:{NODE_ENV:'test',VERCEL:'0',PORT:'4173',BETER_DATA_MODE:'sample',BETER_DATA_DIR:join(tmpdir(),`beter-e2e-${process.pid}`),SUPABASE_URL:'',SUPABASE_ANON_KEY:'',SUPABASE_SERVICE_ROLE_KEY:'',ODDS_API_KEY:'',JOB_SECRET:'',BETER_SESSION_SECRET:''}},
  outputDir:'artifacts/test-results',
});
