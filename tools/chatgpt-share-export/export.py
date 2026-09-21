#!/usr/bin/env python3
import argparse, json, re, subprocess, sys
from pathlib import Path
from urllib.parse import urlparse

def fetch(url):
    u=urlparse(url)
    if u.scheme!='https' or u.hostname not in ('chatgpt.com','www.chatgpt.com') or not u.path.startswith('/share/'):
        raise ValueError('share_url must be an https://chatgpt.com/share/... URL')
    p=subprocess.run(['curl.exe','-L','--fail','--silent','--show-error','--connect-timeout','10','--max-time','60','--retry','1',url],capture_output=True)
    if p.returncode: raise RuntimeError(p.stderr.decode('utf-8','replace').strip() or f'curl failed: {p.returncode}')
    return p.stdout.decode('utf-8','replace')

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

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('share_url'); ap.add_argument('--output'); ap.add_argument('--format',choices=['md','json'],default='md'); ap.add_argument('--branch',choices=['active','all'],default='active'); ap.add_argument('--mode',choices=['text','full'],default='text'); ap.add_argument('--json-summary',action='store_true'); a=ap.parse_args()
    html=fetch(a.share_url); D=extract_payload(html); nodes=unpack(D); meta=conversation_meta(D); current_node=meta.get('current_node')
    ids=active_branch(nodes,current_node) if a.branch=='active' else sorted(nodes,key=lambda k:(message_record(k,nodes[k]) or {}).get('create_time') or 0)
    recs=[message_record(i,nodes[i]) for i in ids]; recs=[r for r in recs if r]
    if a.mode=='text':
        recs=[r for r in recs if r['role'] in ('user','assistant') and r['visible_text'] and r['text']!='Original custom instructions no longer available' and r['text']!='The output of this plugin was redacted.']
    title=meta.get('title') or meta.get('og_title') or title_from_html(html); turns=sum(r['role']=='user' for r in recs)
    out=Path(a.output) if a.output else Path(re.sub(r'[<>:"/\\|?*]+','_',title)+('_all' if a.branch=='all' else '')+'.'+a.format)
    if a.format=='json': out.write_text(json.dumps({'title':title,'share_url':a.share_url,'branch':a.branch,'mode':a.mode,'total_nodes':len(nodes),'messages':recs if a.mode=='full' else [{'id':r['id'],'role':r['role'],'create_time':r['create_time'],'text':r['visible_text']} for r in recs]},ensure_ascii=False,indent=2),encoding='utf-8')
    else:
        lines=["# ChatGPT Share export","","> exported conversation",""]; turn=0
        for r in recs:
            if r['role']=='user':turn+=1
            lines += ["## message", "", r["text"], ""]
        out.write_text('\n'.join(lines),encoding='utf-8')
    summary={'status':'ok','title':title,'branch':a.branch,'total_nodes':len(nodes),'exported_messages':len(recs),'user_turns':turns,'assistant_messages':sum(r['role']=='assistant' for r in recs),'output_path':str(out.resolve()),'output_bytes':out.stat().st_size}
    print(json.dumps(summary,ensure_ascii=False))
if __name__=='__main__':
    try:main()
    except Exception as e:
        print(json.dumps({'status':'error','error':str(e)},ensure_ascii=False)); sys.exit(1)
