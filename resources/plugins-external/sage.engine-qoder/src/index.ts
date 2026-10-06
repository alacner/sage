import {runQoder,detectQoder} from './adapter';
export const apiVersion=1;
export const detect=(settings:any)=>detectQoder(settings.binaryPath);
export const run=(options:any,settings:any)=>runQoder({...options,binaryPath:settings.binaryPath||undefined,model:settings.model||undefined});
