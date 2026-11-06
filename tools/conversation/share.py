#!/usr/bin/env python3
import importlib, json, os, re, ssl, time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import HTTPSHandler, ProxyHandler, Request, build_opener

def ca_bundle_path():
    for name in ('SSL_CERT_FILE','REQUESTS_CA_BUNDLE','CURL_CA_BUNDLE'):
        value=os.environ.get(name)
        if value and Path(value).is_file():
            return str(Path(value))
    for module_name in ('certifi','pip._vendor.certifi'):
        try:
            module=importlib.import_module(module_name)
            value=module.where()
            if value and Path(value).is_file():
                return str(Path(value))
        except (ImportError, AttributeError):
            pass
    return None

def ssl_context():
    bundle=ca_bundle_path()
    return ssl.create_default_context(cafile=bundle) if bundle else ssl.create_default_context()

def share_source(url):
    u=urlparse(url)
    if u.scheme=='https' and u.hostname in ('chatgpt.com','www.chatgpt.com') and not u.username and not u.password and u.port in (None,443):
        if re.fullmatch(r'/s/cx_[0-9a-f]{32}/?',u.path):return 'codex'
        if re.fullmatch(r'/share/[^/]+/?',u.path):return 'chatgpt'
    raise ValueError('share_url 必须是 https://chatgpt.com/share/... 或 https://chatgpt.com/s/cx_<32位小写十六进制> 链接')

def fetch(url):
    source=share_source(url)
    if source=='codex':
        share_id=urlparse(url).path.rstrip('/').split('/')[-1]
        url='https://chatgpt.com/backend-api/wham/shared_threads/'+share_id
    # Unlike Node, urllib may read the Windows system proxy when environment
    # proxy variables are absent. Direct mode must explicitly disable that.
    if os.environ.get('CCM_CONVERSATION_PROXY_MODE') == 'direct':
        opener=build_opener(ProxyHandler({}), HTTPSHandler(context=ssl_context()))
    else:
        opener=build_opener(HTTPSHandler(context=ssl_context()))
    if source=='chatgpt':
        # The Share route serves metadata-only HTML to non-browser clients, even with HTTP 200.
        headers={
            'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language':'en-US,en;q=0.9',
        }
    else:
        headers={'Accept':'application/json'}
    request=Request(url,headers=headers)
    last_error=None
    for attempt in range(2):
        try:
            with opener.open(request,timeout=60) as response:
                body=response.read()
                charset=response.headers.get_content_charset() or 'utf-8'
                return body.decode(charset,'replace')
        except HTTPError as e:
            if source=='codex' and e.code in (403,404,410):
                raise RuntimeError(f'Codex 共享会话不可访问或已删除（HTTP {e.code}）') from e
            raise RuntimeError(f'ChatGPT Share request failed with HTTP {e.code}: {e.reason}') from e
        except (URLError,TimeoutError,OSError) as e:
            last_error=e
            if attempt==0:
                time.sleep(0.25)
    reason=getattr(last_error,'reason',last_error)
    raise RuntimeError(f'ChatGPT Share request failed: {reason}') from last_error

def resolve_indexed(D, value, cache=None, stack=None):
    cache={} if cache is None else cache
    stack=set() if stack is None else stack
    if isinstance(value,int):
        if value<0:return None if value==-5 else value
        if value in cache:return cache[value]
        if value>=len(D) or value in stack:return None
        resolved=resolve_indexed(D,D[value],cache,stack|{value})
        cache[value]=resolved
        return resolved
    if isinstance(value,list):
        return [resolve_indexed(D,x,cache,stack) for x in value]
    if isinstance(value,dict):
        out={}
        for k,x in value.items():
            key=resolve_indexed(D,int(k[1:]),cache,stack) if isinstance(k,str) and k.startswith('_') and k[1:].isdigit() else k
            out[str(key)]=resolve_indexed(D,x,cache,stack)
        return out
    return value

def share_loader_error(D):
    if not isinstance(D,list):return None
    for raw in D:
        if not isinstance(raw,dict):continue
        for k,v in raw.items():
            if not (isinstance(k,str) and k.startswith('_') and k[1:].isdigit()):continue
            ki=int(k[1:])
            if ki>=len(D) or D[ki]!='serverResponse':continue
            response=resolve_indexed(D,v)
            if not isinstance(response,dict) or response.get('type')!='error':continue
            message=response.get('toastMessage') or response.get('error') or response.get('message')
            if response.get('showInaccessibleToast') or (isinstance(message,str) and 'deleted' in message.lower()):
                return 'ChatGPT Share conversation has been deleted or is inaccessible.'
            if isinstance(message,str) and message.strip():
                return f'ChatGPT Share returned an error: {message.strip()}'
    return None

def extract_payload(html):
    marker='streamController.enqueue("'
    start=html.find(marker)
    while start>=0:
        a=start+len(marker); j=a; esc=False
        while j<len(html):
            c=html[j]
            if esc: esc=False
            elif c=='\\': esc=True
            elif c=='"' and html.startswith('")',j):
                raw=html[a:j]
                try:
                    decoded=json.loads('"'+raw+'"'); data=json.loads(decoded)
                    if isinstance(data,list) and 'mapping' in data: return data
                    loader_error=share_loader_error(data)
                    if loader_error: raise RuntimeError(loader_error)
                except RuntimeError:
                    raise
                except Exception: pass
                break
            j+=1
        start=html.find(marker,start+len(marker))
    raise RuntimeError('No supported ChatGPT Share serialized conversation payload found')

def unpack(D):
    cache={}
    def idx(i,stack=frozenset()):
        if i<0:return None if i==-5 else i
        if i in cache:return cache[i]
        if i>=len(D):return i
        if i in stack:return None
        raw=D[i]; v=val(raw,stack|{i}) if isinstance(raw,(list,dict)) else raw; cache[i]=v; return v
    def val(v,stack=frozenset()):
        if isinstance(v,int):return idx(v,stack)
        if isinstance(v,list):return [val(x,stack) for x in v]
        if isinstance(v,dict):
            o={}
            for k,x in v.items():
                key=idx(int(k[1:]),stack) if k.startswith('_') and k[1:].isdigit() else k
                o[str(key)]=val(x,stack)
            return o
        return v
    mi=D.index('mapping'); raw=D[mi+1]
    nodes={}
    for k,v in raw.items():
        mid=idx(int(k[1:])) if k.startswith('_') and k[1:].isdigit() else k
        node=idx(v) if isinstance(v,int) else val(v)
        if isinstance(node,dict):nodes[str(mid)]=node
    return nodes

def message_record(mid,node):
    m=node.get('message')
    if not isinstance(m,dict):return None
    a=m.get('author') or {}; role=a.get('role') if isinstance(a,dict) else None
    c=m.get('content') or {}; parts=c.get('parts') if isinstance(c,dict) else None
    text='\n'.join(x for x in parts if isinstance(x,str)).strip() if isinstance(parts,list) else ''; nontext=[x for x in parts if isinstance(x,dict)] if isinstance(parts,list) else []; visible_text=text or ('[image]' if any(x.get('content_type')=='image_asset_pointer' for x in nontext) else ('[attachment]' if nontext else ''))
    return {'id':mid,'parent':node.get('parent'),'children':node.get('children') or [],'role':role,'author':a,'create_time':m.get('create_time'),'update_time':m.get('update_time'),'content':c,'text':text,'visible_text':visible_text,'status':m.get('status'),'end_turn':m.get('end_turn'),'weight':m.get('weight'),'metadata':m.get('metadata') or {},'recipient':m.get('recipient'),'channel':m.get('channel')}

def codex_records(snapshot):
    if not isinstance(snapshot,dict) or type(snapshot.get('version')) is not int or snapshot['version']!=1 or not isinstance(snapshot.get('turns'),list):
        raise ValueError('不支持的 Codex 共享快照：需要 version=1 和 turns 数组')
    recs=[]
    for turn_index,turn in enumerate(snapshot['turns']):
        if not isinstance(turn,dict) or not isinstance(turn.get('items'),list):
            raise ValueError('Codex 共享快照的每个轮次必须包含 items 数组')
        for item_index,item in enumerate(turn['items']):
            if not isinstance(item,dict) or not isinstance(item.get('type'),str):
                raise ValueError('Codex 共享快照包含无效消息项')
            kind=item['type']; role='tool'; channel=None
            if kind=='userMessage':
                role='user'; content=item.get('content')
                if not isinstance(content,list) or any(not isinstance(p,dict) for p in content):
                    raise ValueError('Codex 用户消息的 content 必须是对象数组')
                text='\n'.join(p.get('text','') for p in content if p.get('type')=='text')
                visible='\n'.join(p.get('text','') if p.get('type')=='text' else '[图片：'+str(p.get('url','不可用'))+']' if p.get('type')=='image' else '[附件]' for p in content)
            elif kind=='agentMessage':
                role='assistant'; text=item.get('text',''); visible=text
                channel='final' if item.get('phase')=='final_answer' else item.get('phase')
            elif kind=='reasoning':
                role='assistant'; channel='analysis'; text=item.get('summary',''); visible=text
            elif kind=='fileChange':
                text='\n\n'.join(str(change.get('path','文件修改'))+'\n'+str(change.get('diff','')) for change in item.get('changes',[])); visible=text or '[文件修改]'
            elif kind in ('imageView','imageGeneration'):
                text=''; visible='[图片：'+str(item.get('url',item.get('result','不可用')))+']'
            else:
                text=''; visible='[未识别的 Codex 消息项：'+kind+']'
            if not isinstance(text,str) or not isinstance(visible,str):
                raise ValueError('Codex 共享快照中的消息文本必须是字符串')
            recs.append({'id':f'turn-{turn_index}-item-{item_index}','role':role,'channel':channel,'create_time':None,'text':text,'visible_text':visible,'type':kind,'turn_index':turn_index,'item_index':item_index,'duration_ms':turn.get('durationMs'),'content':item})
    return recs

def active_branch(nodes,current_node=None):
    if current_node in nodes:
        path=[]; seen=set(); cur=current_node
        while cur in nodes and cur not in seen:
            seen.add(cur); path.append(cur); cur=nodes[cur].get('parent')
        return list(reversed(path))
    def t(mid):
        r=message_record(mid,nodes[mid]); return (r or {}).get('create_time') or 0
    leaves=[k for k,n in nodes.items() if not n.get('children')]
    if not leaves:raise RuntimeError('Conversation mapping has no leaf nodes')
    leaf=max(leaves,key=t); path=[]; seen=set(); cur=leaf
    while cur in nodes and cur not in seen:
        seen.add(cur); path.append(cur); cur=nodes[cur].get('parent')
    return list(reversed(path))

def conversation_meta(D):
    for v in D:
        if not isinstance(v,dict): continue
        out={}
        for k,x in v.items():
            if not (isinstance(k,str) and k.startswith('_') and k[1:].isdigit()): continue
            ki=int(k[1:])
            if ki>=len(D): continue
            key=D[ki]
            if key in ('title','current_node','og_title','og_description','is_public'):
                out[key]=D[x] if isinstance(x,int) and 0<=x<len(D) else x
        if 'current_node' in out and ('title' in out or 'og_title' in out): return out
    return {}
def title_from_html(html):
    m=re.search(r'<title[^>]*>(.*?)</title>',html,re.I|re.S)
    if m:
        import html as htmlmod
        title=htmlmod.unescape(re.sub(r'\s+',' ',m.group(1))).strip()
        title=re.sub(r'^ChatGPT\s*[-鈥撯€攟]\s*', '', title, flags=re.I).strip()
        title=re.sub(r'\s*[-鈥撯€攟]\s*ChatGPT\s*$', '', title, flags=re.I).strip()
        if title:return title
    return 'ChatGPT Shared Conversation'
