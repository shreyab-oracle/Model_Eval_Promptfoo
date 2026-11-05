import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {config,safeError} from '../config.mjs';
import {route} from './routes.mjs';
import {authorizeMutation} from './security.mjs';
import {createViewerMirror} from '../evaluation/mirror.mjs';
import {renderOperations} from './operations.mjs';
const dist=path.resolve(fileURLToPath(new URL('../../dist',import.meta.url)));
export function makeServer({port=config.port,staticRoot=dist,dispatch=route,mirror=createViewerMirror(),viewer}={}){
  const token=process.env.LOCAL_API_TOKEN||randomBytes(32).toString('hex');
  const server=http.createServer(async(req,res)=>{
    const send=(status,data)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(data));};
    try{
      const activePort=port||server.address()?.port;
      const allowedOrigins=[config.uiOrigin,`http://127.0.0.1:${activePort}`,`http://localhost:${activePort}`];
      if(![`127.0.0.1:${activePort}`,`localhost:${activePort}`].includes(req.headers.host))throw Object.assign(new Error('Invalid Host header'),{statusCode:403});
      const url=new URL(req.url,`http://127.0.0.1:${activePort}`);
      if(url.pathname==='/health'){send(200,{app:'oracle-promptfoo',nativeViewer:true});return;}
      if(url.pathname.startsWith('/promptfoo/api/')){
        try{
          const response=await(viewer?viewer(req.method,url):mirror.proxy(req.method,url));
          if(response instanceof Response){res.writeHead(response.status,{'content-type':response.headers.get('content-type')||'application/json','cache-control':'no-store',...(response.headers.has('content-disposition')?{'content-disposition':response.headers.get('content-disposition')}:{})});res.end(Buffer.from(await response.arrayBuffer()));}
          else send(200,response);
        }catch(error){send(error.statusCode||400,{error:error.message,details:safeError(error)});}return;
      }
      const context=url.pathname.match(/^\/aie\/viewer-context\/([^/]+)$/);
      if(req.method==='GET'&&context){send(200,await mirror.context(decodeURIComponent(context[1])));return;}
      if(req.method==='GET'&&!viewer&&(url.pathname==='/'||url.pathname==='/eval'||/^\/eval\/[^/]+$/.test(url.pathname))){
        const encodedId=url.pathname.split('/')[2],requestedId=encodedId?decodeURIComponent(encodedId):undefined,entry=requestedId?await mirror.ensure(requestedId):await mirror.latest();
        if(entry&&requestedId!==entry.viewerId){res.writeHead(302,{location:'/eval/'+encodeURIComponent(entry.viewerId)+url.search,'cache-control':'no-store'});res.end();return;}
      }
      if(url.pathname==='/operations'){
        if(req.method!=='GET')throw Object.assign(new Error('Method not allowed'),{statusCode:405});
        const boot=await dispatch('GET','/api/bootstrap',{},token),id=url.searchParams.get('run'),tab=url.searchParams.get('tab')||'setup';
        const bundle=id?await dispatch('GET','/api/runs/'+encodeURIComponent(id),{},token):undefined;
        const queue=tab==='reviews'?(await dispatch('GET','/api/reviews',{},token)).filter(q=>!id||q.runId===id):[];
        const history=tab==='history'?await dispatch('GET','/api/history',{},token):undefined;
        res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"});
        res.end(renderOperations({boot,tab,bundle,queue,history}));return;
      }
      if(!url.pathname.startsWith('/api/')){
        if(!['GET','HEAD'].includes(req.method))throw Object.assign(new Error('Method not allowed'),{statusCode:405});
        const requested=path.resolve(staticRoot,'.'+decodeURIComponent(url.pathname));if(!requested.startsWith(staticRoot+path.sep)&&requested!==staticRoot)throw Object.assign(new Error('Invalid path'),{statusCode:403});
        const file=fs.existsSync(requested)&&fs.statSync(requested).isFile()?requested:path.join(staticRoot,'index.html');
        if(!fs.existsSync(file)){res.writeHead(503,{'content-type':'text/plain'});res.end('Run npm run build to package the native Promptfoo UI.');return;}
        const mime={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'}[path.extname(file)]||'application/octet-stream';res.writeHead(200,{'content-type':mime,'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'"});if(req.method==='HEAD')res.end();else fs.createReadStream(file).pipe(res);return;
      }
      let body={};if(req.method!=='GET'){
        authorizeMutation({origin:req.headers.origin,token:req.headers['x-local-token'],expectedToken:token,allowedOrigins});
        if(!req.headers['content-type']?.startsWith('application/json'))throw Object.assign(new Error('JSON content type required'),{statusCode:415});
        let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>1024*1024)throw Object.assign(new Error('Request body exceeds 1 MiB'),{statusCode:413});}body=raw?JSON.parse(raw):{};
      }
      send(200,await dispatch(req.method,url.pathname,body,token));
    }catch(e){send(e.statusCode>=400&&e.statusCode<600?e.statusCode:400,{error:safeError(e)});}
  });
  server.on('close',()=>mirror.close().catch(error=>console.error(safeError(error))));
  return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const server=makeServer();server.listen(config.port,config.host,()=>console.log(`AI Model Evaluation API: http://${config.host}:${config.port}`));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));
}
