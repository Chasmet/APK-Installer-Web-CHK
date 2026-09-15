const readAnn={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
const writeAnn={readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false};
const deleteAnn={readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:false};
const noProps={type:'object',properties:{},additionalProperties:false};

export const trackingTools=[
 {name:'get_tracking_status',title:'État du Tracking CHK',description:'Lit l’état compact du Wall Tracker exécuté sur le téléphone : activation, connexions Binance/Bybit, fraîcheur, seuils et nombre d’actifs détenus suivis. Les carnets bruts ne passent pas par Render.',inputSchema:noProps,annotations:readAnn},
 {name:'get_tracking_assets',title:'Actifs suivis par Tracking',description:'Liste uniquement les cryptos réellement détenues que l’APK suit automatiquement, avec paire Binance/Bybit disponible, prix et nombre de murs actifs.',inputSchema:noProps,annotations:readAnn},
 {name:'get_tracking_snapshot',title:'Snapshot Tracking d’une crypto',description:'Retourne la vue Tracking complète d’une crypto détenue : connexions, paires, prix, murs actifs, derniers événements, correspondances Binance↔Bybit et notes liées.',inputSchema:{type:'object',properties:{asset:{type:'string'}},required:['asset'],additionalProperties:false},annotations:readAnn},
 {name:'get_tracking_orderbook',title:'Carnet Tracking spécialisé',description:'Retourne le carnet Tracking dérivé localement : gros murs suivis avec Wall ID, âge, force, déplacements, replenishment et fingerprint. Ce n’est pas un dump du carnet brut.',inputSchema:{type:'object',properties:{asset:{type:'string'},exchange:{type:'string',enum:['BINANCE','BYBIT']},limit:{type:'integer',minimum:1,maximum:100}},required:['asset'],additionalProperties:false},annotations:readAnn},
 {name:'get_tracking_walls',title:'Lister les murs suivis',description:'Liste les murs actuellement suivis par l’APK pour les cryptos détenues. Filtres optionnels par crypto, exchange et côté BUY/SELL.',inputSchema:{type:'object',properties:{asset:{type:'string'},exchange:{type:'string',enum:['BINANCE','BYBIT']},side:{type:'string',enum:['BUY','SELL']},limit:{type:'integer',minimum:1,maximum:200}},additionalProperties:false},annotations:readAnn},
 {name:'get_tracking_wall',title:'Lire un mur Tracking',description:'Retourne la fiche complète d’un Wall ID : quantité, prix, durée, exécuté/annulé estimé, mouvements, replenishment et probabilités comportementales.',inputSchema:{type:'object',properties:{wall_id:{type:'string'}},required:['wall_id'],additionalProperties:false},annotations:readAnn},
 {name:'get_wall_fingerprint',title:'Fingerprint d’un mur',description:'Retourne le Wall Fingerprint probabiliste. Il estime acteur unique/petit groupe, multi-traders ou indéterminé sans prétendre identifier un compte ou wallet.',inputSchema:{type:'object',properties:{wall_id:{type:'string'}},required:['wall_id'],additionalProperties:false},annotations:readAnn},
 {name:'get_tracking_history',title:'Historique Wall Tracker',description:'Retourne les derniers événements utiles enregistrés localement : apparition, déplacement, replenishment, absorption, annulation et disparition.',inputSchema:{type:'object',properties:{asset:{type:'string'},limit:{type:'integer',minimum:1,maximum:100}},additionalProperties:false},annotations:readAnn},
 {name:'get_cross_exchange_matches',title:'Matches Binance ↔ Bybit',description:'Retourne les correspondances comportementales probabilistes entre murs Binance et Bybit calculées sur le téléphone.',inputSchema:{type:'object',properties:{asset:{type:'string'},limit:{type:'integer',minimum:1,maximum:100}},additionalProperties:false},annotations:readAnn},
 {name:'get_tracking_gaps',title:'Coupures du Tracking',description:'Retourne les périodes où un flux requis était indisponible afin de ne jamais présenter un historique discontinu comme complet.',inputSchema:{type:'object',properties:{limit:{type:'integer',minimum:1,maximum:100}},additionalProperties:false},annotations:readAnn},
 {name:'list_tracking_notes',title:'Carnet de notes Tracking',description:'Liste le Carnet Tracking, totalement séparé des Notes Classiques, pour mémoriser observations sur cryptos, murs et fingerprints.',inputSchema:{type:'object',properties:{asset:{type:'string'},limit:{type:'integer',minimum:1,maximum:200}},additionalProperties:false},annotations:readAnn},
 {name:'set_tracking_enabled',title:'Activer ou arrêter Tracking',description:'Demande à l’APK d’activer ou arrêter le Wall Tracker local. L’APK ne suit toujours que les cryptos réellement détenues.',inputSchema:{type:'object',properties:{enabled:{type:'boolean'}},required:['enabled'],additionalProperties:false},annotations:writeAnn},
 {name:'set_tracking_thresholds',title:'Régler les seuils Tracking',description:'Règle sur le téléphone la valeur minimale d’un mur et sa force minimale par rapport à la quantité médiane du carnet.',inputSchema:{type:'object',properties:{min_wall_notional:{type:'number',minimum:250,maximum:1000000},min_wall_strength:{type:'number',minimum:1.5,maximum:50}},additionalProperties:false},annotations:writeAnn},
 {name:'refresh_tracking_assets',title:'Rafraîchir les actifs Tracking',description:'Demande à l’APK de relire immédiatement les portefeuilles synchronisés et d’ajouter/retirer automatiquement les cryptos détenues.',inputSchema:noProps,annotations:writeAnn},
 {name:'create_tracking_note',title:'Ajouter une note Tracking',description:'Ajoute une note au Carnet Tracking local du téléphone, éventuellement rattachée à une crypto détenue et/ou un Wall ID.',inputSchema:{type:'object',properties:{content:{type:'string',minLength:1,maxLength:4000},asset:{type:'string'},wall_id:{type:'string'}},required:['content'],additionalProperties:false},annotations:writeAnn},
 {name:'update_tracking_note',title:'Modifier une note Tracking',description:'Modifie une note existante du Carnet Tracking local.',inputSchema:{type:'object',properties:{id:{type:'integer',minimum:1},content:{type:'string',minLength:1,maxLength:4000}},required:['id','content'],additionalProperties:false},annotations:writeAnn},
 {name:'delete_tracking_note',title:'Supprimer une note Tracking',description:'Supprime une note du Carnet Tracking local.',inputSchema:{type:'object',properties:{id:{type:'integer',minimum:1}},required:['id'],additionalProperties:false},annotations:deleteAnn},
];
export const trackingToolNames=new Set(trackingTools.map(t=>t.name));

const upper=v=>String(v||'').trim().toUpperCase();
const arr=v=>Array.isArray(v)?v:[];
const clamp=(v,min,max,def)=>Number.isFinite(Number(v))?Math.max(min,Math.min(max,Number(v))):def;

export function createTrackingHandler({edgeUrl,token,accountFingerprint,fetchImpl=fetch}){
 const url=new URL(edgeUrl);url.pathname=url.pathname.replace(/\/chk-binance-workspace-latest\/?$/, '/chk-tracking-control');
 async function bridge(payload){
  const r=await fetchImpl(url,{method:'POST',headers:{'content-type':'application/json','x-chk-internal-token':token,accept:'application/json','user-agent':'chk-crypto-mcp-tracking-v20'},body:JSON.stringify({...payload,accountFingerprint}),signal:AbortSignal.timeout(8000)});
  const text=await r.text();let data;try{data=JSON.parse(text||'{}');}catch{data={raw:text};}
  if(!r.ok){const e=new Error(`tracking-control HTTP ${r.status}: ${data.error||data.message||text.slice(0,160)}`);e.status=r.status;e.data=data;throw e;}
  return data;
 }
 async function root(){return bridge({action:'get_state'});}
 async function state(){const r=await root();return r?.state&&typeof r.state==='object'?r.state:{};}
 function reply(id,data,text){return{jsonrpc:'2.0',id,result:{content:[{type:'text',text}],structuredContent:data}};}
 function filterWalls(s,a={}){let w=arr(s.walls);const asset=upper(a.asset),ex=upper(a.exchange),side=upper(a.side);if(asset)w=w.filter(x=>upper(x.asset)===asset);if(ex)w=w.filter(x=>upper(x.exchange)===ex);if(side)w=w.filter(x=>upper(x.side)===side);return w.slice(0,clamp(a.limit,1,200,100));}
 async function enqueue(command){
  const deadline=Date.now()+18000;
  for(let phase=0;phase<2;phase++){
   try{
    const q=await bridge({action:'enqueue_command',command});const seq=Number(q.seq||0);
    while(Date.now()<deadline){await new Promise(r=>setTimeout(r,750));const r=await root();if(Number(r.applied_seq||0)>=seq)return{ok:true,seq,applied:true,result:r.last_result||{},state:r.state||{}};}
    return{ok:true,seq,applied:false,pending:true,message:'Commande envoyée au téléphone ; application en attente ou hors ligne.'};
   }catch(e){
    if(e.status!==409||phase>0)throw e;
    while(Date.now()<deadline){const r=await root();if(Number(r.command_seq||0)<=Number(r.applied_seq||0))break;await new Promise(r=>setTimeout(r,750));}
   }
  }
  throw new Error('tracking_command_busy');
 }
 async function handle(msg,name,a={}){
  try{
   const s=await state();
   if(name==='get_tracking_status')return reply(msg.id,{trackingAvailable:s.trackingAvailable===true,trackingRunsOnDevice:s.trackingRunsOnDevice===true,rawOrderbookSentToRender:s.rawOrderbookSentToRender===true,trackedAssetsMode:s.trackedAssetsMode||'PORTFOLIO_HOLDINGS_ONLY',requiresInternet:s.requiresInternet!==false,worksScreenOff:s.worksScreenOff===true,enabled:s.enabled===true,updatedAt:s.updatedAt||null,connections:s.connections||{},settings:s.settings||{},assetCount:arr(s.assets).length,activeWallCount:arr(s.walls).length},'État du Wall Tracker CHK récupéré. Les flux bruts restent sur le téléphone.');
   if(name==='get_tracking_assets')return reply(msg.id,{updatedAt:s.updatedAt||null,assets:arr(s.assets)},`${arr(s.assets).length} crypto(s) détenue(s) suivie(s).`);
   if(name==='get_tracking_snapshot'){const asset=upper(a.asset);const assetRow=arr(s.assets).find(x=>upper(x.asset)===asset)||null;const walls=filterWalls(s,{asset,limit:200});const events=arr(s.events).filter(x=>upper(x.asset)===asset).slice(0,80);const matches=arr(s.crossExchangeMatches).filter(x=>upper(x.asset)===asset).slice(0,40);const notes=arr(s.notes).filter(x=>upper(x.asset)===asset||(!x.asset&&walls.some(w=>w.id===x.wallId))).slice(0,50);return reply(msg.id,{asset,tracked:!!assetRow,assetState:assetRow,connections:s.connections||{},walls,events,crossExchangeMatches:matches,notes,updatedAt:s.updatedAt||null},`Snapshot Tracking ${asset} récupéré.`);}
   if(name==='get_tracking_orderbook'){const asset=upper(a.asset),exchange=upper(a.exchange);const walls=filterWalls(s,{asset,exchange,limit:a.limit??100}).sort((x,y)=>upper(x.side)===upper(y.side)?Number(x.price||0)-Number(y.price||0):upper(x.side).localeCompare(upper(y.side)));return reply(msg.id,{asset,exchange:exchange||'ALL',kind:'TRACKING_WALL_BOOK',rawDepth:false,walls,updatedAt:s.updatedAt||null},`Carnet Tracking ${asset}: ${walls.length} mur(s) suivi(s).`);}
   if(name==='get_tracking_walls')return reply(msg.id,{walls:filterWalls(s,a),updatedAt:s.updatedAt||null},'Murs Tracking récupérés.');
   if(name==='get_tracking_wall'||name==='get_wall_fingerprint'){const id=String(a.wall_id||'');const w=arr(s.walls).find(x=>x.id===id)||arr(s.events).find(x=>x.wallId===id)||null;if(!w)throw new Error('Wall ID introuvable dans le snapshot compact actuel');const data=name==='get_wall_fingerprint'?{wallId:id,asset:w.asset,exchange:w.exchange,side:w.side,singleActorProbability:w.singleActorProbability,multiTraderProbability:w.multiTraderProbability,indeterminateProbability:w.indeterminateProbability,moves:w.moves,replenishments:w.replenishments,strength:w.strength,warning:'Score comportemental probabiliste ; ne permet pas d’identifier juridiquement un compte ou wallet.'}:w;return reply(msg.id,data,name==='get_wall_fingerprint'?'Fingerprint probabiliste récupéré.':'Mur Tracking récupéré.');}
   if(name==='get_tracking_history'){let e=arr(s.events);const asset=upper(a.asset);if(asset)e=e.filter(x=>upper(x.asset)===asset);e=e.slice(0,clamp(a.limit,1,100,80));return reply(msg.id,{asset:asset||null,events:e},`${e.length} événement(s) Tracking.`);}
   if(name==='get_cross_exchange_matches'){let m=arr(s.crossExchangeMatches);const asset=upper(a.asset);if(asset)m=m.filter(x=>upper(x.asset)===asset);m=m.slice(0,clamp(a.limit,1,100,40));return reply(msg.id,{asset:asset||null,matches:m},`${m.length} correspondance(s) Binance ↔ Bybit.`);}
   if(name==='get_tracking_gaps'){const g=arr(s.connectionGaps).slice(0,clamp(a.limit,1,100,20));return reply(msg.id,{gaps:g},`${g.length} coupure(s) de données Tracking.`);}
   if(name==='list_tracking_notes'){let n=arr(s.notes);const asset=upper(a.asset);if(asset)n=n.filter(x=>upper(x.asset)===asset);n=n.slice(0,clamp(a.limit,1,200,50));return reply(msg.id,{notes:n},`${n.length} note(s) dans le Carnet Tracking.`);}
   let command;
   if(name==='set_tracking_enabled')command={op:'SET_TRACKING_ENABLED',enabled:a.enabled===true};
   else if(name==='set_tracking_thresholds'){command={op:'SET_THRESHOLDS'};if(a.min_wall_notional!=null)command.minWallNotional=Number(a.min_wall_notional);if(a.min_wall_strength!=null)command.minWallStrength=Number(a.min_wall_strength);}
   else if(name==='refresh_tracking_assets')command={op:'REFRESH_ASSETS'};
   else if(name==='create_tracking_note')command={op:'CREATE_NOTE',content:String(a.content||''),asset:upper(a.asset),wallId:String(a.wall_id||'')};
   else if(name==='update_tracking_note')command={op:'UPDATE_NOTE',id:Number(a.id),content:String(a.content||'')};
   else if(name==='delete_tracking_note')command={op:'DELETE_NOTE',id:Number(a.id)};
   else throw new Error(`tracking tool not handled: ${name}`);
   const out=await enqueue(command);return reply(msg.id,out,out.applied?'Commande Tracking appliquée sur le téléphone.':'Commande Tracking envoyée ; téléphone en attente.');
  }catch(e){return{jsonrpc:'2.0',id:msg.id,result:{isError:true,content:[{type:'text',text:String(e.message||e)}],structuredContent:{ok:false,error:String(e.message||e)}}};}
 }
 return{handle};
}
