import type {ClaudeBridgeStatus} from '../shared/types';
export async function detectCodex(_path?:string):Promise<ClaudeBridgeStatus>{return {available:false,error:'Install a CLI engine plugin in Global → Plugins'};}
