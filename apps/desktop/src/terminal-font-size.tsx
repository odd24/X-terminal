import { useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { config } from './config-api';
import { Field } from './ui';

type FontSaveState = 'idle' | 'saving' | 'saved' | 'failed';
type Receipt = {font_size:number;revision:string;previous_revision?:string};

export function isTerminalFontSize(size: unknown): size is number {
  return typeof size==='number' && Number.isInteger(size) && size>=10 && size<=28;
}

export function useTerminalFontSize(preview: (size:number)=>void, saved: (receipt:Receipt)=>Promise<void>) {
  const [state,setState]=useState<FontSaveState>('idle');
  const work=useRef<{pending?:number;active?:Promise<void>}>({});

  async function drain() {
    const queue=work.current;
    try {
      while(queue.pending!==undefined){
        const fontSize=queue.pending;
        queue.pending=undefined;
        let receipt:Receipt|undefined;
        try{
          const reply=await invoke<Receipt>('save_terminal_font_size',{fontSize});
          if(reply.font_size!==fontSize)throw new Error('Invalid font size receipt');
          receipt=reply;
        }catch{
          // A lost response may follow a committed write. Verify without replaying it.
          const current=await config({op:'preferences'}).catch(()=>undefined);
          if(current?.result==='preferences'&&current.preferences.font_size===fontSize){
            receipt={font_size:fontSize,revision:current.revision};
          }
        }
        if(receipt)await saved(receipt);
        if(queue.pending===undefined)setState(receipt?'saved':'failed');
      }
    }finally{queue.active=undefined;}
  }
  return {
    state,
    change(size:number){
      if(!isTerminalFontSize(size))return;
      preview(size);
      setState('saving');
      work.current.pending=size;
      work.current.active??=drain();
    },
    settled:()=>work.current.active,
    reset:()=>setState('idle'),
  };
}

const sizes=Array.from({length:19},(_,index)=>index+10);
const fontStatus:Record<FontSaveState,string>={
  idle:'字号自动保存', saving:'正在保存字号…', saved:'字号已自动保存', failed:'字号未确认保存',
};

export function TerminalFontSizeControl({label,value,state,disabled,change}:{
  label:string; value:number;state:FontSaveState;disabled?:boolean;change(size:number):void;
}) {
  return <div className="terminal-font-size">
    <Field label={label}><select aria-label={label} disabled={disabled} value={value}
      onChange={event=>change(Number(event.currentTarget.value))}>
      {sizes.map(size=><option key={size} value={size}>{size} px</option>)}
    </select></Field>
    <small role="status" aria-label={`${label}保存状态`}>{fontStatus[state]}</small>
    {state==='failed'&&<button disabled={disabled} type="button" onClick={()=>change(value)}>重试保存字号</button>}
  </div>;
}
