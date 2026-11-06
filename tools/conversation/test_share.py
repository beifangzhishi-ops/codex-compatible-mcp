import importlib.util, io, json, os, sys, tempfile, unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

P=Path(__file__).with_name('share.py')
spec=importlib.util.spec_from_file_location('share_export',P)
e=importlib.util.module_from_spec(spec); spec.loader.exec_module(e)

@contextmanager
def temporary_output(suffix):
 fd,name=tempfile.mkstemp(suffix=suffix)
 os.close(fd)
 out=Path(name)
 try:yield out
 finally:out.unlink(missing_ok=True)

class ParserTests(unittest.TestCase):
 def test_ca_bundle_prefers_explicit_environment_file(self):
  with tempfile.NamedTemporaryFile() as f:
   with patch.dict(os.environ,{'SSL_CERT_FILE':f.name},clear=False):
    self.assertEqual(e.ca_bundle_path(),str(Path(f.name)))
 def test_fetch_rejects_non_share_url_before_network_access(self):
  with self.assertRaises(ValueError):
   e.fetch('https://chatgpt.com/')
 def test_chatgpt_fetch_requests_desktop_html_instead_of_metadata_only_response(self):
  response=unittest.mock.MagicMock()
  response.__enter__.return_value=response
  response.read.return_value=b'<html>full Share HTML</html>'
  response.headers.get_content_charset.return_value='utf-8'
  opener=unittest.mock.MagicMock()
  opener.open.return_value=response
  url='https://chatgpt.com/share/example?ogimg=plain'
  with patch.object(e,'build_opener',return_value=opener),patch.object(e,'ssl_context'):
   self.assertEqual(e.fetch(url),'<html>full Share HTML</html>')
  request=opener.open.call_args.args[0]
  self.assertEqual(request.full_url,url)
  self.assertTrue(request.get_header('User-agent').startswith('Mozilla/5.0'))
  self.assertIn('text/html',request.get_header('Accept'))
  self.assertIn('en-US',request.get_header('Accept-language'))
 def test_codex_url_routes_to_public_snapshot_without_html(self):
  url='https://chatgpt.com/s/cx_'+'a'*32+'?来源=测试'
  response=unittest.mock.MagicMock()
  response.__enter__.return_value=response
  response.read.return_value=b'{"version":1,"turns":[]}'
  response.headers.get_content_charset.return_value='utf-8'
  opener=unittest.mock.MagicMock()
  opener.open.return_value=response
  with patch.object(e,'build_opener',return_value=opener),patch.object(e,'ssl_context'):
   self.assertEqual(json.loads(e.fetch(url)),{'version':1,'turns':[]})
  request=opener.open.call_args.args[0]
  self.assertEqual(request.full_url,'https://chatgpt.com/backend-api/wham/shared_threads/cx_'+'a'*32)
  self.assertEqual(request.get_header('Accept'),'application/json')
  self.assertEqual(opener.open.call_args.kwargs['timeout'],60)
 def test_url_validation_rejects_unrelated_paths_and_hosts(self):
  for url in ('https://chatgpt.com/s/cx_bad','https://chatgpt.com/s/abc','https://chatgpt.com.evil.test/s/cx_'+'a'*32,'http://chatgpt.com/share/abc','https://chatgpt.com:8443/share/abc','https://user@chatgpt.com/share/abc'):
   with self.subTest(url=url),patch.object(e,'build_opener') as opener:
    with self.assertRaises(ValueError):e.fetch(url)
    opener.assert_not_called()
 def test_codex_unavailable_snapshot_reports_http_error(self):
  opener=unittest.mock.MagicMock()
  opener.open.side_effect=e.HTTPError('https://chatgpt.com/',404,'Not Found',{},None)
  with patch.object(e,'build_opener',return_value=opener),patch.object(e,'ssl_context'):
   with self.assertRaisesRegex(RuntimeError,'Codex.*404'):
    e.fetch('https://chatgpt.com/s/cx_'+'a'*32)
 def codex_snapshot(self):
  return {'version':1,'title':'示例会话','omittedFileChangeCount':2,'assets':{'https://example.test/image.png':{'width':100,'height':200}},'turns':[{'durationMs':42,'items':[
   {'type':'userMessage','content':[{'type':'text','text':'请检查'},{'type':'image','url':'https://example.test/image.png'}]},
   {'type':'agentMessage','text':'正在检查','phase':'commentary'},
   {'type':'reasoning','summary':'公开推理摘要'},
   {'type':'fileChange','status':'completed','changes':[{'path':'README.md','diff':'-旧内容\n+新内容'}]},
   {'type':'imageView','url':'codex:shared-image-unavailable'},
   {'type':'imageGeneration','status':'completed','result':'https://example.test/image.png'},
   {'type':'agentMessage','text':'已完成','phase':'final_answer'},
   {'type':'futureItem','data':{'保留':'原始内容'}},
  ]},{'items':[{'type':'userMessage','content':[{'type':'image','url':'codex:shared-image-unavailable'}]}]}]}
 def test_codex_records_preserve_order_types_and_raw_items(self):
  snapshot=self.codex_snapshot(); recs=e.codex_records(snapshot)
  self.assertEqual(len(recs),9)
  self.assertEqual([r['content'] for r in recs], [i for t in snapshot['turns'] for i in t['items']])
  self.assertEqual(recs[1]['channel'],'commentary')
  self.assertEqual(recs[2]['channel'],'analysis')
  self.assertEqual(recs[6]['channel'],'final')
  self.assertEqual(recs[0]['duration_ms'],42)
  self.assertIn('+新内容',recs[3]['visible_text'])
  self.assertIn('图片',recs[-1]['visible_text'])
  self.assertEqual(len({r['id'] for r in recs}),9)
 def test_codex_rejects_unsupported_and_malformed_snapshots(self):
  for snapshot in ({'version':2,'turns':[]},{'version':True,'turns':[]},{'version':1,'turns':[{}]},{'version':1,'turns':[{'items':[None]}]}, {'version':1,'turns':[{'items':[{'type':'userMessage','content':'错误'}]}]}):
   with self.subTest(snapshot=snapshot),self.assertRaises(ValueError):e.codex_records(snapshot)
 def test_deleted_share_loader_error_is_reported_clearly(self):
  D=[
   {'_1':2},
   'loaderData',
   {'_3':4},
   'serverResponse',
   {'_5':6,'_7':8,'_9':10},
   'type',
   'error',
   'showInaccessibleToast',
   True,
   'toastMessage',
   'Conversation has been deleted. Start a new chat.',
  ]
  self.assertEqual(
   e.share_loader_error(D),
   'ChatGPT Share conversation has been deleted or is inaccessible.',
  )
 def test_normal_payload_does_not_report_loader_error(self):
  D=['mapping',{},'Conversation has been deleted. Start a new chat.']
  self.assertIsNone(e.share_loader_error(D))
 def test_flattened_numeric_primitive_is_not_double_dereferenced(self):
  D=['mapping',{'_2':3},'node',{'_4':5},'width',1080]
  self.assertEqual(e.unpack(D)['node']['width'],1080)
 def test_unpack_without_mapping_fails(self):
  with self.assertRaises(ValueError): e.unpack(['no-mapping'])
 def test_conversation_meta_resolves_indexed_root(self):
  D=['title','示例标题','current_node','node-2',{'_0':1,'_2':3}]
  self.assertEqual(e.conversation_meta(D),{'title':'示例标题','current_node':'node-2'})
 def test_current_node_beats_newer_leaf(self):
  def n(parent,children,t): return {'parent':parent,'children':children,'message':{'author':{'role':'assistant'},'create_time':t,'content':{'parts':['x']}}}
  nodes={'root':n(None,['chosen','newer'],1),'chosen':n('root',[],2),'newer':n('root',[],99)}
  self.assertEqual(e.active_branch(nodes,'chosen'),['root','chosen'])
 def test_image_only_user_is_visible(self):
  node={'parent':'p','children':[],'message':{'author':{'role':'user'},'content':{'content_type':'multimodal_text','parts':[{'content_type':'image_asset_pointer','asset_pointer':'x'}]},'metadata':{}}}
  r=e.message_record('m',node)
  self.assertEqual(r['text'],'')
  self.assertEqual(r['visible_text'],'[image]')
  self.assertEqual(r['content']['parts'][0]['content_type'],'image_asset_pointer')
 def test_full_record_fields(self):
  node={'parent':'p','children':['c'],'message':{'author':{'role':'tool','name':'demo'},'create_time':1,'update_time':2,'content':{'content_type':'text','parts':['result']},'status':'finished_successfully','end_turn':True,'weight':1,'metadata':{'k':'v'},'recipient':'assistant','channel':'analysis'}}
  r=e.message_record('m',node)
  for k in ('id','parent','children','role','author','create_time','update_time','content','text','visible_text','status','end_turn','weight','metadata','recipient','channel'): self.assertIn(k,r)
  self.assertEqual(r['role'],'tool'); self.assertEqual(r['recipient'],'assistant')
 def test_active_branch_uses_latest_leaf(self):
  def n(parent,children,t,role='assistant'):
   return {'parent':parent,'children':children,'message':{'author':{'role':role},'create_time':t,'content':{'parts':['x']}}}
  nodes={'root':n(None,['a','b'],1),'a':n('root',[],2),'b':n('root',[],3)}
  self.assertEqual(e.active_branch(nodes),['root','b'])

if __name__=='__main__': unittest.main()
