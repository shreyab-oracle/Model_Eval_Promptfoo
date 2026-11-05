import {chat} from '../oracle/genai.mjs';
import {safeError} from '../config.mjs';

// Supported ApiProvider contract. The bound request bypasses template rendering:
// frozen messages and settings reach the existing OCI adapter byte-for-byte.
export class OciTaskProvider {
  handlesOwnRetries=true;
  config={maxRetries:0};
  calls=0;
  constructor({request,identity={},call=chat,onReceived=async()=>{},guard=async()=>{},receivedResponse}){
    Object.assign(this,{request,identity,call,onReceived,guard,receivedResponse});
  }
  id(){return `oci-durable:${this.identity.taskId||'request'}:${this.identity.attemptId||'replay'}`;}
  async callApi(){
    try{
      if(this.calls++)throw Object.assign(new Error('A durable attempt cannot invoke its provider twice'),{code:'DUPLICATE_PROVIDER_CALL'});
      await this.guard();
      this.response=this.receivedResponse||await this.call(this.request);
      // Even cancellation immediately after the response must retain this receipt.
      if(!this.receivedResponse)await this.onReceived(this.response);
      await this.guard();
      const usage=this.response.usage;
      return{output:this.response.text,cached:false,
        ...(usage?{tokenUsage:{prompt:usage.promptTokens??usage.inputTokens??usage.prompt,
          completion:usage.completionTokens??usage.outputTokens??usage.completion,
          total:usage.totalTokens??usage.total}}:{}),
        metadata:{...this.identity,requestId:this.response.requestId,latencyMs:this.response.latencyMs}};
    }catch(error){this.error=error;return{error:safeError(error).message,cached:false};}
  }
}
