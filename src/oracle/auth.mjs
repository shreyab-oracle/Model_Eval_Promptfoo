import fs from 'node:fs';
import https from 'node:https';
import {createPrivateKey,sign,createHash} from 'node:crypto';
import {config} from '../config.mjs';
let identity;
function getIdentity(){
  if(identity)return identity;
  const profiles={};let profile;
  for(const line of fs.readFileSync(config.ociConfig,'utf8').split(/\r?\n/)){
    const section=line.trim().match(/^\[([^\]]+)\]$/);if(section){profile=section[1];profiles[profile]={};continue;}
    const pair=line.match(/^\s*([^#;=]+?)\s*=\s*(.*?)\s*$/);if(pair&&profile)profiles[profile][pair[1]]=pair[2];
  }
  const c=profiles[config.profile];if(!c)throw new Error(`OCI profile ${config.profile} not found`);
  for(const k of ['tenancy','user','fingerprint','key_file'])if(!c[k])throw new Error(`OCI profile missing ${k}`);
  identity={...c,key:createPrivateKey({key:fs.readFileSync(c.key_file),passphrase:process.env.OCI_KEY_PASSPHRASE})};return identity;
}
// OCI HTTP Signature v1, documented at docs.oracle.com/.../Concepts/signingrequests.htm.
// Model calls have no implicit retries; the durable worker records each attempt.
export function retryAfterMilliseconds(value,now=Date.now()){
  if(typeof value!=='string'||!value.trim())return undefined;
  const seconds=Number(value);
  if(Number.isFinite(seconds))return seconds>=0?Math.min(300000,seconds*1000):undefined;
  const timestamp=Date.parse(value);return Number.isFinite(timestamp)?Math.min(300000,Math.max(0,timestamp-now)):undefined;
}
export async function ociRequest(method,url,{body,timeoutMs=30000,headers:extra={}}={}){
  const u=new URL(url);if(u.protocol!=='https:'||!u.hostname.endsWith('.oraclecloud.com'))throw new Error('OCI requests require an HTTPS oraclecloud.com endpoint');
  const id=getIdentity(),date=new Date().toUTCString(),headers={host:u.host,date,...extra};
  const names=['(request-target)','host','date'],lines=[`(request-target): ${method.toLowerCase()} ${u.pathname}${u.search}`,`host: ${u.host}`,`date: ${date}`];
  const payload=body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body);
  if(payload!==undefined){headers['content-type']='application/json';headers['content-length']=Buffer.byteLength(payload);headers['x-content-sha256']=createHash('sha256').update(payload).digest('base64');for(const n of ['x-content-sha256','content-type','content-length']){names.push(n);lines.push(`${n}: ${headers[n]}`);}}
  headers.authorization=`Signature version="1",keyId="${id.tenancy}/${id.user}/${id.fingerprint}",algorithm="rsa-sha256",headers="${names.join(' ')}",signature="${sign('RSA-SHA256',Buffer.from(lines.join('\n')),id.key).toString('base64')}"`;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>req.destroy(Object.assign(new Error(`OCI request exceeded ${timeoutMs} ms`),{code:'ETIMEDOUT'})),timeoutMs);
    const req=https.request(u,{method,headers},res=>{let value='';res.setEncoding('utf8');res.on('data',c=>{value+=c;if(value.length>20*1024*1024)req.destroy(new Error('OCI response exceeds 20 MiB limit'));});res.on('error',error=>{clearTimeout(timer);reject(error);});res.on('end',()=>{clearTimeout(timer);let data;try{data=value?JSON.parse(value):null;}catch{data=value;}
      if(res.statusCode<200||res.statusCode>=300){const e=Object.assign(new Error(data?.message||`OCI HTTP ${res.statusCode}`),{code:data?.code||`HTTP_${res.statusCode}`,statusCode:res.statusCode,requestId:res.headers['opc-request-id'],retryAfterMs:retryAfterMilliseconds(res.headers['retry-after'])});reject(e);}else resolve({data,headers:res.headers,statusCode:res.statusCode});});});
    req.on('error',e=>{clearTimeout(timer);reject(e);});req.end(payload);
  });
}
