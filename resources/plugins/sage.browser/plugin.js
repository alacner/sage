globalThis.sagePlugin={services:{automation:{
  ...Object.fromEntries(["create", "list", "close", "navigate", "back", "forward", "reload", "snapshot", "screenshot", "click", "fill", "select", "press", "scroll", "wait", "console", "show", "hide", "pause", "resume", "evaluate", "cdp", "frames", "upload", "download"].map(method=>[method,(args,sdk)=>sdk.host("browser",method,args)])),
  tabs:(_args,sdk)=>sdk.host("browser","tabs"),
  attach:({tabId},sdk)=>sdk.host("browser","attach",{id:tabId})
}}};
