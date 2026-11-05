import {currentReport,filterReviewExamples} from './presentation.mjs';
const status=document.getElementById('operation-status');
const show=(message,error=false)=>{status.textContent=message;status.setAttribute('role',error?'alert':'status');};
let token;
async function request(path,{body,method='GET'}={}){
  if(method!=='GET'&&!token)token=(await request('/api/bootstrap')).token;
  const response=await fetch(path,{method,headers:method==='GET'?{}:{'content-type':'application/json','x-local-token':token},...(body?{body:JSON.stringify(body)}:{})});
  const data=await response.json();if(!response.ok||data.error)throw new Error(typeof data.error==='string'?data.error:data.error?.message||'Request failed');return data;
}
document.addEventListener('submit',async event=>{
  const form=event.target;if(!(form instanceof HTMLFormElement))return;event.preventDefault();
  const body={},data=new FormData(form,event.submitter);
  for(const [name,raw] of data){
    const input=form.elements.namedItem(name),value=input?.type==='number'?Number(raw):['approved','autoRetest'].includes(name)?raw==='true'||raw==='on':raw;
    if(name.startsWith('limits.'))(body.limits??={})[name.slice(7)]=value;else body[name]=value;
  }
  if(form.elements.namedItem('autoRetest')&&!data.has('autoRetest'))body.autoRetest=false;
  const buttons=[...form.querySelectorAll('button')],states=buttons.map(button=>button.disabled);buttons.forEach(button=>button.disabled=true);show('Saving…');
  try{
    const result=await request(form.getAttribute('action'),{method:'POST',body});
    if(form.dataset.next==='run')location.assign('/operations?tab=run&run='+encodeURIComponent(result.id));
    else if(form.dataset.next==='job')location.assign('/operations?tab=prompts');
    else location.reload();
  }catch(error){show(error.message,true);buttons.forEach((button,index)=>button.disabled=states[index]);}
});
document.addEventListener('click',async event=>{
  const button=event.target.closest('button');if(!button)return;
  if(button.dataset.copyPrompt){
    try{await navigator.clipboard.writeText(document.getElementById(button.dataset.copyPrompt).textContent);show('Prompt copied.');}
    catch{show('Copy unavailable. Select the prompt text.',true);}
    return;
  }
  if(button.hasAttribute('data-status')){
    button.disabled=true;try{document.getElementById('connection-status').textContent=JSON.stringify(await request('/api/status'),null,2);}catch(error){show(error.message,true);}finally{button.disabled=false;}
  }
  if(button.dataset.report){
    button.disabled=true;
    try{
      const data=await request('/api/runs/'+encodeURIComponent(button.dataset.report)+'/report');
      const report=button.dataset.historical==='true'?data.report:currentReport(data);
      const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='invoice-evaluation-report.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(error){show(error.message,true);}finally{button.disabled=false;}
  }
});
function estimate(){
  const form=document.querySelector('form[action="/api/improvements"]');if(!form)return;
  const cases=Number(form.elements.namedItem('limits.maxCaseEvaluations').value),proposals=Number(form.elements.namedItem('limits.maxProposals').value),source=form.elements.namedItem('sourceRunId');
  const count=Number(source.selectedOptions[0]?.dataset.caseCount);
  document.getElementById('optimization-estimate').textContent=`Up to ${cases*9+proposals} optimization requests. ${form.elements.namedItem('autoRetest').checked?`Additional retest requests: ${Number.isFinite(count)?count*18:'Not recorded; select a development run'}.`:'No automatic retest.'} The backend enforces the frozen call budget. Suggested prompts require approval and never activate automatically.`;
}
document.addEventListener('input',event=>{
  estimate();if(event.target.id!=='review-search')return;
  const cards=[...document.querySelectorAll('[data-review-item]')],items=cards.map(card=>({caseId:card.dataset.caseId,caseIndex:card.dataset.caseIndex===''?undefined:Number(card.dataset.caseIndex),category:card.dataset.category}));
  const visible=new Set(filterReviewExamples(items,event.target.value));cards.forEach((card,index)=>card.hidden=!visible.has(items[index]));document.getElementById('review-count').textContent=`${visible.size} of ${cards.length} review items shown.`;
});estimate();
// Refresh only while existing work is active. Reading controls never infers.
if(document.body.dataset.active==='true')setTimeout(()=>location.reload(),15000);
