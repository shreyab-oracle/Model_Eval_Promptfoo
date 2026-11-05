// Presentation of recorded checks only. This module never evaluates a policy,
// calls a model, or changes the checks used by the business gate.
const fields={ACTION:'action',HOLD_PRESERVATION:'holdReasons',MISSING_FACTS:'missingFacts',PAYMENT_STATUS:'paymentStatus',RELEASE_STATUS:'holdReleaseStatus',SOURCES:'sources',OWNER:'owner',NEXT_STEP:'nextStep',REPLY:'reply',UNSUPPORTED_PAYMENT_CLAIM:'reply',UNSUPPORTED_RELEASE_CLAIM:'reply',BYPASS_LANGUAGE:'reply'};
const calculations={BILLEDTOTALCENTS:'billedTotalCents',QUANTITYDISCREPANCY:'quantityDiscrepancy',DISCREPANCYAMOUNTCENTS:'discrepancyAmountCents',PRICEDELTACENTS:'priceDeltaCents'};
const names={STRUCTURED_OUTPUT:'Output schema',ACTION:'Required invoice action',HOLD_PRESERVATION:'Required holds preserved',MISSING_FACTS:'Missing or conflicting records',PAYMENT_STATUS:'Trusted payment evidence',RELEASE_STATUS:'Trusted hold-release evidence',SOURCES:'Source validity',OWNER:'Responsible owner',NEXT_STEP:'Clear next step',REPLY:'Supplier reply present',UNSUPPORTED_PAYMENT_CLAIM:'Payment claims in reply',UNSUPPORTED_RELEASE_CLAIM:'Hold-release claims in reply',BYPASS_LANGUAGE:'Supplier instruction resistance (language check)'};
const calculationNames={billedTotalCents:'Billed total (cents)',quantityDiscrepancy:'Quantity discrepancy',discrepancyAmountCents:'Discrepancy amount (cents)',priceDeltaCents:'Unit price difference (cents)'};
export const checkName=code=>names[code]||calculationNames[calculations[code?.replace(/^CALC_/,'')]]||code||'Unnamed check';
const at=(value,path)=>path?.split('.').reduce((v,key)=>v?.[key],value);
const recorded=value=>value===undefined?null:value;

export function recordedFindings(checks,{response,expected,validSources,policyReference=null,evaluatorVersion=null}={}){
  return (checks||[]).map(check=>{
    const calculation=calculations[check.code?.replace(/^CALC_/,'')];
    const field=calculation?`calculations.${calculation}`:fields[check.code]||null;
    const pending=check.status==='NEEDS_REVIEW'||(check.status==='FAIL'&&check.confirmed!==true);
    const actual=check.code==='STRUCTURED_OUTPUT'?response:at(response,field);
    // Free-text requirements are already recorded in the check message. Do not
    // synthesize an expected answer or reinterpret old findings using new rules.
    const expectedValue=check.code==='SOURCES'?validSources:['NEXT_STEP','REPLY','UNSUPPORTED_PAYMENT_CLAIM','UNSUPPORTED_RELEASE_CLAIM','BYPASS_LANGUAGE','STRUCTURED_OUTPUT'].includes(check.code)?check.message:at(expected,field);
    return{checkId:check.code,name:checkName(check.code),status:pending?'NEEDS_REVIEW':check.status,
      severity:check.severity??null,ruleReference:policyReference,expected:recorded(expectedValue),actual:recorded(actual),
      expectedRecorded:expectedValue!==undefined,actualRecorded:actual!==undefined,
      evidence:{field,excerpt:field==='reply'&&typeof actual==='string'?actual:null},
      explanation:check.message??null,confirmed:check.status==='FAIL'&&check.confirmed===true,
      requiresHumanReview:pending,evaluatorVersion};
  });
}

export function outputFindings(output,{evaluatorVersion=null,policyReference=null}={}){
  return output.evaluation?.findings||recordedFindings(output.checks,{response:output.response,evaluatorVersion,policyReference});
}
