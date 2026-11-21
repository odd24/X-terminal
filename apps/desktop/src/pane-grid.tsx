import type {CSSProperties, ReactNode} from 'react';
import type {PaneKey, PaneTree, SplitAxis} from './pane-layout';
import {SplitDivider} from './split-divider';

type Rect = {x:number;y:number;width:number;height:number};
const initial:Rect={x:0,y:0,width:100,height:100};
const style=(rect:Rect):CSSProperties=>({
 left:`${rect.x}%`,top:`${rect.y}%`,width:`${rect.width}%`,height:`${rect.height}%`,
});

export function PaneGrid({tree,ratios,resize,render,idle}:{tree:PaneTree;ratios:Readonly<Record<number,number>>;
 resize(id:number,ratio:number):void;render(key:PaneKey,index:number):ReactNode;idle:boolean}){
 const panes:{key:PaneKey;bounds:Rect}[]=[];
 const dividers:{id:number;direction:SplitAxis;bounds:Rect}[]=[];
 function place(node:PaneTree,bounds:Rect){
  if(typeof node==='string'){panes.push({key:node,bounds});return;}
  dividers.push({...node,bounds});
  const ratio=(ratios[node.id]??50)/100;
  if(node.direction==='horizontal'){
   const width=bounds.width*ratio;
   place(node.first,{...bounds,width});
   place(node.second,{...bounds,x:bounds.x+width,width:bounds.width-width});
  }else{
   const height=bounds.height*ratio;
   place(node.first,{...bounds,height});
   place(node.second,{...bounds,y:bounds.y+height,height:bounds.height-height});
  }
 }
 place(tree,initial);
 const direction=typeof tree==='string'?'single':tree.direction;
 return <div className={`terminal-grid ${direction}${idle?' terminal-grid-idle':''}`} aria-label="终端窗格布局">
  {panes.map(({key,bounds},index)=><div key={key} className="pane-tile" style={{...style(bounds),
   paddingLeft:bounds.x>0?4:0,paddingTop:bounds.y>0?4:0,
   paddingRight:bounds.x+bounds.width<99.999?4:0,paddingBottom:bounds.y+bounds.height<99.999?4:0,
  }}>{render(key,index)}</div>)}
  {dividers.map(({id,direction,bounds})=><div key={id} className={`pane-divider-area ${direction}`}
   style={{...style(bounds),'--pane-ratio':`${ratios[id]??50}%`} as CSSProperties}>
   <SplitDivider direction={direction} ratio={ratios[id]??50} change={value=>resize(id,value)}/>
  </div>)}
 </div>;
}
