import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {build} from 'esbuild'
import {chromium} from 'playwright'
let browser,script
before(async()=>{
 const bundled=await build({stdin:{contents:`import {auditCollect} from './src/pages/ReviewPage.jsx'; window.auditCollect=auditCollect;`,resolveDir:process.cwd(),loader:'jsx'},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.css':'empty'},define:{'process.env.NODE_ENV':'"test"','import.meta.env':'{}'},plugins:[{name:'test-export',setup(b){b.onLoad({filter:/\/ReviewPage\.jsx$/},async args=>({contents:await readFile(args.path,'utf8')+'\nexport {collectFormatReviewAlerts as auditCollect};',loader:'jsx'}))}}]})
 script=bundled.outputFiles[0].text
 browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-gpu']})
})
after(async()=>await browser?.close())
async function collect(t,evidence){
 const page=await browser.newPage();t.after(()=>page.close());await page.setContent('<div></div>');await page.addScriptTag({content:script})
 return page.evaluate(e=>{
  const alerts=[]
  const tender={identifier_id:'tender',file_name:'招标文件.pdf',role:'tender',file_url:'/tender.pdf'}
  const business={identifier_id:'bid',file_name:'商务文件.pdf',role:'business',file_url:'/bid.pdf'}
  const issue={title:'附件13',status:'missing',page:49,source_page:49,message:'未找到要求签章的附件。',evidence:e}
  const check={check_name:'签字盖章日期审查',review:{status:'missing'},issues:{missing:[issue]}}
  const bidder={bidder_key:'bidder',bidder_name:'测试投标人',documents:{business},checks:{verification_check:check}}
  window.auditCollect({business_bid_format_review:{dataset:{tender},bidders:[bidder]}},alerts)
  return alerts
 },evidence)
}
test('旧缺附件结果不将招标第49页作为投标预览',async t=>{
 const [a]=await collect(t,{source:'position_check',attachment:'附件13',template_locations:[{page:49,bbox:[10,20,30,40],document_role:'tender'}]})
 assert.match(a.description,/未定位到对应投标内容/)
 assert.ok(a.documents.length>0)
 assert.ok(a.documents.every(d=>d.role==='tender'||d.documentType==='tender'))
 assert.equal(a.documents[0].startPage,49)
})
test('新缺附件明确归属时只保留招标证据',async t=>{
 const [a]=await collect(t,{source:'attachment_result',attachment:'附件13',bid_content_found:false,template_locations:[{page:49,bbox:[10,20,30,40],document_role:'tender'}]})
 assert.ok(a.documents.every(d=>d.role==='tender'||d.documentType==='tender'))
 assert.match(a.description,/未定位到对应投标内容/)
})
test('已找到附件的缺签问题保留实际投标页',async t=>{
 const [a]=await collect(t,{source:'attachment_result',attachment:'附件13',bid_content_found:true,matched_bid_title:'附件13',pages:[40],locations:[{page:40,bbox:[10,20,30,40],document_role:'business_bid',document_identifier_id:'bid'}],template_locations:[{page:49,document_role:'tender'}]})
 assert.ok(a.documents.some(d=>d.startPage===40))
 assert.doesNotMatch(a.description,/未定位到对应投标内容/)
})
