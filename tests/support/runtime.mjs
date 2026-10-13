// A small DOM stub for controller integration tests, not a browser or layout renderer.
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

export async function productRuntime(hash='',options={}) {
  const nodes=new Map(),listeners=new Map(),roots=[];
  const decode=s=>s.replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
  let document;
  class Node {
    constructor(attributes={}) {
      this.attributes={...attributes};this.id=attributes.id??'';this.dataset={};
      for(const [key,value] of Object.entries(attributes))if(key.startsWith('data-'))this.dataset[key.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=value;
      this.value=attributes.value??'';this.max=attributes.max??'';this.checked=Object.hasOwn(attributes,'checked');this.disabled=Object.hasOwn(attributes,'disabled');this.open=false;this.isConnected=true;this.style={};this.children=[];this._html='';
      this.hidden=Object.hasOwn(attributes,'hidden');this.offsetHeight=140;this.offsetWidth=240;this.eventHandlers=new Map();
      const classes=new Set((attributes.class??'').split(' '));
      this.classList={add:c=>classes.add(c),remove:c=>classes.delete(c),contains:c=>classes.has(c)};
    }
    set innerHTML(value) {
      const detach=node=>{node.isConnected=false;if(document?.activeElement===node)document.activeElement=null;node.children.forEach(detach);};
      this.children.forEach(detach);this._html=value;this.children=[];
      const stack=[this],voidTags=new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
      for(const match of value.matchAll(/<\/?([a-z][\w-]*)\b([^>]*)>/gi)) {
        if(match[0].startsWith('</')){
          while(stack.length>1){const node=stack.pop();node._html=value.slice(node.contentStart,match.index);if(node.attributes.tag===match[1])break;}
          continue;
        }
        const attributes={tag:match[1]};
        for(const a of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g))attributes[a[1]]=decode(a[2]??'');
        const node=new Node(attributes);node.parent=stack.at(-1);node.parent.children.push(node);node.contentStart=match.index+match[0].length;
        if(node.id)nodes.set(node.id,node);
        if(!voidTags.has(match[1])&&!match[0].endsWith('/>'))stack.push(node);
      }
    }
    get innerHTML(){return this._html;}
    get textContent(){return this._text??this._html.replace(/<[^>]+>/g,'');}
    set textContent(value){this._text=String(value);}
    focus(){if(!this.isConnected||document.activeElement===this)return;const old=document.activeElement;if(old)dispatch('focusout',old);document.activeElement=this;dispatch('focusin',this);}
    select(){this.selected=true;}
    getAttribute(key){return this.attributes[key]??null;}
    setAttribute(key,value){this.attributes[key]=String(value);}
    showModal(){this.open=true;}
    close(){this.open=false;for(const handler of this.eventHandlers.get('close')??[])handler({target:this});}
    addEventListener(type,handler){this.eventHandlers.set(type,[...(this.eventHandlers.get(type)??[]),handler]);}
    scrollIntoView(){}
    getBoundingClientRect(){return {left:0,right:100,top:0,bottom:100};}
    closest(selector){return matches(this,selector)?this:this.parent?.closest(selector)??null;}
    querySelector(selector){return descendants(this).find(node=>matches(node,selector))??null;}
    click(){dispatch('click',this);}
  }
  const matches=(node,selector)=>{
    if(selector.includes(','))return selector.split(',').some(part=>matches(node,part.trim()));
    if(selector.includes(' ')){const parts=selector.split(/\s+/),last=parts.pop();return matches(node,last)&&!!node.parent?.closest(parts.join(' '));}
    if(selector.startsWith('.'))return node.classList.contains(selector.slice(1));
    if(selector.startsWith('#'))return node.id===selector.slice(1);
    const tag=selector.match(/^([a-z][\w-]*)?(?=\[)/)?.[1];
    const attributes=[...selector.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)];
    if(attributes.length)return (!tag||node.attributes.tag===tag)&&attributes.every(match=>Object.hasOwn(node.attributes,match[1])&&(match[2]===undefined||node.attributes[match[1]]===match[2]));
    return node.attributes.tag===selector;
  };
  const descendants=node=>node.children.flatMap(child=>[child,...descendants(child)]);
  const allNodes=()=>roots.flatMap(root=>[root,...descendants(root)]).filter(node=>node.isConnected);
  const location={pathname:'/',search:'',hash,href:`https://preview.example/${hash}`};
  const history={};
  for(const method of ['replaceState','pushState'])history[method]=(_a,_b,next)=>{
    const url=new URL(next,location.href);location.hash=url.hash;location.href=url.href;
  };
  document={activeElement:null,title:'',getElementById:id=>nodes.get(id)?.isConnected?nodes.get(id):null,
    addEventListener:(type,fn)=>listeners.set(type,[...(listeners.get(type)??[]),fn]),
    querySelector:selector=>allNodes().find(node=>matches(node,selector))??null,
    querySelectorAll:selector=>allNodes().filter(node=>matches(node,selector)),
    createElement:tag=>new Node({tag})};
  for(const id of ['app','product-dialog','chart-tooltip','toast']){const node=new Node({id,...(id==='chart-tooltip'?{hidden:''}:{})});nodes.set(id,node);roots.push(node);}
  const window={scrollY:0,innerWidth:1280,innerHeight:800,scrollTo(){},addEventListener:(type,fn)=>listeners.set(type,[...(listeners.get(type)??[]),fn])};
  const timerQueue=[];
  const context=vm.createContext({document,window,location,history,URL,URLSearchParams,Blob,Intl,console,
    navigator:{clipboard:{async writeText(){}}},setTimeout:fn=>{timerQueue.push(fn);return timerQueue.length;},clearTimeout(){}});
  const fixture=options.data??JSON.parse(await readFile(new URL('../../data/fictional-snapshot.json',import.meta.url),'utf8'));
  const modules=await Promise.all(['math','settlements','engine','adapter','export-download','app'].map(name=>readFile(new URL(`../../src/${name}.js`,import.meta.url),'utf8')));
  context.FIXTURE_DATA=fixture;
  context.MONTHLY_CLAIM_CHECK=options.monthlyCheck??null;
  context.SETTLEMENT_DATA=options.settlementData??null;
  context.SETTLEMENT_RECEIPT=options.settlementReceipt??null;
  context.SETTLEMENT_TABLES=options.settlementTables??null;
  const code=modules.map(source=>source.replace(/^import .*;\s*$/gm,'').replace(/^export /gm,'')).join('\n');
  vm.runInContext(`${code}\nglobalThis.review={state,adapter,get report(){return currentReport;},get breakdown(){return currentBreakdown;},restoreRoute,queryForView,render,selectionDiagnosticView,scatterDiagnosticView,persistenceDiagnosticView};`,context);
  function dispatch(type,target,extra={}) {
    const event={target,preventDefault(){this.prevented=true;},...extra};
    for(const handler of listeners.get(type)??[])handler(event);
    return event;
  }
  const action=(name,data={})=>dispatch('click',new Node({'data-action':name,...Object.fromEntries(Object.entries(data).map(([key,value])=>[`data-${key}`,String(value)]))}));
  const field=(id,value,type='change')=>{const node=nodes.get(id);if(!node)throw new Error(`Missing field ${id}`);node.value=String(value);return dispatch(type,node);};
  const timers=()=>{while(timerQueue.length)timerQueue.shift()();};
  return {review:context.review,nodes,document,window,location,action,field,dispatch,timers,Node,
    html:()=>nodes.get('app').innerHTML,dialog:()=>nodes.get('product-dialog').innerHTML};
}
