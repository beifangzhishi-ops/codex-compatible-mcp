import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { listManagedProjects, manageProject } from './project-management.mjs';
import { FULL_ACCESS_DURATIONS } from './web-full-access.mjs';

const token = () => randomBytes(32).toString('base64url');
const escape = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const cookieName = 'ccm_project_session';
const ttl = 12 * 60 * 60_000;
const script = "document.querySelectorAll('[data-copy]').forEach(b=>b.onclick=async()=>{try{await navigator.clipboard.writeText(b.dataset.copy);b.textContent='已复制'}catch{b.textContent='请手动复制'}});document.querySelectorAll('[data-remove]').forEach(f=>f.onsubmit=()=>confirm('确认注销该项目？文件不会删除，旧句柄将失效。'));";
const scriptHash = createHash('sha256').update(script).digest('base64');
const style = 'body{font:16px system-ui,sans-serif;background:#f5f6f8;color:#18212e;margin:0}main{max-width:760px;margin:auto;padding:20px 16px 48px}header{display:flex;justify-content:space-between;align-items:center;gap:12px}h1{font-size:26px;margin:12px 0}h2{font-size:19px;margin:0 0 14px}p{line-height:1.5;margin:8px 0}section,article{background:white;border:1px solid #dce1e8;border-radius:12px;padding:16px;margin:14px 0}article{padding:12px;background:#fafbfc}small,.muted{color:#536274;overflow-wrap:anywhere}label{display:block;margin:10px 0}input,select,button{font:inherit;border-radius:8px;border:1px solid #bac4d1;padding:10px;box-sizing:border-box}input,select{width:100%;background:white}button{background:#253f67;color:white;cursor:pointer;border:0}button.secondary{background:#e6eaf0;color:#18212e}button.danger{background:#fce9e7;color:#8d2424}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.actions form{margin:0}.notice{background:#e8f4eb;border-color:#a7cfb0}.error{background:#fff0ef;border-color:#e4ada7}code{display:block;overflow-wrap:anywhere;user-select:all;padding:10px;background:#f0f2f5;border-radius:6px}a{color:#274d87}';
const projectStyle = '.project{display:flex;align-items:center;gap:10px;padding:8px 10px;margin:8px 0}.project-info{flex:1;min-width:0}.project-info strong{display:block;overflow-wrap:anywhere}.project-path{display:block;white-space:nowrap;overflow-x:auto;overflow-y:hidden;overflow-wrap:normal;margin:3px 0 0;font-size:14px;line-height:1.4}.project .actions{flex:none;flex-wrap:nowrap;gap:6px;margin:0}.project .actions button{white-space:nowrap;padding:8px;font-size:14px}';
const html = (body) => '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CCM 管理</title><style>'+style+projectStyle+'</style><main>'+body+'</main><script>'+script+'</script></html>';
function send(res, status, body, headers = {}) {
  res.writeHead(status, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'same-origin','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-"+scriptHash+"'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",...headers});
  res.end(html(body));
}
function redirect(res, headers = {}) { res.writeHead(303, {Location:'/', 'Cache-Control':'no-store',...headers}); res.end(); }
function hidden(name,value) { return '<input type="hidden" name="'+escape(name)+'" value="'+escape(value)+'">'; }
function form(action, csrf, fields, label, extra='', buttonClass='') {
  return '<form method="post" action="/" '+extra+'>'+hidden('csrf',csrf)+hidden('action',action)+fields+'<button class="'+buttonClass+'">'+label+'</button></form>';
}
function fullAccessSection(grants, csrf) {
  const labels = ['1 分钟','5 分钟','30 分钟','1 小时','6 小时','1 天','7 天'];
  const options = FULL_ACCESS_DURATIONS.map((seconds,i) => '<option value="'+seconds+'"'+(seconds===21600?' selected':'')+'>'+labels[i]+'</option>').join('');
  let body = '<section><h2>全权限</h2><p class="muted">适用所有 Worker，不包含 Windows 管理员权限。</p>'+
    form('grant_issue',csrf,'<label>授权时长<select name="duration_seconds">'+options+'</select></label>','签发全权限');
  for (const grant of grants) {
    const id = grant.full_access_grant_id;
    const expiry = new Date(grant.expires_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
    body += '<article><p class="muted">有效期至 '+escape(expiry)+' (UTC+8)</p><code>'+escape(id)+'</code><div class="actions"><button type="button" data-copy="'+escape('full_access_grant_id: '+id)+'">复制全权限句柄</button>'+
      form('grant_revoke',csrf,hidden('grant_id',id),'撤销','','danger')+'</div></article>';
  }
  if (!grants.length) body += '<p class="muted">暂无有效授权</p>';
  return body+'</section>';
}
function dashboard(data, session, grants) {
  const flash = session.flash;
  session.flash = null;
  let body = '<header><h1>CCM 管理</h1>'+'</header><p class="muted">注册项目、复制句柄、注销项目。注销仅撤销注册和句柄，不删除文件。</p>';
  if(flash) {
    body += '<section class="'+(flash.error?'error':'notice')+'"><p>'+escape(flash.error || flash.message)+'</p>';
    if(flash.handle) body += '<code>'+escape(flash.handle)+'</code><div class="actions"><button data-copy="'+escape(flash.handle)+'">复制句柄</button></div>';
    body += '</section>';
  }
  body += fullAccessSection(grants, session.csrf);
  for (const env of data.environments) {
    body += '<section><h2>'+escape(env.name || env.id)+'</h2><p class="muted">'+escape(env.id)+' · '+escape(env.state)+'</p>';
    if(env.state !== 'normal') { body += '<p>'+escape(env.abnormal_reason || env.project_discovery_error || '机器不可用')+'</p></section>'; continue; }
    for (const p of env.projects || []) {
      const fields=hidden('environment_id',env.id)+hidden('workspace_id',p.project_id);
      body += '<article class="project"><div class="project-info"><strong>'+escape(p.project_id)+'</strong><div class="muted project-path" tabindex="0">'+escape(p.root)+'</div></div><div class="actions">'+form('handle',session.csrf,fields,'获取句柄')+form('remove',session.csrf,fields,'注销','data-remove','danger')+'</div></article>';
    }
    const hints = env.project_directory_hints || [];
    if(hints.length) body += '<p class="muted">常用目录：'+hints.map(escape).join(' · ')+'</p>';
    body += '<form method="post" action="/">'+hidden('csrf',session.csrf)+hidden('environment_id',env.id)+
      '<label>项目绝对路径<input name="path" placeholder="输入完整目录路径" required></label><label>新建目录的项目 ID（可选）<input name="workspace_id" placeholder="默认使用目录名"></label><div class="actions"><button name="action" value="register">注册项目</button></div><small>目录不存在时自动创建。</small></form></section>';
  }
  return body + '<p><a href="/">刷新列表</a></p>';
}
async function readForm(req) {
  if (String(req.headers['content-type']||'').split(';')[0] !== 'application/x-www-form-urlencoded') throw Error('Unsupported request content type.');
  let data = '';
  for await (const chunk of req) { data += chunk; if (data.length > 16384) throw Error('Request too large.'); }
  return new URLSearchParams(data);
}
export function createProjectManagementServer(runtime, { publicOrigin, port=4193, list=listManagedProjects, manage=manageProject } = {}) {
  const origins = new Set(['http://127.0.0.1:'+port, 'http://localhost:'+port, ...(publicOrigin ? [publicOrigin] : [])]);
  const hosts = new Set([...origins].map(origin=>new URL(origin).host));
  const sessions = new Map();
  let actions = Promise.resolve();
  const sessionCookie = (value, secure, age) => cookieName+'='+value+'; Path=/; HttpOnly; SameSite=Strict; Max-Age='+age+(secure?'; Secure':'');
  const server = http.createServer(async (req,res) => {
    try {
      if (!hosts.has(req.headers.host) || new URL(req.url, 'http://127.0.0.1').pathname !== '/') { send(res,404,'Not found.'); return; }
      if (!['GET','POST'].includes(req.method)) { send(res,405,'Method not allowed.'); return; }
      const origin = req.headers.origin;
      if (req.method === 'POST' && (!origins.has(origin) || new URL(origin).host !== req.headers.host && !(origin===publicOrigin && req.headers['x-forwarded-proto']==='https'))) { send(res,403,'Forbidden.'); return; }
      const secure = origin===publicOrigin || req.headers['x-forwarded-proto']==='https' || (publicOrigin && req.headers.host===new URL(publicOrigin).host);
      const sid = String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1);
      for (const [id,s] of sessions) if (s.expires <= Date.now()) sessions.delete(id);
      let session = sessions.get(sid);
      if(req.method==='GET') {
        let headers = {};
        if(!session) {
          const id=token();
          session={csrf:token(),expires:Date.now()+ttl};
          sessions.set(id,session);
          headers={'Set-Cookie':sessionCookie(id,secure,ttl/1000)};
        }
        send(res,200,dashboard(await list(runtime),session,runtime.webFullAccess.list()),headers); return;
      }
      const params=await readForm(req);
      const action=params.get('action');
      if(!session || params.get('csrf')!==session.csrf) { send(res,403,'请刷新页面后重试。'); return; }
      if (action === 'grant_issue' || action === 'grant_revoke') {
        try {
          if (action === 'grant_issue') {
            runtime.webFullAccess.issue(Number(params.get('duration_seconds')));
            session.flash = {message:'全权限已签发，请复制句柄给模型。'};
          } else {
            runtime.webFullAccess.revoke(params.get('grant_id'));
            session.flash = {message:'全权限已撤销。'};
          }
        } catch(error) { session.flash={error:String(error?.message||error)}; }
        redirect(res); return;
      }
      if(!['register','handle','remove'].includes(action)) {send(res,400,'Invalid action.');return;}
      const args={environment_id:params.get('environment_id')||'',workspace_id:params.get('workspace_id')||undefined,path:params.get('path')||undefined};
      if(!args.environment_id || (action==='register'?!args.path:!args.workspace_id)){send(res,400,'缺少项目参数。');return;}
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
