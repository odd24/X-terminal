type Shortcut = {id:string; pinned?:boolean};
const pinned = (item:Shortcut) => item.pinned === true;

export function setShortcutPins<T extends Shortcut>(items: readonly T[], ids: ReadonlySet<string>, value: boolean): T[] {
  const rest:T[] = [], moved:T[] = [];
  for(const item of items){
    if(ids.has(item.id)&&pinned(item)!==value)moved.push({...item,pinned:value});
    else rest.push(item);
  }
  return [...rest,...moved].sort((a,b)=>Number(pinned(b))-Number(pinned(a)));
}

export function stepShortcuts<T extends Shortcut>(items: readonly T[], ids: ReadonlySet<string>, step: -1|1): T[]|undefined {
  const next=[...items];
  let changed=false;
  for(let i=step<0?1:next.length-2; i>=0&&i<next.length; i-=step){
    const item=next[i], neighbor=next[i+step];
    if(!neighbor||!ids.has(item.id)||ids.has(neighbor.id)||pinned(item)!==pinned(neighbor))continue;
    next[i]=neighbor;
    next[i+step]=item;
    changed=true;
  }
  return changed?next:undefined;
}

export function insertShortcuts<T extends Shortcut>(items: readonly T[], ids: ReadonlySet<string>, source: string, anchor: string, after: boolean): T[]|undefined {
  const from=items.find(item=>item.id===source), to=items.find(item=>item.id===anchor);
  if(!from||!to||pinned(from)!==pinned(to)||ids.has(anchor)||!ids.has(source))return;
  const block=items.filter(item=>ids.has(item.id)&&pinned(item)===pinned(from));
  const taken=new Set(block.map(item=>item.id));
  const next=items.filter(item=>!taken.has(item.id));
  next.splice(next.findIndex(item=>item.id===anchor)+(after?1:0),0,...block);
  if(next.some((item,index)=>item!==items[index]))return next;
}

export function moveShortcutToEdge<T extends Shortcut>(items: readonly T[], id: string, edge: 'first'|'last'): T[]|undefined {
  const item=items.find(row=>row.id===id);
  if(!item)return;
  const sameRegion=(row:Shortcut)=>pinned(row)===pinned(item);
  const anchor=(edge==='first'?items:[...items].reverse()).find(sameRegion);
  if(anchor&&anchor.id!==id)return insertShortcuts(items,new Set([id]),id,anchor.id,edge==='last');
}
