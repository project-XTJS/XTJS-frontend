import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { chromium } from 'playwright'
let browser, script
before(async () => {
  const result = await build({ stdin: { contents: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import Panel from './src/features/businessManualReview/BusinessManualReviewPanel.jsx';
    function App(){
      const [drafts,setDrafts]=useState({}), [editing,setEditing]=useState({});
      return <Panel currentAlert={{subType:window.fixture.check}} checkLabels={{}} items={window.fixture.items}
        docInfo={null} allDocs={[]} currentPage={1} manualDrafts={drafts} manualEditing={editing}
        onEditingChange={setEditing} onJumpToPage={(item,field)=>{window.located=field.locateTarget}}
        onDraftChange={(id,value)=>{window.saved=JSON.parse(value);setDrafts(x=>({...x,[id]:value}))}} />;
    }
    createRoot(document.getElementById('root')).render(<App/>);
  `, resolveDir: process.cwd(), loader:'jsx' }, bundle:true, write:false, format:'iife', jsx:'automatic', loader:{'.css':'empty'}, define:{'process.env.NODE_ENV':'"test"'} })
  script=result.outputFiles[0].text
  browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-gpu']})
})
after(async()=>{await browser?.close()})
async function render(t,group,value,check='pricing_check'){
  const page=await browser.newPage();page.on('pageerror',err=>assert.fail(err.message));t.after(()=>page.close())
  await page.setContent('<div id="root"></div>')
  await page.evaluate(fixture=>{window.fixture=fixture},{check,items:[{editable_id:'item',field_group:group,field_name:'测试条款',original_value:value}]})
  await page.addScriptTag({content:script})
  await page.locator('.manual-review-field').first().waitFor()
  return page
}
test('费率规则只读，0%保留，并提供招标规则定位',async t=>{
  const page=await render(t,'rate_quote',{current_float_rate:0,required_min_float_rate:0,rule_operator:'>=',rule_resolution:'resolved',rule_source:'tender',rate_label:'下浮率'})
  const threshold=page.locator('.manual-review-field').filter({has:page.getByText('要求最低下浮率（%）',{exact:true})})
  assert.equal(await threshold.getByRole('button',{name:'修改',exact:true}).count(),0)
  assert.match(await threshold.innerText(),/0/)
  await threshold.getByRole('button',{name:'定位招标规则'}).click()
  assert.equal(await page.evaluate(()=>window.located),'rule')
})
test('人工修改日期后等待服务端比较，不凭日期文本直接通过',async t=>{
  const page=await render(t,'attachment_result',{date_text:'2026年9月8日',deadline_date:'2026-09-10',date_status:'pass',signature_status:'not_required',seal_status:'not_required'},'verification_check')
  const field=page.locator('.manual-review-field').filter({has:page.getByText('落款日期',{exact:true})})
  await field.getByRole('button',{name:'修改',exact:true}).click()
  await field.locator('input,textarea').fill('2026年9月11日')
  const saved=await page.evaluate(()=>window.saved)
  assert.equal(saved.date_status,'pending')
  assert.equal(saved.deadline_date,'2026-09-10')
  const deadlineField=page.locator('.manual-review-field').filter({has:page.getByText('有效截止日期',{exact:true})})
  await deadlineField.getByRole('button',{name:'修改',exact:true}).click({timeout:3000})
  await deadlineField.locator('input,textarea').fill('2026-09-12')
  assert.equal(await page.evaluate(()=>window.saved.deadline_manually_confirmed),true)
})
test('报价人工复核不再展示或保存计价口径与适用包件',async t=>{
  const page=await render(t,'opening_amount',{small_amount_yuan:240000,capital_amount_yuan:240000,basis:'contract',package:'1',unit:'万元',currency:'CNY',resolution:'resolved'})
  assert.equal(await page.getByText('计价口径（年度、合同全周期或单价）',{exact:true}).count(),0)
  assert.equal(await page.getByText('适用包件',{exact:true}).count(),0)
  const field=page.locator('.manual-review-field').filter({has:page.getByText('小写报价（元）',{exact:true})})
  await field.getByRole('button',{name:'修改',exact:true}).click()
  await field.locator('input,textarea').fill('20万元')
  const saved=await page.evaluate(()=>window.saved)
  assert.equal(saved.small_amount_yuan,'20万元')
  assert.equal('basis' in saved,false)
  assert.equal('package' in saved,false)
  const constraintPage=await render(t,'price_constraint',{amount_yuan:300000,basis:'annual',package:'1'},'pricing_check')
  assert.equal(await constraintPage.getByText('计价口径（年度、合同全周期或单价）',{exact:true}).count(),0)
  assert.equal(await constraintPage.getByText('适用包件',{exact:true}).count(),0)
})

test('签章编辑不再显示或保留旧的单项确认开关', async t => {
  const page=await render(t,'attachment_result',{signature_evidence:['张三'],signature_status:'pass',signature_manually_confirmed:true,seal_texts:['测试有限公司'],seal_status:'pass',seal_manually_confirmed:true,date_status:'not_required'},'verification_check')
  assert.equal(await page.getByText('已对照原件确认全部所需签字',{exact:true}).count(),0)
  assert.equal(await page.getByText('已对照原件确认公章及主体符合要求',{exact:true}).count(),0)
  const field=page.locator('.manual-review-field').filter({has:page.getByText('签字识别内容（每行一个）',{exact:true})}).first()
  await field.getByRole('button',{name:'修改',exact:true}).click()
  await field.locator('input,textarea').fill('李四')
  const saved=await page.evaluate(()=>window.saved)
  assert.equal('signature_manually_confirmed' in saved,false)
  assert.equal('seal_manually_confirmed' in saved,false)
  assert.equal(saved.signature_status,'pass')
  assert.equal(saved.seal_status,'pass')
})
