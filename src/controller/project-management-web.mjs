import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { CcmTotpManager } from '../../ccm-sidecar/totp.mjs';
import { listManagedProjects, manageProject } from './project-management.mjs';

const token = () => randomBytes(32).toString('base64url');
const escape = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const cookieName = 'ccm_project_session';
const ttl = 12 * 60 * 60_000;
const script = "document.querySelectorAll('[data-copy]').forEach(b=>b.onclick=async()=>{try{await navigator.clipboard.writeText(b.dataset.copy);b.textContent='已复制'}catch{b.textContent='请手动复制'}});document.querySelectorAll('[data-remove]').forEach(f=>f.onsubmit=()=>confirm('确认注销该项目？文件不会删除，旧句柄将失效。'));";
const scriptHash = createHash('sha256').update(script).digest('base64');
const style = 'body{font:16px system-ui,sans-serif;background:#f5f6f8;color:#18212e;margin:0}main{max-width:760px;margin:auto;padding:20px 16px 48px}header{display:flex;justify-content:space-between;align-items:center;gap:12px}h1{font-size:26px;margin:12px 0}h2{font-size:19px;margin:0 0 14px}p{line-height:1.5;margin:8px 0}section,article{background:white;border:1px solid #dce1e8;border-radius:12px;padding:16px;margin:14px 0}article{padding:12px;background:#fafbfc}small,.muted{color:#536274;overflow-wrap:anywhere}label{display:block;margin:10px 0}input,select,button{font:inherit;border-radius:8px;border:1px solid #bac4d1;padding:10px;box-sizing:border-box}input,select{width:100%;background:white}button{background:#253f67;color:white;cursor:pointer;border:0}button.secondary{background:#e6eaf0;color:#18212e}button.danger{background:#fce9e7;color:#8d2424}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.actions form{margin:0}.notice{background:#e8f4eb;border-color:#a7cfb0}.error{background:#fff0ef;border-color:#e4ada7}code{display:block;overflow-wrap:anywhere;user-select:all;padding:10px;background:#f0f2f5;border-radius:6px}a{color:#274d87}';
const html = (body) => '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CCM 项目管理</title><style>'+style+'</style><main>'+body+'</main><script>'+script+'</script></html>';
function send(res, status, body, headers = {}) {
  res.writeHead(status, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-"+scriptHash+"'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",...headers});
  res.end(html(body));
}
function redirect(res, headers = {}) { res.writeHead(303, {Location:'/', 'Cache-Control':'no-store',...headers}); res.end(); }
function hidden(name,value) { return '<input type="hidden" name="'+escape(name)+'" value="'+escape(value)+'">'; }
function form(action, csrf, fields, label, extra='', buttonClass='') {
  return '<form method="post" action="/" '+extra+'>'+hidden('csrf',csrf)+hidden('action',action)+fields+'<button class="'+buttonClass+'">'+label+'</button></form>';
}
function loginPage(message='') {
  return '<header><h1>CCM 项目管理</h1></header><section><h2>所有者登录</h2><p class="muted">使用已绑定的 CCM 手机动态验证码。</p>'+(message?'<p class="error">'+escape(message)+'</p>':'')+
    '<form method="post" action="/">'+hidden('action','login')+'<label>动态验证码<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label><button>登录</button></form></section>';
}
function dashboard(data, session) {
  const flash = session.flash;
  session.flash = null;
  let body = '<header><h1>CCM 项目管理</h1>'+form('logout',session.csrf,'','退出','','secondary')+'</header><p class="muted">注册项目、复制句柄、注销项目。注销仅撤销注册和句柄，不删除文件。</p>';
  if(flash) {
    body += '<section class="'+(flash.error?'error':'notice')+'"><p>'+escape(flash.error || flash.message)+'</p>';
    if(flash.handle) body += '<code>'+escape(flash.handle)+'</code><div class="actions"><button data-copy="'+escape(flash.handle)+'">复制句柄</button></div>';
    body += '</section>';
  }
  for (const env of data.environments) {
    body += '<section><h2>'+escape(env.name || env.id)+'</h2><p class="muted">'+escape(env.id)+' · '+escape(env.state)+'</p>';
    if(env.state !== 'normal') { body += '<p>'+escape(env.abnormal_reason || env.project_discovery_error || '机器不可用')+'</p></section>'; continue; }
    for (const p of env.projects || []) {
      const fields=hidden('environment_id',env.id)+hidden('workspace_id',p.project_id);
      body += '<article><strong>'+escape(p.project_id)+'</strong><p class="muted">'+escape(p.root)+'</p><div class="actions">'+form('handle',session.csrf,fields,'获取句柄')+form('remove',session.csrf,fields,'注销','data-remove','danger')+'</div></article>';
    }
    const hints = env.project_directory_hints || [];
    if(hints.length) body += '<p class="muted">常用目录：'+hints.map(escape).join(' · ')+'</p>';
    body += '<form method="post" action="/">'+hidden('csrf',session.csrf)+hidden('environment_id',env.id)+
      '<label>项目绝对路径<input name="path" placeholder="输入完整目录路径" required></label><label>新项目 ID（可选）<input name="workspace_id" placeholder="默认使用目录名"></label><div class="actions"><button name="action" value="existing">注册已有目录</button><button name="action" value="create" class="secondary">新建空项目</button></div></form></section>';
  }
  return body + '<p><a href="/">刷新列表</a></p>';
}
async function readForm(req) {
  if (String(req.headers['content-type']||'').split(';')[0] !== 'application/x-www-form-urlencoded') throw Error('Unsupported request content type.');
  let data = '';
  for await (const chunk of req) { data += chunk; if (data.length > 16384) throw Error('Request too large.'); }
  return new URLSearchParams(data);
}
export function createProjectManagementServer(runtime, { publicOrigin, port=4193, totp, list=listManagedProjects, manage=manageProject } = {}) {
  const origins = new Set(['http://127.0.0.1:'+port, 'http://localhost:'+port, ...(publicOrigin ? [publicOrigin] : [])]);
  const hosts = new Set([...origins].map(origin=>new URL(origin).host));
  const manager = totp || new CcmTotpManager({stateFile:path.join(process.env.LOCALAPPDATA || os.homedir(),'CCM','secrets','totp-project-state.json')});
  const sessions = new Map();
  let actions = Promise.resolve();
  const sessionCookie = (value, secure, age) => cookieName+'='+value+'; Path=/; HttpOnly; SameSite=Strict; Max-Age='+age+(secure?'; Secure':'');
  const server = http.createServer(async (req,res) => {
    try {
      if (!hosts.has(req.headers.host) || req.url !== '/') { send(res,404,'Not found.'); return; }
      if (!['GET','POST'].includes(req.method)) { send(res,405,'Method not allowed.'); return; }
      const origin = req.headers.origin;
      if (req.method === 'POST' && (!origins.has(origin) || new URL(origin).host !== req.headers.host && !(origin===publicOrigin && req.headers['x-forwarded-proto']==='https'))) { send(res,403,'Forbidden.'); return; }
      const secure = origin===publicOrigin || req.headers['x-forwarded-proto']==='https' || (publicOrigin && req.headers.host===new URL(publicOrigin).host);
      const sid = String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1);
      for (const [id,s] of sessions) if (s.expires <= Date.now()) sessions.delete(id);
      const session = sessions.get(sid);
      if(req.method==='GET') {
        if(!session) { send(res,200,loginPage()); return; }
        send(res,200,dashboard(await list(runtime),session)); return;
      }
      const params=await readForm(req);
      const action=params.get('action');
      if(action==='login') {
        let ok=false;
        try { ok=manager.verify(params.get('code')); } catch {}
        if(!ok) { send(res,403,loginPage('验证失败，请确认验证码或稍后重试。')); return; }
        if(sid) sessions.delete(sid);
        const id=token(); sessions.set(id,{csrf:token(),expires:Date.now()+ttl});
        redirect(res,{'Set-Cookie':sessionCookie(id,secure,ttl/1000)}); return;
      }
      if(!session || params.get('csrf')!==session.csrf) { send(res,403,'请重新登录。'); return; }
      if(action==='logout') { sessions.delete(sid);redirect(res,{'Set-Cookie':sessionCookie('',secure,0)});return; }
      if(!['create','existing','handle','remove'].includes(action)) {send(res,400,'Invalid action.');return;}
      const args={environment_id:params.get('environment_id')||'',workspace_id:params.get('workspace_id')||undefined,path:params.get('path')||undefined};
      if(!args.environment_id || (['create','existing'].includes(action)?!args.path:!args.workspace_id)){send(res,400,'缺少项目参数。');return;}
      const perform=async()=>{
        try {
          const result=await manage(runtime,action,args);
          session.flash=result.workspace_handle ? {message:'项目句柄已就绪',handle:result.workspace_handle} : {message:'项目已注销，文件已保留。'};
        } catch(error) { session.flash={error:String(error?.message||error)}; }
      };
      actions=actions.then(perform,perform);
      await actions;
      redirect(res);
    } catch { if(!res.headersSent)send(res,500,'管理页请求失败。');else res.destroy(); }
  });
  return server;
}
