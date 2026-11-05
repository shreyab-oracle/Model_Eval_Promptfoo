// Use the native viewer's own API URL setting; no patched vendor bundle and no
// shared provider configuration. CSP confines the rebuildable viewer to this origin.
const workflowTabs={'/evals':'history','/history':'history','/setup':'setup','/prompts':'prompts','/datasets':'setup','/reports':'history'};
try{localStorage.setItem('api-config-storage',JSON.stringify({state:{apiBaseUrl:location.origin+'/promptfoo',persistApiBaseUrl:true},version:0}));}catch{}
if(workflowTabs[location.pathname])location.replace('/operations?tab='+workflowTabs[location.pathname]);
else if(location.pathname==='/')location.replace('/eval');
document.addEventListener('DOMContentLoaded',()=>{
  const toolbar=document.createElement('aside');toolbar.className='aie-toolbar';toolbar.setAttribute('aria-label','Invoice evaluation controls');
  const message=document.createElement('span');message.textContent='Saved Oracle results · choose an evaluation from History';toolbar.append(message);document.body.prepend(toolbar);
  const size=()=>document.documentElement.style.setProperty('--aie-toolbar-height',toolbar.offsetHeight+'px');new ResizeObserver(size).observe(toolbar);size();
  document.addEventListener('click',event=>{
    const anchor=event.target.closest('a');if(!anchor||event.ctrlKey||event.metaKey||event.shiftKey)return;
    const target=new URL(anchor.href,location.href);
    if(target.origin===location.origin&&workflowTabs[target.pathname]){event.preventDefault();event.stopPropagation();location.assign('/operations?tab='+workflowTabs[target.pathname]);}
  },true);
  const keys={REGRESSION:'newCandidateFailure',IMPROVEMENT:'candidateImprovement',CRITICAL:'confirmedCriticalFailure',REVIEW:'needsHumanReview',PENDING:'unresolved'};
  let current,reviewCounts,outcomes;
  const chartSelector='.relative.p-6.mt-2.bg-card > .flex.justify-between.w-full';
  function labelOutcomes(){
    for(const header of document.querySelectorAll('.output-header')){
      const role=header.querySelector('.provider')?.textContent.trim(),count=outcomes?.[role];
      let summary=header.querySelector('.aie-answer-summary');
      if(!summary){summary=document.createElement('div');summary.className='aie-answer-summary';header.append(summary);}
      const text=count?.total?`${(100*count.pass/count.total).toFixed(2)}% passed · ${count.pass}/${count.total} answers · ${count.fail} failed · ${count.needsReview} need review${count.incomplete?` · ${count.incomplete} incomplete`:''} · Whole run`:'Pass rate: Not recorded';
      if(summary.textContent!==text)summary.textContent=text;
      summary.title='Whole-run counts include every planned answer, including pending reviews and incomplete results. Case and search filters change the rows, not this overall rate.';
    }
    // Use the recorded whole-run outcomes instead of binary score charts.
    for(const container of document.querySelectorAll(chartSelector)){
      let chart=container.querySelector('.aie-outcome-chart');
      if(!chart){chart=document.createElement('section');chart.className='aie-outcome-chart';chart.setAttribute('aria-label','Answer outcomes');container.append(chart);}
      const signature=JSON.stringify(outcomes||null);if(chart.dataset.outcomes===signature)continue;
      chart.dataset.outcomes=signature;chart.replaceChildren();
      const heading=document.createElement('div');heading.className='aie-chart-heading';
      const title=document.createElement('strong');title.textContent='Answer outcomes';
      const scope=document.createElement('small');scope.textContent='Whole run';scope.title='Includes every planned answer. Table filters do not change these totals.';heading.append(title,scope);chart.append(heading);
      const statuses=[['pass','Passed'],['fail','Failed'],['needsReview','Needs review'],['incomplete','Incomplete']];
      for(const role of ['baseline','candidate']){
        const count=outcomes?.[role],row=document.createElement('div');row.className='aie-outcome-row';
        const label=document.createElement('div');label.className='aie-chart-heading';
        const name=document.createElement('strong');name.textContent=role==='baseline'?'Baseline':'Candidate';
        const rate=document.createElement('span');rate.textContent=count?.total?`${(100*count.pass/count.total).toFixed(2)}% passed · ${count.pass}/${count.total}`:'Not recorded';label.append(name,rate);row.append(label);
        if(count?.total){
          const bar=document.createElement('div');bar.className='aie-outcome-bar';bar.setAttribute('role','img');
          const counts=document.createElement('div');counts.className='aie-outcome-counts';
          const descriptions=[];
          for(const [key,label] of statuses){
            if(key==='incomplete'&&!count[key])continue;
            const text=`${count[key]} ${key==='needsReview'?'need review':label.toLowerCase()}`;descriptions.push(text);
            const item=document.createElement('span');item.className='aie-status-'+key;item.textContent=text;counts.append(item);
            if(count[key]){const segment=document.createElement('span');segment.className='aie-status-'+key;segment.style.width=(100*count[key]/count.total)+'%';segment.title=text;bar.append(segment);}
          }
          bar.setAttribute('aria-label',name.textContent+': '+descriptions.join(', '));row.append(bar,counts);
        }
        chart.append(row);
      }
    }
  }
  function labelReviews(){
    for(const header of document.querySelectorAll('.output-header')){
      const role=header.querySelector('.provider')?.textContent.trim(),button=header.querySelector('button.error-pill'),label=button?.querySelector('strong');
      if(!label)continue;
      const count=reviewCounts?.[role],total=Number(button.textContent.match(/:\s*([\d,]+)\s*$/)?.[1]?.replaceAll(',',''));
      const reviewOnly=count?.needsReview>0&&count.errors===0&&count.needsReview===total;
      const mixed=count?.needsReview>0&&count.errors>0&&count.needsReview+count.errors===total;
      const text=reviewOnly?'Needs review:':mixed?'Needs review / errors:':'Errors:';
      if(label.textContent!==text)label.textContent=text;
      button.title=reviewOnly?'Saved answers awaiting a final verdict. Click to show these answers.':mixed?`${count.needsReview} answers need review; ${count.errors} results are incomplete or have errors.`:'Incomplete results or execution errors.';
    }
  }
  function update(){
    if(current===location.pathname)return;current=location.pathname;reviewCounts=undefined;outcomes=undefined;labelReviews();labelOutcomes();
    if(workflowTabs[location.pathname]){location.assign('/operations?tab='+workflowTabs[location.pathname]);return;}
    const match=location.pathname.match(/^\/eval\/([^/]+)$/);
    toolbar.querySelector('select')?.remove();toolbar.querySelectorAll('[data-run-controls]').forEach(control=>control.remove());
    if(!match)return;
    const viewerId=decodeURIComponent(match[1]),link=document.createElement('a');link.dataset.runControls='true';link.href='/operations';link.textContent='Run, gate and review controls';toolbar.append(link);
    const filter=document.createElement('select');filter.setAttribute('aria-label','Filter invoice cases');
    for(const [id,label,help] of [
      ['ALL','All invoice cases','Every invoice case, with all repetitions.'],
      ['REGRESSION','Baseline passed; candidate failed','Settled cases: baseline passed all repetitions; candidate failed at least one.'],
      ['IMPROVEMENT','Candidate passed; baseline failed','Settled cases: candidate passed all repetitions; baseline failed at least one.'],
      ['CRITICAL','Cases with critical candidate failures','At least one confirmed critical candidate failure; other findings may still need review.'],
      ['REVIEW','Cases with pending human reviews','Either model has findings awaiting a person’s review, including cases that already failed.'],
      ['PENDING','Comparisons not final (review or incomplete)','A final comparison cannot be made: reviews are pending, results are missing, or the run is incomplete.']
    ]){const option=new Option(label,id);option.title=help;filter.add(option);}
    const url=new URL(location.href);
    try{
      const applied=JSON.parse(url.searchParams.get('filter')||'[]'),active=Object.keys(keys).find(key=>applied.some(f=>f.field===keys[key]&&f.value==='true'));
      if(!active&&applied.some(f=>f.field==='caseId')){const option=new Option('Selected invoice case','CASE');option.disabled=true;filter.add(option);filter.value='CASE';}
      else filter.value=active||'ALL';
    }catch{}
    filter.addEventListener('change',()=>{const next=new URL(location.href);if(filter.value==='ALL')next.searchParams.delete('filter');else next.searchParams.set('filter',JSON.stringify([{type:'metadata',operator:'equals',field:keys[filter.value],value:'true'}]));location.assign(next);});toolbar.append(filter);
    const requestedPath=location.pathname;
    fetch('/aie/viewer-context/'+encodeURIComponent(viewerId)).then(r=>r.json()).then(b=>{
      if(requestedPath!==location.pathname||!b.result)return;
      reviewCounts=b.reviewCounts;outcomes=b.outcomes;labelReviews();labelOutcomes();
      link.href='/operations?tab=run&run='+encodeURIComponent(b.oracleRunId);
      message.textContent=`${b.historical?'Historical gate':'Gate'}: ${b.result.decision} · ${b.result.criticalCandidateFailures??'Not recorded'} confirmed critical · ${b.result.pendingReviews??'Not recorded'} pending reviews`;
      message.title=(b.result.reasons||[]).join('\n');
      const refresh=document.createElement('a');refresh.href='/eval/'+encodeURIComponent(b.oracleRunId);refresh.textContent='Refresh';refresh.dataset.runControls='true';toolbar.append(refresh);
    }).catch(()=>{message.textContent='Gate: Not recorded · open run controls to check saved evidence';});
  }
  update();setInterval(()=>{update();labelReviews();labelOutcomes();},1000);
});
