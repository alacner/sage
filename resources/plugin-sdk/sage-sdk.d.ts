/** Sage SDK 1.x. Standalone editor types; no Sage source dependency. */
export type Json = null | boolean | number | string | Json[] | {[key:string]:Json};
export interface PluginI18n {
 readonly locale:string;
 t(key:string,params?:Record<string,string|number>):string;
 /** View only: update rendered text without losing form state. Returns unsubscribe. */
 onDidChangeLocale(callback:(locale:string)=>void):()=>void;
}
export interface SDK {
 i18n:PluginI18n;
 /** Call a service declared in manifest.consumes. Dependency and caller permissions are checked. */
 call<T extends Json=Json>(plugin:string,service:string,method:string,args?:Json):Promise<T>;
 /** Discover the supported host APIs with host('capabilities','list'). */
 host<T extends Json=Json>(service:string,method:string,args?:Json):Promise<T>;
 settings:{get<T extends Json=Json>(key:string):Promise<T>;set<T extends Json=Json>(key:string,value:T):Promise<T>};
}
/** SDK 1.5 optional manifest.icon: geometry on a fixed 0 0 24 24 canvas.
 * 1–16 paths, each at most 4096 characters and 16000 total. SVG path commands
 * and numeric coordinates only; no XML, links, scripts or custom attributes.
 * The host uses currentColor and either a round-capped 2px outline (default)
 * or a solid monochrome fill. No runtime permission or callback is involved.
 */
export interface PluginIcon {paths:string[];filled?:boolean}
/** Manifest extension contracts introduced in SDK 1.2. */
export interface ExtensionPoint {
 id:string;version:string;title:string;input:Record<string,Json>;output:Record<string,Json>;
}
export interface ExtensionHandler {
 id:string;point:string;version:string;title:string;service:string;method:string;order?:number;
}
export interface EventSubscription {event:string;service:string;method:string;order?:number}
/** SDK 1.3 manifest.colorGroups: installed contributions to centralized theme settings. */
export interface ColorGroup {
 id:string;slot:'settings.appearance.colors';title:string;order?:number;
 colors:Array<{id:string;title:string;defaults:{light:string;dark:string}}>;
}
/** CSS variable: --sage-plugin-<plugin ID with dots replaced by underscores>__<group ID>__<color ID>.
 * Only the plugin's own variables are synchronized into its sandbox views.
 * Overrides use plugin:<plugin ID>:<group ID>.<color ID> in appearance/theme palettes.
 */
export interface CompressionResult {summary:string;keepRecentTurns:number}
export interface ModelRouteResult {providerId:string;modelId:string}
/**
 * Host APIs (discover exact schemas through capabilities.list):
 * extensions.list({point?}) -> definitions or active handlers with key
 * extensions.invoke({point,key,input}) -> validated output; owner only
 * events.list({}) -> host events
 * events.emit({event,payload}) -> delivery results; own namespace only
 * browser.tabs({}) / browser.attach({id}) -> integrated-tab discovery/handle
 * browser.create({url,width,height}) -> isolated viewport handle
 * browser.screenshot({id}) -> {mimeType,base64,width,height}
 * models.analyzeImage({images,prompt}) -> {analyzed,text}
 * mcp.servers({}) / mcp.tools({serverId}) / mcp.call({serverId,name,arguments})
 *
 * sage/context.compact input: {messages,maxBodyChars,trigger?}; output CompressionResult.
 * sage/models.route input: {requestedModel,task,candidates}; output ModelRouteResult.
 * Required permissions: context.transform, models.use, events.subscribe/events.publish,
 * browser.control/browser.debug/browser.tabs, mcp.connect, as appropriate.
 * Plugins may declare extensionPoints, extensions and events in sage.plugin.json.
 * A consumer must declare the owning plugin in dependencies. Dispatch retains the
 * full caller chain; all callers must hold any host permission used by a handler.
 */
export type ServiceMethod=(args:any,sdk:SDK)=>Json|Promise<Json>;
export interface SagePlugin {services:Record<string,Record<string,ServiceMethod>>}
export interface ViewSDK {
 i18n:PluginI18n;
 call<T extends Json=Json>(service:string,method:string,args?:Json):Promise<T>;
 /** Call before changing unsaved form state; clear after persistence succeeds. */
 setDirty(value:boolean):void;
}
declare global { var sagePlugin:SagePlugin; var sage:ViewSDK; }
