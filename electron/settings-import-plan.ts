import type { AppSettings } from '../shared/types';
import { BACKUP_FIELDS, backupGroup, includedBackupGroups, validBackupGroups, type BackupGroup } from '../shared/settings-backup';
import { policyUnion } from '../shared/settings-protection';

/** Replace selected modules only. Ignored and absent modules stay byte-for-byte values. */
export function applySettingsImport(current:AppSettings,incoming:AppSettings,groups:BackupGroup[]):AppSettings {
  const selected=validBackupGroups(groups),available=includedBackupGroups(incoming);
  if(selected.some(g=>!available.includes(g)))throw Error('备份不包含所选模块');
  const next:any=structuredClone(current);
  // Explicitly selected empty sections restore defaults, not unrelated settings.
  for(const key of new Set([...Object.keys(BACKUP_FIELDS),...Object.keys(current)]))if(!key.startsWith('_')&&selected.includes(backupGroup(key))&&(Object.hasOwn(BACKUP_FIELDS,key)||Object.hasOwn(incoming,key)))delete next[key];
  for(const [key,value] of Object.entries(incoming))if(!key.startsWith('_')&&selected.includes(backupGroup(key)))next[key]=structuredClone(value);
  if(selected.includes('models')){
    next._secretPolicy=policyUnion(current._secretPolicy,incoming._secretPolicy);
    if(incoming._modelMigrationVersion!==undefined)next._modelMigrationVersion=incoming._modelMigrationVersion;
    else delete next._modelMigrationVersion;
  }
  delete next._backupSections;
  return next;
}
