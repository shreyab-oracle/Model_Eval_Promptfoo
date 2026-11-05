import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../frontend/viewer-bootstrap.js',import.meta.url),'utf8');
function browser(pathname='/eval',headers=[],reviewCounts,outcomes,charts=[]){
  const listeners=new Map(),redirects=[],body=[];
  const element=tag=>({tag,children:[],dataset:{},style:{},offsetHeight:30,setAttribute(){},addEventListener(){},
    append(...items){for(const item of items){item.parent=this;this.children.push(item);}},add(item){this.append(item);},replaceChildren(){this.children=[];},
    remove(){this.parent.children=this.parent.children.filter(item=>item!==this);},
    querySelectorAll(selector){return this.children.filter(item=>selector==='select'?item.tag==='select':selector==='[data-run-controls]'?item.dataset?.runControls:selector.startsWith('.')?item.className===selector.slice(1):false);},
    querySelector(selector){return this.querySelectorAll(selector)[0]||null;}});
  const location={origin:'http://127.0.0.1:3002',pathname,href:'http://127.0.0.1:3002'+pathname,
    assign:href=>redirects.push(href),replace:href=>redirects.push(href)};
  let update;
  vm.runInNewContext(source,{location,URL,localStorage:{setItem(){}},ResizeObserver:class{observe(){}},Option:class{constructor(label,value){this.label=label;this.value=value;}},
    fetch:async()=>({json:async()=>({oracleRunId:'oracle-'+location.pathname.split('/').at(-1),result:{decision:'BLOCK',reasons:[]},reviewCounts,outcomes,mirrorSnapshot:1})}),
    setInterval:callback=>{update=callback;},document:{createElement:element,querySelectorAll:selector=>selector==='.output-header'?headers:charts,
      addEventListener:(event,callback)=>listeners.set(event,callback),body:{prepend:item=>body.push(item)},documentElement:{style:{setProperty(){}}}}});
  return{listeners,redirects,body,location,start:()=>listeners.get('DOMContentLoaded')(),update:()=>update()};
}

test('run status bar leaves global navigation in the native header',()=>{
  const b=browser();b.start();
  assert.deepEqual(b.body[0].children.filter(item=>item.tag==='a').map(item=>item.textContent),[]);
});

test('case filters describe saved case outcomes without changing their metadata flags',()=>{
  const b=browser('/eval/saved');b.start();
  const filter=b.body[0].children.find(item=>item.tag==='select');
  assert.deepEqual(filter.children.map(o=>[o.value,o.label]),[
    ['ALL','All invoice cases'],['REGRESSION','Baseline passed; candidate failed'],
    ['IMPROVEMENT','Candidate passed; baseline failed'],['CRITICAL','Cases with critical candidate failures'],
    ['REVIEW','Cases with pending human reviews'],['PENDING','Comparisons not final (review or incomplete)']
  ]);
  assert.match(filter.children[4].title,/already failed/);
});

test('native badge distinguishes pending verdicts from genuine errors and incomplete evidence',async()=>{
  const label={textContent:'Errors:'},button={textContent:'Errors: 13',querySelector:()=>label};
  const header={children:[],append(item){this.children.push(item);},querySelector(selector){return selector==='.provider'?{textContent:'candidate'}:selector==='button.error-pill'?button:this.children.find(c=>c.className===selector.slice(1));}};
  const b=browser('/eval/saved',[header],{candidate:{needsReview:13,errors:0}});b.start();await new Promise(setImmediate);
  assert.equal(label.textContent,'Needs review:');assert.match(button.title,/awaiting a final verdict/);
  label.textContent='Errors:';b.update();assert.equal(label.textContent,'Needs review:');
  b.location.pathname='/eval/other';b.update();assert.equal(label.textContent,'Errors:');
  const mixed=browser('/eval/saved',[header],{candidate:{needsReview:12,errors:1}});mixed.start();await new Promise(setImmediate);
  assert.equal(label.textContent,'Needs review / errors:');
  const errors=browser('/eval/saved',[header],{candidate:{needsReview:0,errors:13}});errors.start();await new Promise(setImmediate);
  assert.equal(label.textContent,'Errors:');
});

test('whole-run chart separates passed, failed, review and incomplete answers',async()=>{
  const header={children:[],append(item){this.children.push(item);},querySelector(selector){return selector==='.provider'?{textContent:'candidate'}:this.children.find(c=>c.className===selector.slice(1));}};
  const chart={children:[],append(item){this.children.push(item);},querySelector(selector){return this.children.find(c=>c.className===selector.slice(1));}};
  const outcomes={baseline:{total:300,pass:132,fail:168,needsReview:0,incomplete:0},candidate:{total:300,pass:169,fail:118,needsReview:13,incomplete:0}};
  const b=browser('/eval/saved',[header],undefined,outcomes,[chart]);b.start();await new Promise(setImmediate);
  const summary=header.children[0];assert.match(summary.textContent,/56.33% passed · 169\/300 answers/);
  assert.match(summary.textContent,/118 failed · 13 need review/);assert.match(summary.textContent,/Whole run/);assert.doesNotMatch(summary.textContent,/58.89|287/);
  const panel=chart.children[0],candidate=panel.children[2];
  assert.equal(panel.children[0].children[0].textContent,'Answer outcomes');
  assert.equal(panel.children[0].children[1].textContent,'Whole run');
  assert.deepEqual(candidate.children[2].children.map(c=>c.textContent),['169 passed','118 failed','13 need review']);
  assert.equal(candidate.children[1].children[0].style.width,(169/300*100)+'%');
  assert.ok(Math.abs(parseFloat(candidate.children[1].children[2].style.width)-13/300*100)<1e-10);
  b.update();assert.equal(header.children.length,1);assert.equal(chart.children.length,1);
  outcomes.candidate={total:300,pass:169,fail:118,needsReview:12,incomplete:1};b.update();assert.match(summary.textContent,/12 need review · 1 incomplete/);
  assert.deepEqual(panel.children[2].children[2].children.map(c=>c.textContent),['169 passed','118 failed','12 need review','1 incomplete']);
  b.location.pathname='/eval/other';b.update();assert.equal(summary.textContent,'Pass rate: Not recorded');
  assert.equal(panel.children[2].children[0].children[1].textContent,'Not recorded');assert.equal(panel.children[2].children.length,1);
});

test('native prompt, dataset and history clicks open the single Oracle workflow',()=>{
  const b=browser();b.start();
  for(const [page,tab] of [['prompts','prompts'],['datasets','setup'],['history','history']]){
    let prevented=false;
    b.listeners.get('click')({target:{closest:()=>({href:'http://127.0.0.1:3002/'+page})},preventDefault:()=>{prevented=true;},stopPropagation(){}});
    assert.equal(prevented,true);assert.equal(b.redirects.at(-1),'/operations?tab='+tab);
  }
});

test('direct links and native client navigation use the same Oracle workflow pages',()=>{
  for(const [page,tab] of [['prompts','prompts'],['datasets','setup'],['history','history']]){
    assert.equal(browser('/'+page).redirects[0],'/operations?tab='+tab);
    const b=browser();b.start();b.location.pathname='/'+page;b.update();assert.equal(b.redirects.at(-1),'/operations?tab='+tab);
  }
});

test('switching native runs keeps one set of controls for the selected run',async()=>{
  const b=browser('/eval/first');b.start();await new Promise(setImmediate);
  b.location.pathname='/eval/second';b.location.href=b.location.origin+b.location.pathname;b.update();await new Promise(setImmediate);
  const links=b.body[0].children.filter(item=>item.tag==='a');
  assert.equal(links.length,2);
  assert.deepEqual(links.map(link=>link.href),['/operations?tab=run&run=oracle-second','/eval/oracle-second']);
});
