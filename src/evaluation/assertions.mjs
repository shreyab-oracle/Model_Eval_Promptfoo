import {observeModelAnswer} from '../services/model-answer.mjs';
import {parseJSON} from '../domain/checks.mjs';
import {AXES,validateJudge,judgePass} from '../domain/judge.mjs';
import {expectedFor,sourceIds} from '../domain/policy.mjs';
import {recordedFindings} from './findings.mjs';

export function parseJudgeAssessment(text,response){
  try{return validateJudge(parseJSON(text),response);}
  catch(error){throw Object.assign(error,{code:'INVALID_JUDGE_ASSESSMENT'});}
}

export function invoiceAssertion(c,{policyReference=null,evaluatorVersion=null}={}){
  return{type:'javascript',value:text=>{
    const business=observeModelAnswer(c,text),checks=business.checks,pass=checks.every(c=>c.status==='PASS');
    const findings=recordedFindings(checks,{response:business.response,expected:expectedFor(c),validSources:sourceIds(c),policyReference,evaluatorVersion});
    return{pass,score:pass?1:0,reason:pass?'Invoice checks passed':'Invoice findings require the business gate',
      metadata:{business,findings},componentResults:findings.map(finding=>({pass:finding.status==='PASS',score:finding.status==='PASS'?1:0,
        reason:finding.explanation,namedScores:{[finding.checkId]:finding.status==='PASS'?1:0},metadata:{finding}}))};
  }};
}

export function judgeAssertion(evaluatedOutput,state){
  return{type:'javascript',value:text=>{
    let assessmentResult;
    try{assessmentResult=parseJudgeAssessment(text,evaluatedOutput);}
    catch(error){state.error=error;return{pass:false,score:0,reason:error.message,metadata:{invalidJudgment:true}};}
    const pass=judgePass(assessmentResult);
    return{pass,score:pass?1:0,reason:assessmentResult.rationale,
      namedScores:Object.fromEntries(AXES.map(axis=>[axis,assessmentResult.scores[axis]])),
      metadata:{business:{assessmentResult}}};
  }};
}
