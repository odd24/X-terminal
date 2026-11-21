import {createContext,useContext,useState,type ComponentPropsWithoutRef,type ReactNode} from 'react';
import {createPortal} from 'react-dom';

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
  actions?:ReactNode;
  local?:boolean;
  tone?:'error';
};

export function CornerNotice({heading,children,actions,local,tone,className='',...props}:Props) {
  const target=useContext(CornerNoticeTarget);
  const card=<aside {...props} className={`corner-notice ${local?'corner-notice-local ':''}${className}`} data-tone={tone}>
    <div className="corner-notice-message" role={tone==='error'?'alert':'status'}>
      <strong className="corner-notice-title">{heading}</strong>
      <div className="corner-notice-body" tabIndex={children?0:undefined}>{children}</div>
    </div>
    <div className="corner-notice-actions">{actions}</div>
  </aside>;
  return local?card:target?createPortal(card,target):null;
}
