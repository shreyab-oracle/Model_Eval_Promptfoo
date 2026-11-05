import {parseJSON,checkOutput} from '../domain/checks.mjs';
export const MODEL_ANSWER_HANDLING_VERSION='received-answer-v1';

// An invalid answer is a measured failed observation, never a replacement call
// or a fabricated schema-valid wrapper. Missing/truncated responses stay errors.
export function observeModelAnswer(c,text){
  if(typeof text!=='string'||!text.trim())throw new Error('A nonempty received model answer is required');
  let response,parseError;
  try{response=parseJSON(text);}catch(error){response=text;parseError=error;}
  const checks=checkOutput(c,response),invalid=checks.some(check=>check.code==='STRUCTURED_OUTPUT'&&check.status==='FAIL');
  return{response,checks,...(invalid?{rawText:text,handlingVersion:MODEL_ANSWER_HANDLING_VERSION,modelContractFailure:{code:parseError?'INVALID_MODEL_JSON':'INVALID_OUTPUT_SCHEMA',message:parseError?.message||'The received answer violates the required structured response schema'}}:{})};
}
