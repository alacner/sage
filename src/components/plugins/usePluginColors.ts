import {useMemo} from 'react';
import {usePluginSnapshot} from './PluginWorkbench';
import {collectPluginColorGroups} from '../../../shared/plugins/colors';

export function usePluginColorGroups(){
 const {snapshot}=usePluginSnapshot();
 const groups=collectPluginColorGroups(snapshot?.plugins??[]);
 // Snapshot objects are reconstructed for localization; keep theme effects stable.
 const key=JSON.stringify(groups);
 return useMemo(()=>groups,[key]);
}
