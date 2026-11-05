import {repository} from '../db/repository.mjs';
import {config,publicConfig} from '../config.mjs';
import {seedVersions,generateAndImport,importDataset,approveEvidence} from '../services/datasets.mjs';
import {createRun,startRun,resumeRun,comparison,writeReport,reviewOutput,reviewQueue,runBundle} from '../services/runs.mjs';
import {createPrompt,approvePrompt,proposeImprovement} from '../services/prompts.mjs';
import {connectionStatus} from '../services/status.mjs';
import {getJSON} from '../oracle/storage.mjs';
import {evaluationHistory,optimizationHistory} from '../services/history.mjs';
import {ENGINE_DIGEST} from '../domain/version.mjs';
import {releaseGate} from '../services/release-gate.mjs';
export async function route(method,pathname,body,sessionToken){
  const actor=config.reviewer;
  if(method==='GET'&&pathname==='/api/bootstrap'){
    await seedVersions();const [datasets,prompts,policies,runs,allProposals,promptApprovals,allRetestLinks]=await Promise.all([repository.docs('DATASET'),repository.docs('PROMPT'),repository.docs('POLICY'),repository.runs(),repository.docs('PROPOSAL'),repository.docs('PROMPT_APPROVAL'),repository.docs('RETEST_LINK')]);
    const visible=new Set(runs.map(r=>r.id)),proposals=allProposals.filter(p=>visible.has(p.parentId)),proposalIds=new Set(proposals.map(p=>p.id)),retestLinks=allRetestLinks.filter(l=>proposalIds.has(l.parentId));
    const choices=await Promise.all(runs.map(async r=>{if(r.kind!=='development')return r;const snapshot=(await repository.doc(r.manifestId))?.snapshot;return{...r,caseCount:snapshot?.dataset?.cases?.length,engineCurrent:snapshot?.engineDigest===ENGINE_DIGEST};}));
    return{token:sessionToken,datasets:datasets.map(({dataset,artifact,...d})=>({...d,kind:dataset.kind,caseCount:dataset.cases.length,labelStatus:dataset.labelStatus,seed:dataset.seed,artifact})),prompts,policies,runs:choices,proposals,promptApprovals,retestLinks,optimizationJobs:await optimizationHistory(runs),configuration:publicConfig()};
  }
  if(method==='GET'&&pathname==='/api/status')return connectionStatus();
  if(method==='GET'&&pathname==='/api/reviews')return reviewQueue();
  if(method==='GET'&&pathname==='/api/history')return evaluationHistory();
  const gateMatch=pathname.match(/^\/api\/runs\/([^/]+)\/gate$/);
  if(method==='GET'&&gateMatch)return releaseGate(gateMatch[1]);
  const datasetMatch=pathname.match(/^\/api\/datasets\/([^/]+)$/);if(method==='GET'&&datasetMatch){const d=await repository.doc(datasetMatch[1]);if(d?.kind!=='DATASET')throw Object.assign(new Error('Dataset not found'),{statusCode:404});return d;}
  const runMatch=pathname.match(/^\/api\/runs\/([^/]+)(?:\/(start|resume|cancel|report))?$/);
  if(runMatch){const [,id,action]=runMatch;
    if(method==='GET'&&!action)return comparison(id);
    if(method==='GET'&&action==='report'){const run=await repository.run(id),doc=run?.reportId&&await repository.doc(run.reportId);if(!doc)throw Object.assign(new Error('No report has been saved for this run'),{statusCode:404});return{report:await getJSON(doc.artifact),artifact:doc.artifact,current:doc.report.inputDigest===(await runBundle(id)).inputDigest};}
    if(method==='POST'&&action==='start')return startRun(id);
    if(method==='POST'&&action==='resume')return resumeRun(id);
    if(method==='POST'&&action==='cancel'){await repository.cancel(id);return{cancelled:true};}
    if(method==='POST'&&action==='report')return writeReport(id);
  }
  const traceMatch=pathname.match(/^\/api\/runs\/([^/]+)\/attempts\/([^/]+)\/trace$/);
  if(method==='GET'&&traceMatch){const attempt=(await repository.attempts(traceMatch[1])).find(a=>a.id===traceMatch[2]);if(!attempt?.trace)throw Object.assign(new Error('Attempt has no persisted trace; see its recorded execution error'),{statusCode:404});return getJSON(attempt.trace);}
  if(method==='POST'&&pathname==='/api/datasets'){
    if(body.dataset)return importDataset(body.dataset);
    if(!['release','development'].includes(body.kind)||!Number.isInteger(body.seed)||typeof body.version!=='string'||!body.version.trim()||body.version.length>120)throw new Error('Dataset kind, integer seed and version (1–120 characters) are required');
    return generateAndImport({kind:body.kind,seed:body.seed,version:body.version});
  }
  if(method==='POST'&&pathname==='/api/runs')return createRun(body);
  if(method==='POST'&&pathname==='/api/reviews')return{id:await reviewOutput({...body,actor})};
  if(method==='POST'&&pathname==='/api/evidence')return{id:await approveEvidence({...body,actor})};
  if(method==='POST'&&pathname==='/api/prompts')return{id:await createPrompt({...body,actor})};
  if(method==='POST'&&pathname==='/api/prompts/approve')return{id:await approvePrompt({...body,actor})};
  if(method==='POST'&&pathname==='/api/improvements')return proposeImprovement({...body,actor});
  throw Object.assign(new Error('API route not found'),{statusCode:404});
}
