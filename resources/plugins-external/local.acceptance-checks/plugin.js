globalThis.sagePlugin={services:{checks:{ready:({dom})=>({
 passed:dom?.ready==='complete'&&typeof dom.title==='string'&&dom.title.trim().length>0,
 detail:dom?.ready==='complete'&&dom?.title?.trim()?'Document ready with a title':'Document must finish loading and have a title'
})}}};
