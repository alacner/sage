import fs from 'node:fs/promises';
import path from 'node:path';
export async function scaffoldSkill(parent:string,id='local.skill'){
 if(!/^[a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*$/.test(id))throw Error('Use publisher.name as skill ID');
 const dir=path.join(parent,id);await fs.mkdir(dir);await fs.mkdir(path.join(dir,'skills'));
 await fs.writeFile(path.join(dir,'sage.plugin.json'),JSON.stringify({format:1,id,name:'Custom skill',artifactType:'skill',category:'documentation',version:'1.0.0',sdk:'^1.2.0',entry:'plugin.js',skills:[{name:id,description:'Project-specific acceptance workflow',file:'skills/SKILL.md'}]},null,2));
 await fs.writeFile(path.join(dir,'plugin.js'),'globalThis.sagePlugin={services:{}};\n');
 await fs.writeFile(path.join(dir,'skills/SKILL.md'),'---\nname: '+id+'\ndescription: Project-specific acceptance workflow\n---\n\n# Acceptance workflow\n\n1. Read the task and define observable acceptance criteria.\n2. Inspect the project and implement the change.\n3. Run checks and report evidence and remaining limitations.\n');
 return dir;
}
export async function scaffold(parent:string,id:string){
 if(!/^[a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*$/.test(id))throw Error('Use publisher.name as plugin ID');
 const dir=path.join(parent,id);await fs.mkdir(dir);await fs.mkdir(path.join(dir,'views'));
 const manifest={format:1,id,name:'%name%',i18n:{defaultLocale:'en',messages:{en:{name:'Hello Sage',greeting:'Greeting',hello:'Hello, {name}',viewTitle:'Hello Sage',yourName:'Your name',greet:'Greet'},zh:{name:'你好 Sage',greeting:'问候语',hello:'你好，{name}',viewTitle:'你好 Sage',yourName:'你的名字',greet:'问候'}}},category:'other',scope:'both',version:'1.0.0',sdk:'^1.1.0',entry:'plugin.js',permissions:[],services:{hello:{version:'1.0.0',methods:{greet:{description:'Greet someone',input:{type:'object',properties:{name:{type:'string'}},required:['name']},output:{type:'string'},tool:true}}}},contributes:[{id:'hello',slot:'sidebar.bottom',title:'%viewTitle%',view:'views/hello.html'}],settings:{greeting:{title:'%greeting%',type:'string',default:'Hello',scope:'project'}}};
 await fs.writeFile(path.join(dir,'sage.plugin.json'),JSON.stringify(manifest,null,2));
 const {app}=await import('electron');const sdkPath=app.isPackaged?path.join(process.resourcesPath,'plugin-sdk','sage-sdk.d.ts'):path.join(app.getAppPath(),'resources/plugin-sdk/sage-sdk.d.ts');await fs.copyFile(sdkPath,path.join(dir,'sage-sdk.d.ts'));
 await fs.writeFile(path.join(dir,'plugin.js'),`// @ts-check
/// <reference path="./sage-sdk.d.ts" />
globalThis.sagePlugin={services:{hello:{greet:async(args,sdk)=>{const greeting=await sdk.settings.get('greeting');return greeting+', '+args.name;}}}};\n`);
 await fs.writeFile(path.join(dir,'views/hello.html'),`<!doctype html><html><body><h2 id="title"></h2><input id="name"><button id="greet"></button><pre id="result"></pre><script>function render(){document.getElementById('title').textContent=sage.i18n.t('viewTitle');document.getElementById('name').placeholder=sage.i18n.t('yourName');document.getElementById('greet').textContent=sage.i18n.t('greet');}render();sage.i18n.onDidChangeLocale(render);document.getElementById('greet').onclick=async()=>{try{document.getElementById('result').textContent=await sage.call('hello','greet',{name:document.getElementById('name').value});}catch(e){document.getElementById('result').textContent=e.message;}};</script></body></html>`);
 await fs.writeFile(path.join(dir,'README.md'),'# Hello Sage\n\nLoad this directory in Sage plugin development. Edit plugin.js or views/hello.html; changes reload automatically. Call hello.greet from the service tester or conversation. Export the dependency-inclusive package, import into another Sage installation and enable it for a project.\n');return dir;
}

export async function scaffoldEngine(parent:string,id='local.cli'){
 if(!/^[a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*$/.test(id))throw Error('Use publisher.name as plugin ID');
 const dir=path.join(parent,id);await fs.mkdir(dir);
 await fs.writeFile(path.join(dir,'sage.plugin.json'),JSON.stringify({format:1,id,name:'%name%',i18n:{defaultLocale:'en',messages:{en:{name:'Custom CLI',binaryPath:'CLI executable path'},zh:{name:'自定义 CLI',binaryPath:'CLI 可执行文件路径'}}},category:'engine',scope:'global',version:'1.0.0',sdk:'^1.1.0',entry:'plugin.js',engine:{apiVersion:1,entry:'engine.js'},permissions:['engine.native'],settings:{binaryPath:{title:'%binaryPath%',type:'string',default:'',scope:'global'}}},null,2));
 await fs.writeFile(path.join(dir,'plugin.js'),'globalThis.sagePlugin={services:{}};\n');
 await fs.writeFile(path.join(dir,'engine.js'),`// CommonJS engine adapter. Bundle dependencies into this file.
/** @type {import('./sage-engine').EngineAdapter['apiVersion']} */
exports.apiVersion = 1;
/** @type {import('./sage-engine').EngineAdapter['run']} */
exports.run = async function(options, settings) {
  // options: cwd, prompt, history, images, resume, readOnly, signal,
  // onText, onSessionId, canUseTool, askUser, onToolUse, onToolResult.
  // Implement your CLI protocol here. Always stop child processes in finally.
  // Honor signal; disable native side-effect tools and route them through Sage.
  if (options.signal?.aborted) return {text:'',error:'aborted'};
  return {text:'',error:'Implement the CLI adapter in engine.js first'};
};\n`);
  const {app}=await import('electron');
  const sdkPath=app.isPackaged?path.join(process.resourcesPath,'plugin-sdk','sage-engine.d.ts'):path.join(app.getAppPath(),'resources/plugin-sdk/sage-engine.d.ts');
  await fs.copyFile(sdkPath,path.join(dir,'sage-engine.d.ts'));
  await fs.mkdir(path.join(dir,'docs'));
  await fs.writeFile(path.join(dir,'docs/README.md'),'# CLI engine plugin\n\nImplement API v1 in engine.js using sage-engine.d.ts. See Sage docs/BACKEND_ENGINES.md. Load this directory in Global → Plugins with a test project open. Enable globally and select under General → Backend. Export the plugin when ready.\n');return dir;
}
