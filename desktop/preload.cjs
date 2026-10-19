const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('guardianDesktop',{
 version:process.argv.find(a=>a.startsWith('--guardian-version='))?.split('=')[1]||'',
 checkUpdates:()=>ipcRenderer.invoke('guardian-update-check'),
 installUpdate:()=>ipcRenderer.invoke('guardian-update-install'),
 updateStatus:()=>ipcRenderer.invoke('guardian-update-status'),
 onUpdate:callback=>{if(typeof callback==='function')ipcRenderer.on('guardian-update-state',(_event,value)=>callback(value));}
});
