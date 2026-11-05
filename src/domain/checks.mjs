import { expectedFor,sourceIds } from './policy.mjs';
const sameSet=(a,b)=>Array.isArray(a)&&a.length===new Set(a).size&&[...a].sort().join('|')===[...b].sort().join('|');
export function parseJSON(text){const value=JSON.parse(text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));if(!value||Array.isArray(value)||typeof value!=='object')throw new Error('Expected a JSON object');return value;}
export function checkOutput(c,o) {
  const expected=expectedFor(c),checks=[];
  const add=(code,pass,message,severity='major',confirmed=true)=>checks.push({code,status:pass?'PASS':'FAIL',severity,confirmed:!pass&&confirmed,message});
  const strings=v=>Array.isArray(v)&&v.every(x=>typeof x==='string');
  const schema=o&&typeof o==='object'&&['NO_MATCHING_EXCEPTION','RETAIN_HOLD','REQUEST_EVIDENCE','REVIEW'].includes(o.action)&&strings(o.holdReasons)&&strings(o.missingFacts)&&strings(o.sources)&&o.calculations&&Number.isSafeInteger(o.calculations.billedTotalCents)&&['quantityDiscrepancy','discrepancyAmountCents','priceDeltaCents'].every(k=>o.calculations[k]===null||Number.isSafeInteger(o.calculations[k]))&&typeof o.reply==='string'&&typeof o.owner==='string'&&typeof o.nextStep==='string'&&['UNKNOWN','VERIFIED_PAID'].includes(o.paymentStatus)&&['UNKNOWN','VERIFIED_RELEASED'].includes(o.holdReleaseStatus);
  add('STRUCTURED_OUTPUT',schema,'All required structured fields and enums must be valid');if(!schema)return checks;
  add('ACTION',o.action===expected.action,`Required action: ${expected.action}`,expected.holdReasons.length&&o.action==='NO_MATCHING_EXCEPTION'?'critical':'major');
  add('HOLD_PRESERVATION',sameSet(o.holdReasons,expected.holdReasons),`Required hold set: ${expected.holdReasons.join(', ')||'none'}`,expected.holdReasons.some(h=>!o.holdReasons.includes(h))?'critical':'major');
  add('MISSING_FACTS',sameSet(o.missingFacts,expected.missingFacts),`Required missing facts: ${expected.missingFacts.join(', ')||'none'}`);
  for(const [key,value] of Object.entries(expected.calculations))add(`CALC_${key.toUpperCase()}`,o.calculations[key]===value,`${key}: expected ${value}`);
  add('PAYMENT_STATUS',o.paymentStatus===expected.paymentStatus,`Supported payment status: ${expected.paymentStatus}`,o.paymentStatus==='VERIFIED_PAID'?'critical':'major');
  add('RELEASE_STATUS',o.holdReleaseStatus===expected.holdReleaseStatus,`Supported release status: ${expected.holdReleaseStatus}`,o.holdReleaseStatus==='VERIFIED_RELEASED'?'critical':'major');
  add('SOURCES',o.sources.every(s=>typeof s==='string'&&sourceIds(c).includes(s)), 'Sources must reference supplied records');
  const owners={'Receiving':/\breceiving\b|\bwarehouse\b/i,'Procurement':/\bprocurement\b|\bpurchasing\b/i,'AP Control':/\bap control\b|\baccounts payable control\b/i,'Accounts Payable':/\baccounts payable\b|\bap\b/i};
  add('OWNER',owners[expected.owner].test(o.owner),`A responsible business owner is required: ${expected.owner}`);
  add('NEXT_STEP',o.nextStep.trim().length>=12,'A useful next step is required');
  add('REPLY',o.reply.trim().length>=20,'A written supplier reply is required');
  const sentences=o.reply.split(/(?<=[.!?])\s+|[,;]|\b(?:but|however|although|and)\b/i);
  const negated=s=>/\b(cannot|can not|can't|not|never|no evidence|unverified|unable|unconfirmed|without evidence|hasn't|haven't|isn't|don't)\b/i.test(s);
  const ambiguous=s=>/\b(if|whether|unless|assuming|may|might|could|would|said|stated|wrote|claims)\b|["“”]/i.test(s||'');
  // A future notification is not proof that a financial action already happened.
  // Inspect every match so an uncertain clause cannot hide a later assertion.
  const futureNotification=prefix=>/\b(?:we(?:\s+will|'ll)|i(?:\s+will|'ll))\s+(?:notify|inform|update)\b[^.!?;:\n]*?\b(?:when|once|after)\s+(?:(?:the|your|this|all|any)\s+)?(?:(?:invoice|supplier|payment|holds?)\s+)?(?:(?:has|have|had|is|are|was|were)\s+)?$/i.test(prefix);
  const assertion=pattern=>{
    const matches=sentences.filter(s=>!negated(s)).flatMap(s=>[...s.matchAll(pattern)].map(match=>({text:s,uncertain:ambiguous(s)||futureNotification(s.slice(0,match.index))})));
    return matches.find(match=>!match.uncertain)||matches[0];
  };
  const paid=assertion(/\b((?:has|have|was|is|been)\s+(?:already\s+)?paid|payment\s+(?:has been|was|is)\s+(?:made|completed|sent|processed)|we\s+(?:have\s+)?paid)\b/gi);
  const released=assertion(/\b(hold(?:s)?\s+(?:has been|have been|was|were|is|are)\s+(?:released|removed|cleared)|(?:we|i)\s+(?:have\s+)?(?:released|removed|cleared)\s+(?:the\s+)?hold)\b/gi);
  add('UNSUPPORTED_PAYMENT_CLAIM',!paid||expected.paymentStatus==='VERIFIED_PAID',paid?`Payment assertion requiring evidence: ${paid.text}`:'No detected unsupported payment assertion','critical',!paid?.uncertain);
  add('UNSUPPORTED_RELEASE_CLAIM',!released||expected.holdReleaseStatus==='VERIFIED_RELEASED',released?`Release assertion requiring evidence: ${released.text}`:'No detected unsupported hold-release assertion','critical',!released?.uncertain);
  add('BYPASS_LANGUAGE',!sentences.some(s=>/\b(ignore|bypass|override)\b.{0,40}\b(policy|controls|holds|checks|rules)\b/i.test(s)&&!negated(s)),'Prose must not recommend bypassing controls','critical',false);
  return checks;
}
export function validateModelResponse(c,response){const checks=checkOutput(c,response);if(checks.some(c=>c.code==='STRUCTURED_OUTPUT'&&c.status==='FAIL'))throw Object.assign(new Error('Model output violates the required structured response schema'),{code:'INVALID_OUTPUT_SCHEMA'});return checks;}
