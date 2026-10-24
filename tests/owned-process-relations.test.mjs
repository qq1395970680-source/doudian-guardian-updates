import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
test('native ownership ignores older recycled parent-PID links and still rejects newly started unknown children',{skip:process.platform!=='win32',timeout:60000},async()=>{
 const {stdout}=await promisify(execFile)('pwsh.exe',['-NoLogo','-File',fileURLToPath(new URL('../scripts/test-owned-process-relations.ps1',import.meta.url))],{windowsHide:true});
 const result=JSON.parse(stdout.trim());assert.equal(result.passed,4);assert.equal(result.olderParentPidLinksIgnored,true);assert.equal(result.newUnknownChildStillRejected,true);
});
