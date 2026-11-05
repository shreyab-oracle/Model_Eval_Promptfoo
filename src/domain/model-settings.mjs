export function validateModelSettings(value){
  const family=value?.family||'openai';
  if(family==='openai'){
    if(!Number.isInteger(value?.maxCompletionTokens)||value.maxCompletionTokens<128||value.maxCompletionTokens>8192||!['LOW','MEDIUM','HIGH'].includes(value.verbosity))throw new Error('Invalid GPT model settings');
    return{family,maxCompletionTokens:value.maxCompletionTokens,verbosity:value.verbosity};
  }
  if(family!=='gemini')throw new Error('Unsupported model family');
  if(!Number.isInteger(value.maxTokens)||value.maxTokens<128||value.maxTokens>65536||!Number.isFinite(value.temperature)||value.temperature<0||value.temperature>2||!Number.isFinite(value.topP)||value.topP<=0||value.topP>1||!['frequencyPenalty','presencePenalty'].every(k=>Number.isFinite(value[k])&&value[k]>=-2&&value[k]<=2))throw new Error('Invalid Gemini model settings');
  if(value.topK!==undefined||(value.fixedTopK!==undefined&&value.fixedTopK!==64))throw new Error('Gemini 2.5 Top-K is fixed at 64; omit the topK request parameter');
  return{family,maxTokens:value.maxTokens,temperature:value.temperature,frequencyPenalty:value.frequencyPenalty,presencePenalty:value.presencePenalty,topP:value.topP,fixedTopK:64};
}
export function settingsForModel(metadata,defaults,frozen){
  const name=metadata.displayName?.toLowerCase()||'',vendor=metadata.vendor?.toLowerCase()||'';
  const family=name.includes('gemini-2.5')&&vendor==='google'?'gemini':vendor==='openai'||/^(openai\.|gpt-)/.test(name)?'openai':null;
  if(!family)throw new Error(`Unsupported model family: ${metadata.displayName||metadata.vendor}`);
  if(frozen&&frozen.family!==family)throw new Error('Frozen settings do not match the selected model family');
  return validateModelSettings(frozen||{...defaults[family],family});
}
export function settingsForRole(snapshot,role){
  if(snapshot.modelSettings){
    if(!snapshot.modelSettings[role])throw new Error(`Frozen ${role} model settings are missing`);
    return snapshot.modelSettings[role];
  }
  return role==='judge'?snapshot.judgeSettings:snapshot.settings;
}
