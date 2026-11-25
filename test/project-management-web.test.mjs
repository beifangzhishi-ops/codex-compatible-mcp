import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectManagementServer } from '../src/controller/project-management-web.mjs';

test('project management page requires owner authentication and same-origin CSRF protected actions', async () => {
  const calls=[];
  let listCalls=0;
  const server=createProjectManagementServer({},{
    port:4193, publicOrigin:'https://owner.example.ts.net:4193',
    totp:{verify:code=>code==='123456'},
    list:async()=>{listCalls++;return {environments:[{id:'worker',state:'normal',projects:[{project_id:'demo',root:'C:\\demo'}]}]};},
    manage:async(_,action,args)=>{calls.push({action,args});return {workspace_handle:'00000000-0000-4000-8000-000000000001'};}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const host='127.0.0.1:4193', origin='http://'+host;
  const request=(method,headers,body)=>new Promise((resolve,reject)=>{
    const req=http.request(base,{method,headers},res=>{
      let text='';res.setEncoding('utf8');res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,headers:{get:n=>Array.isArray(res.headers[n])?res.headers[n][0]:res.headers[n]},text:async()=>text}));
    });req.on('error',reject);req.end(body);
  });
  const post=(fields,extra={})=>request('POST',{Host:host,Origin:origin,'Content-Type':'application/x-www-form-urlencoded',...extra},new URLSearchParams(fields).toString());
  const get=(extra={})=>request('GET',{Host:host,...extra});
  try{
    const landing=await get();
    assert.equal(landing.status,200);
    assert.match(await landing.text(),/所有者登录/);
    assert.equal(listCalls,0);
    assert.equal((await post({action:'handle',environment_id:'worker',workspace_id:'demo'})).status,403);
    assert.equal((await post({action:'login',code:'123456'},{Origin:'https://evil.example'})).status,403);
    assert.equal((await post({action:'login',code:'000000'})).status,403);
    const login=await post({action:'login',code:'123456'});
    assert.equal(login.status,303);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const dashboard=await (await get({Cookie:cookie})).text();
    assert.match(dashboard,/demo/);
    const csrf=dashboard.match(/name="csrf" value="([^"]+)"/)[1];
    assert.equal((await post({action:'handle',csrf:'wrong',environment_id:'worker',workspace_id:'demo'},{Cookie:cookie})).status,403);
    assert.equal((await post({action:'handle',csrf,environment_id:'worker',workspace_id:'demo'},{Cookie:cookie,Origin:'https://evil.example'})).status,403);
    assert.equal(calls.length,0);
    assert.equal((await post({action:'handle',csrf,environment_id:'worker',workspace_id:'demo'},{Cookie:cookie})).status,303);
    assert.equal(calls.length,1);
    assert.match(await (await get({Cookie:cookie})).text(),/00000000-0000-4000-8000-000000000001/);
    assert.equal((await post({action:'logout',csrf},{Cookie:cookie})).status,303);
    assert.match(await (await get({Cookie:cookie})).text(),/所有者登录/);
    const remote=await post({action:'login',code:'123456'},{Host:'owner.example.ts.net:4193',Origin:'https://owner.example.ts.net:4193'});
    assert.equal(remote.status,303);
    assert.match(remote.headers.get('set-cookie'),/; Secure/);
    assert.equal((await get({Host:'evil.example'})).status,404);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
