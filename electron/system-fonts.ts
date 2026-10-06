import { isTextFontFamily } from '../shared/font-family';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
let cached: Promise<Array<{ family: string; monospace: boolean }>> | undefined;
export function listSystemFonts() {
  if (cached) return cached;
  cached = (async () => {
    if (process.platform !== 'darwin') return [];
    const script = `ObjC.import('AppKit');var m=$.NSFontManager.sharedFontManager;JSON.stringify(ObjC.deepUnwrap(m.availableFontFamilies).map(function(f){var members=ObjC.deepUnwrap(m.availableMembersOfFontFamily(f));var font=$.NSFont.fontWithNameSize(members[0][0],14);var textFont=font && [65,97,66,98,49,50,51].every(function(c){return font.coveredCharacterSet.characterIsMember(c);});return {family:f,textFont:!!textFont,monospace:members.some(function(v){return (v[3]&1024)!==0;})};}))`;
    const { stdout } = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    return (JSON.parse(stdout) as Array<{family:string;monospace:boolean;textFont:boolean}>).filter(f => f.textFont && isTextFontFamily(f.family)).sort((a,b)=>a.family.localeCompare(b.family));
  })().catch(error => { cached = undefined; throw error; });
  return cached;
}
