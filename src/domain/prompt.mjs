export function assertDevelopment(dataset){if(dataset?.kind!=='development')throw new Error('Prompt improvement requires a development dataset; independent release data is forbidden');}
export function lineDiff(before,after){
  const a=before.split('\n'),b=after.split('\n');let first=0,lastA=a.length,lastB=b.length;
  while(first<lastA&&first<lastB&&a[first]===b[first])first++;
  while(lastA>first&&lastB>first&&a[lastA-1]===b[lastB-1]){lastA--;lastB--;}
  return[...a.slice(first,lastA).map(text=>({type:'removed',text})),...b.slice(first,lastB).map(text=>({type:'added',text}))];
}
