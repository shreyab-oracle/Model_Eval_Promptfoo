import {outputFindings} from '../evaluation/findings.mjs';
import {testLabel,roleLabel,readable,promptLabel,caseLabel} from '../../frontend/presentation.mjs';
export const escapeHTML=value=>String(value??'Not recorded').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const e=escapeHTML;
const value=v=>v===undefined?'Not recorded':v===null?'Unknown (recorded null)':typeof v==='string'?v:JSON.stringify(v);
const pre=v=>`<pre>${e(value(v))}</pre>`;
const field=(label,input)=>`<label>${e(label)}${input}</label>`;
const input=(name,attrs='')=>`<input name="${e(name)}" ${attrs}>`;
const hidden=(name,val)=>input(name,`type="hidden" value="${e(val)}"`);
const reason=()=>field('Reason',`<textarea name="reason" required></textarea>`);
const select=(name,items)=>`<select name="${e(name)}" required>${items.map(([id,label])=>`<option value="${e(id)}">${e(label)}</option>`).join('')}</select>`;
const form=(action,body,next='reload')=>`<form action="${e(action)}" data-next="${e(next)}">${body}</form>`;
const button=(label,attrs='')=>`<button ${attrs}>${e(label)}</button>`;
const card=(title,body,attrs='')=>`<section class="card" ${attrs}><h2>${e(title)}</h2>${body}</section>`;
const details=(label,body)=>`<details><summary>${e(label)}</summary>${body}</details>`;
const link=(href,label)=>`<a href="${e(href)}">${e(label)}</a>`;
const caseResultsUrl=item=>`/eval/${encodeURIComponent(item.runId)}?filter=${encodeURIComponent(JSON.stringify([{type:'metadata',operator:'equals',field:'caseId',value:item.caseId}]))}`;
const audit=reviews=>reviews?.length?`<ol>${reviews.map(r=>`<li><strong>${e(r.resolution)}</strong> · ${e(r.actor)} · ${e(r.createdAt)}<p>${e(r.reason)}</p></li>`).join('')}</ol>`:'<p>Not recorded</p>';

export function findingsHTML(output){
  const findings=output.findings||outputFindings(output);
  return findings.length?`<ul class="findings">${findings.map(f=>`<li><strong>${e(f.name)} · ${e(f.status)}</strong><p>${e(f.explanation)}</p>${details('Evidence and rule details',`<dl><dt>Severity</dt><dd>${e(f.severity)}</dd><dt>Policy reference</dt><dd>${e(f.ruleReference)}</dd><dt>Expected</dt><dd>${e(f.expectedRecorded===false?'Not recorded':value(f.expected))}</dd><dt>Actual</dt><dd>${e(f.actualRecorded===false?'Not recorded':value(f.actual))}</dd><dt>Field</dt><dd>${e(f.evidence?.field)}</dd><dt>Evaluator</dt><dd>${e(f.evaluatorVersion)}</dd><dt>Confirmation</dt><dd>${f.confirmed?'Confirmed failure':f.requiresHumanReview?'Requires human review':'No confirmed failure'}</dd></dl>${f.evidence?.excerpt?`<blockquote>${e(f.evidence.excerpt)}</blockquote>`:''}`)}</li>`).join('')}</ul>`:'<p>Not recorded</p>';
}
const judgesHTML=judges=>(judges||[]).map((j,i)=>details(`Judge ${(j.assessment??i)+1}${j.critical?' · critical opinion requires adjudication':''}`,`<p>${e(j.rationale)}</p><dl>${['policy','evidence','tone','clarity','nextSteps'].map(axis=>`<dt>${e(axis)}</dt><dd>${Number.isInteger(j.scores?.[axis])?j.scores[axis]+'/3':'Not recorded'}</dd>`).join('')}</dl>${j.criticalReason?`<p>${e(j.criticalReason)}</p>`:''}${(j.evidence||[]).map(ev=>`<blockquote>${e(ev.quote)}<small>${e(ev.axis)} · ${e(ev.reason)}</small></blockquote>`).join('')}`)).join('')||'<p>Not recorded</p>';

function setup(boot){
  const prompts=boot.prompts.filter(p=>!p.generated||boot.promptApprovals.some(a=>a.parentId===p.id&&a.approved));
  const models=Object.entries(boot.configuration.models).map(([role,id])=>[id,boot.configuration.modelNames?.[role]||roleLabel(role)]).filter(([id],index,items)=>id&&items.findIndex(([other])=>id===other)===index);
  const modelSelect=role=>field(roleLabel(role),`<select name="${role}ModelId" required>${models.map(([id,label])=>`<option value="${e(id)}"${id===boot.configuration.models[role]?' selected':''}>${e(label)}</option>`).join('')}</select>`);
  return card('Prepare an invoice evaluation',form('/api/runs',field('Invoice examples',select('datasetId',boot.datasets.map(d=>[d.id,`${d.kind} · ${d.caseCount} cases · ${d.version}`])))+
    modelSelect('baseline')+modelSelect('candidate')+modelSelect('judge')+field('Instructions',select('promptId',prompts.map(p=>[p.id,promptLabel(p)])))+field('Policy',select('policyId',boot.policies.map(p=>[p.id,p.policy?.version||'Saved policy'])))+
    '<p>Both models answer each case three times. Each answer receives two independent judge assessments.</p><ul>'+boot.datasets.map(d=>`<li>${e(d.version)}: ${d.caseCount*18} planned OCI requests (${d.caseCount*6} answers and ${d.caseCount*12} judgments). Retries can add bounded attempts.</li>`).join('')+'</ul>'+button('Prepare test'),'run'));
}
function runControls(b){
  if(!b)return card('Select a run','<p>Open a saved evaluation from History.</p>');
  const {run,result,progress}=b,base=`/api/runs/${encodeURIComponent(run.id)}`;
  let controls=link(`/eval/${encodeURIComponent(run.id)}`,'Open Promptfoo results')+' ';
  if(!b.historical){
    if(['DRAFT','CANCELLED','INCOMPLETE'].includes(run.status))controls+=form(base+'/'+(run.status==='DRAFT'?'start':'resume'),button(run.status==='DRAFT'?'Start evaluation':'Resume'));
    if(run.status==='RUNNING')controls+=form(base+'/cancel',button('Cancel new work'));
    controls+=form(base+'/report',button('Check and save report',run.status!=='COMPLETED'||progress?.failed||progress?.done!==progress?.total?'disabled':''));
  }
  if(run.reportId)controls+=button('Download original report',`type="button" data-report="${e(run.id)}" data-historical="${!!b.historical}"`);
  return card('Business gate and run controls',`<h3>${e(result.decision)}</h3><p>${e(run.status)} · ${e(progress?.done)} / ${e(progress?.total)} tasks completed</p>${b.historical?'<p class="notice">Original historical decision and review policy retained. A new evaluation is required for current eligibility.</p>':''}<ul>${(result.reasons||[]).map(r=>`<li>${e(readable(r))}</li>`).join('')}</ul><p>All three repetitions must clear. Confirmed critical failures block regardless of average scores; human acceptance cannot waive a failed deterministic control. Release evidence requires 90% overall and per category, no category regression, paired tests and all approvals.</p><div class="actions">${controls}${link(`/operations?tab=reviews&run=${encodeURIComponent(run.id)}`,'Review findings')}</div>`)+
    recordedOutcomes(result)+card('Saved configuration',`<dl>${['baseline','candidate','judge'].map(role=>`<dt>${e(roleLabel(role))}</dt><dd>${e(b.snapshot.modelMetadata?.[role]?.displayName)}</dd>`).join('')}<dt>Policy</dt><dd>${e(b.snapshot.policy?.version)}</dd><dt>Examples</dt><dd>${e(b.snapshot.dataset?.version)}</dd></dl>${details('Frozen instructions',pre(b.snapshot.prompt))}`)+
    card('Human review audit',audit(b.reviews))+details('Technical details: execution history, approvals and frozen inputs',pre({runner:b.snapshot.runner,fingerprints:{dataset:b.snapshot.datasetDigest,prompt:b.snapshot.promptDigest,policy:b.snapshot.policyDigest,engine:b.snapshot.engineDigest},attempts:b.attempts,approvals:b.evidenceDocs}));
}
const percent=v=>Number.isFinite(v)?(v*100).toFixed(1)+'%':'Not recorded';
function recordedOutcomes(result){
  const rows=['baseline','candidate'].map(role=>{
    const saved=result.outcomes?.[role];
    if(!saved)return `<h3>${e(roleLabel(role))}</h3><p>Original saved case pass rate: ${percent(result[role])}. Response outcomes: Not recorded. Review coverage: Not recorded.</p>`;
    const counts=c=>c?`${c.pass} Pass · ${c.fail} Fail · ${c.needsReview} Needs review (${c.total} planned)`:'Not recorded';
    return `<h3>${e(roleLabel(role))}</h3><p>Responses: ${e(counts(saved.responses))}</p><p>Cases: ${e(counts(saved.cases))}</p><p>${saved.reviews?`${saved.reviews.resolved} of ${saved.reviews.required} required reviews resolved; ${saved.reviews.pending} pending.`:'Review coverage: Not recorded'}</p>`;
  }).join('');
  return card('Recorded outcomes',rows+'<p>A response may have a confirmed failure and a pending finding. Pending evidence does not count as passed.</p>')+
    card('Categories',`<dl>${Object.entries(result.categories||{}).map(([name,c])=>`<dt>${e(name)}</dt><dd>Baseline ${result.complete?percent(c.baseline):'Unresolved or incomplete'} · Candidate ${result.complete?percent(c.candidate):'Unresolved or incomplete'}</dd>`).join('')}</dl>`);
}
function reviews(queue,bundle){
  return queue.length?'<label>Search examples<input id="review-search" type="search" placeholder="Example number, case ID or category"></label><p id="review-count" role="status">'+queue.length+' review items shown.</p>'+queue.map(q=>{
    const output=bundle?.outputs?.find(o=>o.id===q.outputId)||q,locked=q.historical||q.reviewReady===false;
    const controls=locked?`<p>${q.historical?'Original review policy retained. Prepare a new evaluation for current review.':'Both valid recorded judge assessments are required before review.'}</p>`:
      form('/api/reviews',hidden('runId',q.runId)+hidden('outputId',q.outputId)+reason()+['CONFIRM_CRITICAL','REJECT_OUTPUT','ACCEPT_OUTPUT'].map(resolution=>button(({CONFIRM_CRITICAL:'Confirm critical failure',REJECT_OUTPUT:'Reject answer',ACCEPT_OUTPUT:'Accept disputed answer'})[resolution],`name="resolution" value="${resolution}"${resolution==='ACCEPT_OUTPUT'&&q.checks?.some(c=>c.status!=='PASS'&&c.confirmed)?' disabled':''}`)).join(''));
    return card(`${caseLabel(q,q.caseIndex)} · ${roleLabel(q.role)} · repetition ${(q.repeat??0)+1}`,`<p>${q.critical?'Confirmed critical failure':q.disagreement?'Judges disagree; both explanations are retained':'Needs human review'}</p>${q.optimization?details('Saved practice facts and answer',pre(q.caseFacts)+pre(q.response)):link(caseResultsUrl(q),'Compare invoice facts and both models in Promptfoo')}<h3>Programmed findings</h3>${findingsHTML({...output,checks:q.checks})}<h3>Original judge evidence</h3>${judgesHTML(q.judges)}${controls}${details('Review audit',audit((bundle?.reviews||[]).filter(r=>r.outputId===q.outputId)))}`,`data-review-item data-case-index="${Number.isInteger(q.caseIndex)?q.caseIndex:''}" data-case-id="${e(q.caseId||'')}" data-category="${e(q.category||'')}"`);
  }).join(''):card('Human reviews','<p>No pending review items in this selection. This does not establish release eligibility.</p>');
}
function optimizationJobsHTML(jobs,proposals=[]){
  jobs=jobs.filter(job=>!job.hidden);
  const drafts=job=>{
    const result=proposals.find(p=>p.parentId===job.id);
    return(job.candidates||[]).map((c,index)=>{
      const stats=result?.selection?.candidates?.find(s=>s.text?.trim()===c.text?.trim());
      const selected=result?.changed===true&&result.text?.trim()===c.text?.trim();
      const status=result?(selected?'Selected':'Not selected'):job.status==='RUNNING'?'Testing':job.status==='COMPLETED'?'Result not recorded':'Evaluation incomplete';
      const label=(job.candidates.length===1?'Generated prompt':`Generated draft ${index+1}`)+` · ${status}`+(Number.isInteger(stats?.passed)&&Number.isInteger(result?.selection?.validationCases)?` · ${stats.passed}/${result.selection.validationCases} validation cases`:'');
      const id=`generated-prompt-${job.id}-${c.id||index}`;
      return details(label,`<h4>Generated prompt</h4>${button('Copy prompt',`type="button" data-copy-prompt="${e(id)}"`)}<pre id="${e(id)}">${e(value(c.text))}</pre>`);
    }).join('');
  };
  const visible=jobs.filter(job=>!job.archived).map(job=>{
    const used=job.callAttempts||0,limit=job.limits?.maxCalls,remaining=job.remainingCalls??(Number.isFinite(limit)?Math.max(0,limit-used):null),exhausted=remaining===0&&!job.proposalDone;
    let actions='';
    if(job.status==='RUNNING')actions=form(`/api/runs/${job.id}/cancel`,button('Cancel new work'));
    else{
      if(exhausted)actions+='<p>Call budget exhausted.</p>';
      else if(job.optimizerCurrent===false)actions+='<p>Evaluator updated. Prepare a new optimization job.</p>';
      else if(['INCOMPLETE','CANCELLED'].includes(job.status))actions+=form(`/api/runs/${job.id}/resume`,button('Resume with remaining call limit'));
      actions+=form(`/api/improvements/${job.id}/archive`,hidden('reason','Archived from the prompt optimization view.')+button('Archive'));
    }
    const errors=job.evaluationErrors?.length?details(`Format errors (${job.evaluationFailures||0})`,pre(job.evaluationErrors)):'';
    return card(`${e(job.optimizer||'Not recorded')} · ${e(job.status)}`,`<p>${used}/${e(limit)} calls started · ${job.recordedResults||0} saved · ${job.activeCalls||0} running${remaining!==null?` · ${remaining} remaining`:''}</p><p>${job.uncertainCalls||0} uncertain · ${job.evaluationFailures||0} format failures</p>${actions}${(job.errors||[]).filter(error=>!(exhausted&&['GEPA_CALL_LIMIT','OPTIMIZATION_BUDGET_EXHAUSTED'].includes(error.code))).map(error=>`<p>${e(error.message)}</p>`).join('')}${errors}${drafts(job)}`);
  }).join('');
  const archived=jobs.filter(job=>job.archived);
  return visible+(archived.length?details(`Archived optimization jobs (${archived.length})`,archived.map(job=>{
    const date=job.createdAt?new Date(job.createdAt):null,label=date&&!Number.isNaN(date.valueOf())?date.toLocaleString('en-IN',{timeZone:'Asia/Calcutta'}):'Date not recorded';
    return `<section class="optimization-job" data-optimization-job="${e(job.id)}"><h3>${e(job.optimizer)} · ${e(job.status)}</h3><p>${e(label)} · ${job.callAttempts||0}/${e(job.limits?.maxCalls)} calls</p>${drafts(job)}</section>`;
  }).join('')):'');
}
function prompts(boot){
  const manual=card('Save a prompt revision',form('/api/prompts',field('Version',input('version','required'))+field('Parent prompt',select('parentId',boot.prompts.map(p=>[p.id,promptLabel(p)])))+field('Complete instructions','<textarea name="text" minlength="40" maxlength="20000" required rows="8"></textarea>')+button('Save revision')));
  const developmentRuns=boot.runs.filter(r=>r.kind==='development'&&r.engineCurrent!==false&&['COMPLETED','INCOMPLETE'].includes(r.status));
  const optimization=card('Promptfoo prompt optimization',form('/api/improvements',field('Development run',`<select name="sourceRunId" required>${developmentRuns.map(r=>`<option value="${e(r.id)}"${Number.isInteger(r.caseCount)?` data-case-count="${r.caseCount}"`:''}>${e(testLabel(r))}</option>`).join('')}</select>`)+field('Maximum case evaluations (24–120)',input('limits.maxCaseEvaluations','type="number" min="24" max="120" value="48" required'))+field('Maximum proposals (1–6)',input('limits.maxProposals','type="number" min="1" max="6" value="3" required'))+field('Retest an acceptable revision',input('autoRetest','type="checkbox" checked'))+'<p id="optimization-estimate">Up to 435 optimization requests with the default limits, plus 18 retest requests per development case when enabled. The backend enforces the frozen call budget. Suggested prompts require approval and never activate automatically.</p>'+button('Suggest improvements and evaluate'),'job'));
  const jobs=optimizationJobsHTML(boot.optimizationJobs||[],boot.proposals||[]);
  return manual+optimization+jobs+boot.prompts.map(p=>card(promptLabel(p),`<p>${p.generated?'Optimizer-selected prompt':p.parentId?'Manual revision':'Original instructions'}</p>`+pre(p.text)+(p.generated&&!boot.promptApprovals.some(a=>a.parentId===p.id&&a.approved)?form('/api/prompts/approve',hidden('promptId',p.id)+reason()+button('Approve for future selection')):''))).join('')+
    (boot.proposals||[]).map(p=>card('Optimization result',`<p>${e(p.rationale)}</p><p>${p.changed===false?'Original instructions retained':'Requires human approval before selection'}</p>${details('Prompt changes',(p.diff||[]).map(d=>`<p>${e(d.type)}: ${e(d.text)}</p>`).join(''))}${boot.retestLinks.filter(l=>l.parentId===p.id&&l.runId).map(l=>link(`/eval/${encodeURIComponent(l.runId)}`,'Open development retest')).join('')}`)).join('');
}
function approvals(boot){
  return card('Record a completed business review',form('/api/evidence',field('Approval type',select('type',[['labels','Reference labels'],['calibration','Judge calibration'],['release','Release evidence']]))+field('Reviewed dataset or run',select('targetId',[...boot.datasets.map(d=>[d.id,`${d.version} · dataset`]),...boot.runs.map(r=>[r.id,testLabel(r)])]))+field('Review reference',input('sourceId','required'))+reason()+field('Decision',select('approved',[['true','Approved'],['false','Not approved']]))+button('Save approval decision')))+card('Service connections',button('Check connections (no inference)', 'type="button" data-status')+'<pre id="connection-status">Not checked</pre>');
}
function history(boot,rows){
  const saved=rows||boot.runs.filter(r=>r.kind!=='improvement');
  return card('Saved Oracle evaluations',`<ul>${saved.map(r=>`<li>${link(`/eval/${encodeURIComponent(r.id)}`,testLabel(r))} · ${e(r.status)} ${r.decision?'· '+e(r.decision):''} ${link(`/operations?tab=run&run=${encodeURIComponent(r.id)}`,'Run controls')}${r.reasons?`<ul>${r.reasons.map(reason=>`<li>${e(readable(reason))}</li>`).join('')}</ul>`:''}${r.improvements===null?'<p>Comparisons unresolved or incomplete</p>':Array.isArray(r.improvements)?`<p>${r.improvements.length} measured improvements; ${r.regressions?.length??'Not recorded'} regressions.</p>`:''}</li>`).join('')}</ul>`);
}
export function renderOperations({boot,tab='setup',bundle,queue=[],history:rows}){
  const tabs=[['setup','Prepare test'],['history','History'],['reviews','Human reviews'],['prompts','Prompt optimization'],['approvals','Approvals']];
  const body=tab==='setup'?setup(boot):tab==='run'?runControls(bundle):tab==='reviews'?reviews(queue,bundle):tab==='prompts'?prompts(boot):tab==='approvals'?approvals(boot):history(boot,rows);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Invoice controls · Promptfoo</title><link rel="stylesheet" href="/aie/operations.css"><script type="module" src="/aie/operations.js"></script></head><body data-operations data-active="${bundle?.run.status==='RUNNING'||boot.optimizationJobs?.some(j=>j.status==='RUNNING')}"><header>${link('/eval','Promptfoo results')}<strong>Invoice evaluation controls</strong></header><nav>${tabs.map(([id,label])=>link(`/operations?tab=${id}${bundle?'&run='+encodeURIComponent(bundle.run.id):''}`,label)).join('')}</nav><main><p id="operation-status" role="status"></p>${body}</main></body></html>`;
}
