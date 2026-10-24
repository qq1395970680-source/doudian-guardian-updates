const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('guardianDesktop',{
 version:process.argv.find(a=>a.startsWith('--guardian-version='))?.split('=')[1]||'',
 checkUpdates:()=>ipcRenderer.invoke('guardian-update-check'),
 installUpdate:()=>ipcRenderer.invoke('guardian-update-install'),
 updateStatus:()=>ipcRenderer.invoke('guardian-update-status'),
 backendUpgradeStatus:()=>ipcRenderer.invoke('guardian-backend-upgrade-status'),
 retryBackendUpgrade:()=>ipcRenderer.invoke('guardian-backend-upgrade-retry'),
 saveTransfer:file=>ipcRenderer.invoke('guardian-transfer-save',file),
 chooseTransfer:()=>ipcRenderer.invoke('guardian-transfer-choose'),
 action:action=>ipcRenderer.invoke('guardian-desktop-action',action),
 onUpdate:callback=>{if(typeof callback==='function')ipcRenderer.on('guardian-update-state',(_event,value)=>callback(value));},
 onBackendUpgrade:callback=>{if(typeof callback==='function')ipcRenderer.on('guardian-backend-upgrade-state',(_event,value)=>callback(value));}
});
