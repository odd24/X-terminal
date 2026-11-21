import {createContext,useContext,useEffect,useRef,useState,type ComponentPropsWithoutRef,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {IconButton} from './ui';

const CornerNoticeTarget=createContext<HTMLDivElement|null>(null);

export function CornerNoticeHost({children}:{children:ReactNode}) {
  const [target,setTarget]=useState<HTMLDivElement|null>(null);
  return <CornerNoticeTarget.Provider value={target}>
    {children}
    <div className="corner-notice-stack" ref={setTarget}/>
  </CornerNoticeTarget.Provider>;
}

type Props=ComponentPropsWithoutRef<'aside'>&{
  heading:ReactNode;
  children?:ReactNode;
  actions?:(activate:(action:()=>void)=>void)=>ReactNode;
  dismiss():void;
  dismissLabel?:string;
  autoDismiss?:boolean;
  local?:boolean;
  tone?:'error';
};

export function CornerNotice({heading,children,actions,dismiss,dismissLabel='关闭通知',autoDismiss=false,local,tone,className='',...props}:Props) {
  const target=useContext(CornerNoticeTarget);
  const [hover,setHover]=useState(false),[focus,setFocus]=useState(false);
  const consumed=useRef(false),close=useRef(dismiss);
  close.current=dismiss;
  function activate(action?:()=>void) {
    if(consumed.current)return;
    consumed.current=true;
    close.current();
    action?.();
  }
  useEffect(()=>{
    if(!autoDismiss||hover||focus||(!local&&!target))return;
    const timer=window.setTimeout(()=>activate(),5000);
    return()=>window.clearTimeout(timer);
  },[autoDismiss,hover,focus,local,target]);
  const card=<aside {...props} className={`corner-notice ${local?'corner-notice-local ':''}${className}`} data-tone={tone}
    onPointerEnter={()=>setHover(true)} onPointerLeave={()=>setHover(false)}
    onFocus={()=>setFocus(true)} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))setFocus(false);}}>
    <IconButton className="corner-notice-close" icon="close" label={dismissLabel} onClick={()=>activate()} />
    <div className="corner-notice-message" role={tone==='error'?'alert':'status'}>
      <strong className="corner-notice-title">{heading}</strong>
      <div className="corner-notice-body" tabIndex={children?0:undefined}>{children}</div>
    </div>
    <div className="corner-notice-actions">{actions?.(activate)}</div>
  </aside>;
  return local?card:target?createPortal(card,target):null;
}

export function useCornerNoticeFailure() {
  const [failures,setFailures]=useState<{id:string;message:string}[]>([]);
  return {
    failure:failures[0],
    report:(message:string)=>{
      const next={id:crypto.randomUUID(),message};
      setFailures(previous=>previous.some(item=>item.message===message)?previous:[...previous,next]);
    },
    dismiss:(id:string)=>setFailures(previous=>previous.filter(item=>item.id!==id)),
  };
}

export function CornerNoticeFailure({failure,dismiss}:{failure?:{id:string;message:string};dismiss(id:string):void}) {
  return failure&&<CornerNotice key={failure.id} heading="日志操作未完成" aria-label="日志操作失败通知"
    tone="error" autoDismiss dismiss={()=>dismiss(failure.id)}>{failure.message}</CornerNotice>;
}
