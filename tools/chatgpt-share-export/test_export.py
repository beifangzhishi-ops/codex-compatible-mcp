import importlib.util, os, tempfile, unittest
from pathlib import Path
from unittest.mock import patch

P=Path(__file__).with_name('export.py')
spec=importlib.util.spec_from_file_location('share_export',P)
e=importlib.util.module_from_spec(spec); spec.loader.exec_module(e)

class ParserTests(unittest.TestCase):
 def test_ca_bundle_prefers_explicit_environment_file(self):
  with tempfile.NamedTemporaryFile() as f:
   with patch.dict(os.environ,{'SSL_CERT_FILE':f.name},clear=False):
    self.assertEqual(e.ca_bundle_path(),str(Path(f.name)))
 def test_fetch_rejects_non_share_url_before_network_access(self):
  with self.assertRaises(ValueError):
   e.fetch('https://chatgpt.com/')
 def test_default_output_uses_gitignored_cache(self):
  out=e.resolve_output_path('https://chatgpt.com/share/abc',None,'md','active','text',Path('C:/repo'))
  self.assertEqual(out,Path('C:/repo/.cache/chatgpt-share-export/abc.active.text.md').resolve())
 def test_relative_output_uses_gitignored_cache(self):
  out=e.resolve_output_path('https://chatgpt.com/share/abc','nested/session.json','json','active','full',Path('C:/repo'))
  self.assertEqual(out,Path('C:/repo/.cache/chatgpt-share-export/nested/session.json').resolve())
 def test_relative_output_cannot_escape_cache(self):
  with self.assertRaises(ValueError):
   e.resolve_output_path('https://chatgpt.com/share/abc','../../outside.md','md','active','text',Path('C:/repo'))
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
 def test_markdown_preserves_speaker_roles(self):
  out=e.render_markdown([
   {'role':'user','text':'hello','visible_text':'hello'},
   {'role':'assistant','text':'hi','visible_text':'hi'},
   {'role':'tool','text':'result','visible_text':'result'},
  ])
  self.assertIn('## User\n\nhello',out)
  self.assertIn('## Assistant\n\nhi',out)
  self.assertIn('## Tool\n\nresult',out)
  self.assertNotIn('## message',out)

if __name__=='__main__': unittest.main()
