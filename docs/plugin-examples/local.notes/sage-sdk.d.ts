/** Sage SDK 1.x. Standalone editor types; no Sage source dependency. */
export type Json = null | boolean | number | string | Json[] | {[key:string]:Json};
export interface SDK {
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
export type ServiceMethod=(args:any,sdk:SDK)=>Json|Promise<Json>;
export interface SagePlugin {services:Record<string,Record<string,ServiceMethod>>}
export interface ViewSDK {
 call<T extends Json=Json>(service:string,method:string,args?:Json):Promise<T>;
 /** Call before changing unsaved form state; clear after persistence succeeds. */
 setDirty(value:boolean):void;
}
declare global { var sagePlugin:SagePlugin; var sage:ViewSDK; }
