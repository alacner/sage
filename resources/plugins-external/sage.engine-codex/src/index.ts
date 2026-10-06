import {runCodex,detectCodex} from './adapter';
export const apiVersion=1;
export const detect=(settings:any)=>detectCodex(settings.binaryPath);
export const run=(options:any,settings:any)=>runCodex({...options,binaryPath:settings.binaryPath||undefined,model:settings.model||undefined});
