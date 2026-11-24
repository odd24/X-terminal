import type {ComposeTarget} from './compose-drafts';
import type {AdbIntent, AdbShortcut} from './local-adb';
import type {LocalPromptState} from './local-terminal';
import type {PaneKey} from './pane-layout';

export type ShortcutSource = {pane:PaneKey;local:string} | {pane:PaneKey;owner:string;connection:ComposeTarget};
type ButtonRef = Pick<AdbIntent,'button'|'revision'>;
export type ShortcutOpenOptions = {inherit?:string;script?:ButtonRef;adbResult?:boolean;shortcutSource:ShortcutSource};
type Execution = {
  selected(source:ShortcutSource):boolean;
  epoch():number;
  writable(pane:PaneKey):boolean;
  readText(button:ButtonRef):Promise<{text:string;append_enter:boolean}>;
  send(pane:PaneKey,target:ComposeTarget,text:string):void;
  error(message:string):void;
  prompt(id:string):LocalPromptState|undefined;
  open(pane:PaneKey,options:ShortcutOpenOptions):Promise<string|undefined>;
  starting(value:boolean):void;
  dispatch(intent:AdbIntent & {id:string}):void;
};

export function sameShortcutSource(source:ShortcutSource,live:ShortcutSource|undefined) {
  if(!live||source.pane!==live.pane)return false;
  if('local' in source)return 'local' in live&&source.local===live.local;
  return 'connection' in live&&source.owner===live.owner&&source.connection.protocol===live.connection.protocol
    &&source.connection.connection_id===live.connection.connection_id&&source.connection.generation===live.connection.generation;
}

export class ShortcutExecution {
  readonly origins=new Map<string,ShortcutSource>();
  private diagnostics=new Map<string,string>();
  private flight?:{request:string;id?:string};

  startingTab(id:string){return this.flight?.id===id;}
  acceptsDiagnostic(intent:AdbIntent){return this.diagnostics.get(intent.button)===intent.request;}

  settle(request:string){
    if(this.flight?.request!==request)return false;
    this.flight=undefined;
    return true;
  }

  closeResult(id:string,selectedPane:PaneKey,selectedId:string|undefined,successful:boolean){
    const source=this.origins.get(id);
    this.origins.delete(id);
    const released=this.flight?.id===id&&this.settle(this.flight.request);
    const restore=successful&&id===selectedId&&source?.pane===selectedPane?source:undefined;
    return {released,restore};
  }

  async execute(source:ShortcutSource,item:AdbShortcut,revision:string,ui:Execution){
    const pane=source.pane;
    const button={button:item.id,revision};
    if(item.desktop_kind==='send'){
      if('local' in source||!source.owner||!ui.writable(pane))return;
      const epoch=ui.epoch();
      try{
        const {text,append_enter}=await ui.readText(button);
        if(ui.epoch()===epoch&&ui.selected(source)&&ui.writable(pane))
          ui.send(pane,source.connection,text+(append_enter?'\r':''));
      }catch(error){if(ui.selected(source))ui.error(String(error));}
      return;
    }
    const inherit='local' in source?source.local:undefined;
    if(item.script_path){
      await ui.open(pane,{inherit,script:button,shortcutSource:source});
      return;
    }
    if(this.flight)return;
    const request=crypto.randomUUID();
    this.flight={request};
    this.diagnostics.set(item.id,request);
    let dispatched=false;
    ui.starting(true);
    try{
      const prompt=inherit?ui.prompt(inherit):undefined;
      const reuse=inherit&&!item.desktop_kind&&!item.close_on_success&&prompt&&!prompt.busy&&!prompt.hasDraft;
      const id=reuse?inherit:await ui.open(pane,{inherit,adbResult:true,shortcutSource:source});
      if(!id)return;
      this.flight={request,id};
      ui.dispatch({...button,request,id});
      dispatched=true;
    }finally{
      // The local terminal owns settlement after it accepts the intent.
      if(!dispatched&&this.settle(request))ui.starting(false);
    }
  }
}
