import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {PROMPTFOO_VERSION} from '../src/evaluation/version.mjs';

export async function buildUI(){
  const root=path.resolve(fileURLToPath(new URL('..',import.meta.url))),dist=path.join(root,'dist');
  const native=path.join(path.dirname(createRequire(import.meta.url).resolve('promptfoo')),'app');
  const html=await fs.readFile(path.join(native,'index.html'),'utf8');
  // Remove only this repository's generated output. Refuse symlinks or targets
  // outside the workspace before a recursive filesystem operation on Windows.
  if(path.dirname(dist)!==root)throw new Error('Unsafe UI build directory');
  try{if((await fs.lstat(dist)).isSymbolicLink()||await fs.realpath(dist)!==dist)throw new Error('UI build target must be a real workspace directory');}catch(error){if(error.code!=='ENOENT')throw error;}
  await fs.rm(dist,{recursive:true,force:true});await fs.mkdir(dist,{recursive:true});
  await fs.cp(native,dist,{recursive:true});await fs.mkdir(path.join(dist,'aie'));
  for(const [source,target] of [['operations.mjs','operations.js'],['presentation.mjs','presentation.mjs'],['operations.css','operations.css'],['viewer-bootstrap.js','viewer-bootstrap.js']])await fs.copyFile(path.join(root,'frontend',source),path.join(dist,'aie',target));
  let index=html;const theme=html.match(/<script>([\s\S]*?)<\/script>/);
  if(theme){await fs.writeFile(path.join(dist,'aie/native-theme.js'),theme[1]);index=index.replace(theme[0],'<script src="/aie/native-theme.js"></script>');}
  index=index.replace('<head>','<head>\n    <script src="/aie/viewer-bootstrap.js"></script>\n    <link rel="stylesheet" href="/aie/operations.css">');
  await fs.writeFile(path.join(dist,'index.html'),index);
  await fs.writeFile(path.join(dist,'aie/build.json'),JSON.stringify({ui:'native-promptfoo',version:PROMPTFOO_VERSION,authoritativeStorage:'Oracle',viewerStorage:'rebuildable-local-mirror'}));
  console.log(`Packaged native Promptfoo ${PROMPTFOO_VERSION} UI with Oracle workflow extensions.`);
  return dist;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await buildUI();
