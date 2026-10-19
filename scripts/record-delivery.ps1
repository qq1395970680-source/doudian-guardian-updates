$ErrorActionPreference = 'Stop'
$guardianRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$guardianProject = [IO.Path]::GetFullPath((Join-Path $guardianRoot '..'))
$guardianStatePath = Join-Path $guardianProject 'data\rebuild-v2-state.json'
$guardianState = Get-Content -LiteralPath $guardianStatePath -Encoding utf8 | ConvertFrom-Json
$guardianPackage = Get-Content -LiteralPath (Join-Path $guardianRoot 'artifacts\package-result.json') -Encoding utf8 | ConvertFrom-Json
$guardianVerification = Get-Content -LiteralPath (Join-Path $guardianRoot 'artifacts\package-verification.json') -Encoding utf8 | ConvertFrom-Json
$guardianStatus = Invoke-RestMethod -Uri 'http://127.0.0.1:19417/api/status' -TimeoutSec 5
$guardianChanges = @{
 status = 'v2-packaged-service-running-awaiting-dedicated-login'
 updatedAt = (Get-Date).ToUniversalTime().ToString('o')
 packageDirectory = $guardianPackage.directory
 packageZip = $guardianPackage.zip
 packageSha256 = $guardianPackage.zipSha256
 packageVerifiedFiles = $guardianVerification.manifestFiles
 serviceUrl = 'http://127.0.0.1:19417'
 runtimeDirectory = (Join-Path $env:LOCALAPPDATA 'DoudianDiscountGuardianV2')
 localValidation = '36 unit checks; 8 native headless browser checks across focused runs, including two full 5-product/50-SKU runs, wrong-price stop, transport loss, duplicate-result ambiguity, and workbench. See v2/VALIDATION.md and v2/artifacts.'
 liveAcceptance = $false
 productionExecutionEnabled = $guardianStatus.running
 connected = ($null -ne $guardianStatus.connection)
 pendingUserAction = '首次在后台工作台打开专用浏览器登录，完成后先做只读实店核验；尚未请求停止旧版或切换执行权。不要重复提醒已提出的登录请求。'
 next = '验证专用浏览器已登录，再只读核验真实全店列表/历史/当前规格；新旧写入切换仍须确认旧版已停止。不得把本地模拟通过记成实店恢复成功。'
 evidence = @('v2/VALIDATION.md','v2/artifacts/package-verification.json','v2/artifacts/archive-verification.json','v2/artifacts/source-check.json','v2/artifacts/headless-flow-1440.json','v2/artifacts/headless-flow-960.json','v2/artifacts/dropAfterSubmit.json','v2/artifacts/abortBeforeHeaders.json')
 }
foreach ($key in $guardianChanges.Keys) { $guardianState | Add-Member -NotePropertyName $key -NotePropertyValue $guardianChanges[$key] -Force }
$guardianState | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $guardianStatePath -Encoding utf8
$guardianReviewPath = Join-Path $guardianProject 'data\log-review-state.json'
$guardianReview = Get-Content -LiteralPath $guardianReviewPath -Encoding utf8 | ConvertFrom-Json
$guardianReview.verificationStatus = 'v2-rebuild-awaiting-first-dedicated-login; old extension read-only monitoring only'
$guardianReview.blocker = 'v2 is packaged and running locally. First dedicated login request already sent. Read data/rebuild-v2-state.json before continuing. Do not return to old patch/reload cycle or repeat unchanged login reminder.'
$guardianReview | ConvertTo-Json -Depth 50 | Set-Content -LiteralPath $guardianReviewPath -Encoding utf8
Write-Output '交付状态已记录；实店验收仍未完成。'
