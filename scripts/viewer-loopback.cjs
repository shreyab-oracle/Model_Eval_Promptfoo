// The pinned `promptfoo view` CLI has no bind-address option. Restrict its
// documented Node listener to loopback, so its import API is never exposed on
// the network. Only the application's read-only proxy is browser-facing.
const net=require('node:net');
const listen=net.Server.prototype.listen;
net.Server.prototype.listen=function(...args){
  if(typeof args[0]==='number'){
    if(typeof args[1]==='string')args[1]='127.0.0.1';
    else args.splice(1,0,'127.0.0.1');
  }else if(args[0]&&typeof args[0]==='object'&&'port' in args[0])args[0]={...args[0],host:'127.0.0.1'};
  return listen.apply(this,args);
};
const http=require('node:http');
const emit=http.Server.prototype.emit;
http.Server.prototype.emit=function(event,req,res,...rest){
  if(event==='upgrade'){
    res.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return true;
  }
  if(event==='request'&&(!process.env.AIE_MIRROR_TOKEN||req.headers['x-aie-mirror-token']!==process.env.AIE_MIRROR_TOKEN)){
    res.writeHead(403,{'content-type':'application/json'});res.end(JSON.stringify({error:'Use the Oracle application viewer proxy'}));return true;
  }
  return emit.call(this,event,req,res,...rest);
};
