import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectManagementServer } from '../src/controller/project-management-web.mjs';
import { WebFullAccess } from '../src/controller/web-full-access.mjs';
import { GlobalRules } from '../src/controller/global-rules.mjs';

test('project management page opens without login, accepts tracking parameters and protects actions against CSRF', async () => {
  const calls=[];
  let listCalls=0;
  const grants=new WebFullAccess();
  const globalRules=new GlobalRules();
  const server=createProjectManagementServer({webFullAccess:grants,globalRules},{
    port:4193, publicOrigin:'https://owner.example.ts.net:4193',
    list:async()=>{listCalls++;return {environments:[{id:'worker',state:'normal',projects:[{project_id:'demo',root:'C:\\demo'},{project_id:'260923',root:'C:\\中期答辩260923'}]}]};},
    manage:async(_,action,args)=>{calls.push({action,args});return {workspace_handle:'00000000-0000-4000-8000-000000000001'};}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const host='127.0.0.1:4193', origin='http://'+host;
  const request=(method,headers,body,requestPath="/")=>new Promise((resolve,reject)=>{
    const req=http.request(base+requestPath,{method,headers},res=>{
      let text='';res.setEncoding('utf8');res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,headers:{get:n=>Array.isArray(res.headers[n])?res.headers[n][0]:res.headers[n]},text:async()=>text}));
    });req.on('error',reject);req.end(body);
  });
  const post=(fields,extra={})=>request('POST',{Host:host,Origin:origin,'Content-Type':'application/x-www-form-urlencoded',...extra},new URLSearchParams(fields).toString());
  const get=(extra={},requestPath='/')=>request('GET',{Host:host,...extra},undefined,requestPath);
  try{
    const landing=await get({},'/?utm_source=chatgpt.com');
    assert.equal(landing.status,200);
    // Native browser form POSTs must retain their same-origin Origin header.
    assert.equal(landing.headers.get('referrer-policy'),'same-origin');
    const dashboard=await landing.text();
    assert.match(dashboard,/demo/);
    assert.match(dashboard,/C:\\中期答辩260923/);
    assert.equal(landing.headers.get('content-type'),'text/html; charset=utf-8');
    assert.match(dashboard,/<article class="project"><div class="project-info"><strong>demo<\/strong><div class="muted project-path" tabindex="0">C:\\demo<\/div><\/div><div class="actions">/);
    assert.match(dashboard,/\.project-info\{flex:1;min-width:0\}/);
    assert.match(dashboard,/\.project-path\{[^}]*white-space:nowrap;overflow-x:auto/);
    assert.match(dashboard,/\.project \.actions\{flex:none;flex-wrap:nowrap/);
    assert.match(dashboard,/name="action" value="register"/);
    assert.doesNotMatch(dashboard,/name="action" value="(?:create|existing)"/);
    assert.doesNotMatch(dashboard,/<input name="workspace_id"/);
    assert.doesNotMatch(dashboard,/name="action" value="login"/);
    assert.equal(listCalls,1);
    const cookie=landing.headers.get('set-cookie').split(';')[0];
    assert.equal((await post({action:'handle',environment_id:'worker',workspace_id:'demo'})).status,403);
    const csrf=dashboard.match(/name="csrf" value="([^"]+)"/)[1];
    const revision=globalRules.read().revision;
    assert.match(dashboard,/name="rules"/);
    assert.match(dashboard,/historical compatibility/);
    const rulesForm={action:'rules_save',csrf,revision,rules:'中文 <script>alert(1)</script>'};
    assert.equal((await post({...rulesForm,csrf:'wrong'},{Cookie:cookie})).status,403);
    assert.equal((await post(rulesForm,{Cookie:cookie,Origin:'https://evil.example'})).status,403);
    assert.equal(globalRules.read().revision,revision);
    assert.equal((await post(rulesForm,{Cookie:cookie})).status,303);
    assert.equal(globalRules.read().text,rulesForm.rules);
    assert.match(await (await get({Cookie:cookie})).text(),/中文 &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.equal((await post({...rulesForm,rules:'stale'},{Cookie:cookie})).status,303);
    assert.equal(globalRules.read().text,rulesForm.rules);
    assert.equal((await post({action:'handle',csrf:'wrong',environment_id:'worker',workspace_id:'demo'},{Cookie:cookie})).status,403);
    assert.equal((await post({action:'handle',csrf,environment_id:'worker',workspace_id:'demo'},{Cookie:cookie,Origin:'https://evil.example'})).status,403);
    assert.equal((await post({action:'grant_issue',csrf,duration_seconds:'60'},{Cookie:cookie,Origin:'null'})).status,403);
    assert.equal(calls.length,0);
    assert.equal((await post({action:'grant_issue',csrf:'wrong',duration_seconds:'60'},{Cookie:cookie})).status,403);
    assert.equal((await post({action:'grant_issue',csrf,duration_seconds:'60'},{Cookie:cookie,Origin:'https://evil.example'})).status,403);
    assert.deepEqual(grants.list(),[]);
    assert.equal((await post({action:'grant_issue',csrf,duration_seconds:'60'},{Cookie:cookie})).status,303);
    const [grant]=grants.list();
    assert.equal(grants.authorize(grant.full_access_grant_id),true);
    assert.match(await (await get({Cookie:cookie})).text(),new RegExp(grant.full_access_grant_id));
    assert.match(await (await get({Cookie:cookie})).text(),new RegExp(grant.full_access_grant_id));
    assert.equal((await post({action:'grant_revoke',csrf,grant_id:grant.full_access_grant_id},{Cookie:cookie})).status,303);
    assert.throws(()=>grants.authorize(grant.full_access_grant_id),/unknown or expired/);
    assert.deepEqual(grants.list(),[]);
    assert.equal((await post({action:'handle',csrf,environment_id:'worker',workspace_id:'demo'},{Cookie:cookie})).status,303);
    assert.equal(calls.length,1);
    assert.match(await (await get({Cookie:cookie})).text(),/00000000-0000-4000-8000-000000000001/);
    const remoteHost='owner.example.ts.net:4193';
    const remote=await get({Host:remoteHost},'/?utm_source=chatgpt.com');
    assert.equal(remote.status,200);
    assert.match(remote.headers.get('set-cookie'),/; Secure/);
    const remoteCookie=remote.headers.get('set-cookie').split(';')[0];
    const remoteCsrf=(await remote.text()).match(/name="csrf" value="([^"]+)"/)[1];
    assert.equal((await post({action:'handle',csrf:remoteCsrf,environment_id:'worker',workspace_id:'demo'},{Host:remoteHost,Origin:'https://'+remoteHost,Cookie:remoteCookie})).status,303);
    assert.equal(calls.length,2);
    assert.equal((await get({},'/not-found')).status,404);
    assert.equal((await get({Host:'evil.example'})).status,404);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
