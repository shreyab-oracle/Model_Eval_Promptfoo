export const categories={routine:'Matching invoices',tolerance:'Price limits',payment:'Payment controls',records:'Missing or conflicting records',pressure:'Supplier pressure'};
export const purpose=kind=>kind==='development'?'Practice test':kind==='improvement'?'Instruction improvement':'Final comparison';
const dateLabel=value=>value?new Date(value).toLocaleString('en-IN',{timeZone:'Asia/Calcutta'}):'Date unavailable';
export const testLabel=run=>purpose(run.kind)+' · '+dateLabel(run.createdAt);
export const promptLabel=p=>p?.version&&!/[a-f0-9]{8,}/i.test(p.version)?p.version:(p?.generated?'Suggested instructions':'Saved instructions');
export const caseLabel=(c,index)=>((Number.isInteger(index)?'Example '+(index+1)+' · ':'')+(categories[c.category]||'Invoice review'));
export function filterReviewExamples(items,query){
  const text=query.trim().toLowerCase();if(!text)return items;
  const number=text.match(/^(?:example\s*)?(\d+)$/);
  if(number)return items.filter(item=>Number.isInteger(item.caseIndex)&&item.caseIndex+1===Number(number[1]));
  return items.filter(item=>[item.caseId,caseLabel(item,item.caseIndex)].some(value=>String(value||'').toLowerCase().includes(text)));
}
export const roleLabel=role=>role==='baseline'?'Current model':role==='candidate'?'New model':'AI reviewer';
const words={NO_MATCHING_EXCEPTION:'No matching problem found',RETAIN_HOLD:'Keep the invoice on hold',REQUEST_EVIDENCE:'Ask for missing information',UNKNOWN:'Not verified',VERIFIED_PAID:'Payment verified',VERIFIED_RELEASED:'Hold release verified',MISSING_PO:'Missing purchase order',MISSING_RECEIPT:'Missing receipt',DUPLICATE:'Duplicate invoice',OVER_ORDERED:'Billed quantity exceeds the order',OVER_RECEIVED:'Billed quantity exceeds the receipt',PRICE_TOLERANCE:'Price increase needs review',RECORD_CONFLICT:'Conflicting records'};
export function readable(value){
  if(typeof value!=='string')return value==null?'Not available':typeof value==='object'?'Unreadable value':String(value);
  if(words[value])return words[value];
  if(/Frozen evaluation engine differs|(?:GEPA|Prompt optimizer) integration changed/.test(value))return 'This test was prepared before an application update. Prepare a new test.';
  if(/labels evidence approval is pending/.test(value))return 'A person must approve the example answers.';
  if(/calibration evidence approval is pending/.test(value))return 'A person must check the AI reviewer against reviewed examples.';
  if(/release evidence approval is pending/.test(value))return 'Final business approval is still needed.';
  return value.replace(/ocid1\.[\w.-]+/gi,'configured resource').replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,'saved record').replace(/\b[0-9a-f]{32,}\b/gi,'saved reference').replace(/\bOCI\b/g,'model service').replace(/\bOracle\b/g,'data service').replace(/\bObject Storage\b/g,'saved files').replace(/\bartifacts\b/gi,'saved results').replace(/\bmanifest\b/gi,'test settings').replace(/\bimmutable\b/gi,'saved').replaceAll('billedTotalCents','billed total (cents)').replaceAll('quantityDiscrepancy','quantity difference').replaceAll('discrepancyAmountCents','difference value (cents)').replaceAll('priceDeltaCents','price change (cents)').replace(/\b([A-Z]+(?:_[A-Z]+)+)\b/g,word=>words[word]||word.toLowerCase().replaceAll('_',' '));
}
export function currentReport(value){if(value?.current!==true||!value.report)throw new Error('This report is out of date. Select Check and save report, then download it again.');return value.report;}
