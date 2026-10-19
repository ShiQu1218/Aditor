# scripts/fetch-obs-hook.ps1
# 下載並驗證 OBS Studio 官方發行的 graphics-hook 檔案（供遊戲擷取注入使用）。
#
# 為何必須使用 OBS 官方簽章版本：
#   反作弊系統（如 Easy Anti-Cheat / BattlEye）係依據 OBS 官方的數位簽章憑證
#   （CN="OBS Project, LLC"）放行 graphics-hook64.dll；自行編譯或自行簽章的二進位檔不會被放行。
#
# 要升級 OBS hook 版本：
#   1. 修改下方 $version、$expectedZipSha256，以及 $expectedFiles 內三個檔案的 SHA-256 雜湊值
#      （若官方更新簽章憑證，亦需確認 $expectedSigner）。
#   2. 同步更新 THIRD_PARTY_NOTICES.md 中 OBS Studio graphics-hook 段落的版本與原始碼連結。
param(
    [string]$TargetDir = "$PSScriptRoot\..\build\obs-hook"
)

$ErrorActionPreference = "Stop"

$version = "32.1.2"
$asset = "OBS-Studio-$version-Windows-x64.zip"
$expectedZipSha256 = "8D97E4563BD8D22D03E63042AA7DCCEDE1D555C9BD35CE8A9E5019B0D0201BF6"
$url = "https://github.com/obsproject/obs-studio/releases/download/$version/$asset"
$zipEntryPrefix = "data/obs-plugins/win-capture/"
$expectedSigner = 'CN="OBS Project, LLC"'

$expectedFiles = [ordered]@{
    "graphics-hook64.dll"        = "F89ADE59480DE0D55FCC100495D78E8E491BED469FAB4DBD3D430837B58B27A5"
    "inject-helper64.exe"        = "B5C975E1025D225955EFC1E4F28445D8CAF8A6527DF47FDC28D358AFF0227AD6"
    "get-graphics-offsets64.exe" = "9F53513188D545DDFDFEC6C280380BE896E44E4A44958E6B7BACB84C57746F54"
}

$targetFullPath = [System.IO.Path]::GetFullPath($TargetDir)

# 若 TargetDir 已有三個檔案且雜湊全部正確，直接成功（不重新下載）
$allValid = $true
if (Test-Path $targetFullPath) {
    foreach ($fileName in $expectedFiles.Keys) {
        $existingPath = Join-Path $targetFullPath $fileName
        if (-not (Test-Path $existingPath)) {
            $allValid = $false
            break
        }
        $existingHash = (Get-FileHash -Path $existingPath -Algorithm SHA256).Hash
        if ($existingHash -ne $expectedFiles[$fileName]) {
            Write-Host "SHA256 mismatch on existing $fileName (expected $($expectedFiles[$fileName]), got $existingHash); will re-extract."
            $allValid = $false
            break
        }
    }
} else {
    $allValid = $false
}

if ($allValid) {
    Write-Host "✓ OBS hook files already exist and match pinned SHA256 in $targetFullPath"
    return
}

$buildDir = [System.IO.Path]::GetFullPath("$PSScriptRoot\..\build")
if (-not (Test-Path $buildDir)) {
    New-Item -ItemType Directory -Path $buildDir | Out-Null
}

$zipPath = Join-Path $buildDir "obs-studio-$version-x64.zip"

if (-not (Test-Path $zipPath)) {
    Write-Host "Downloading OBS Studio $version from $url..."
    Invoke-WebRequest -Uri $url -OutFile $zipPath
} else {
    Write-Host "Found existing download at $zipPath"
}

$actualZipSha256 = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash
Write-Host "Verifying zip SHA256: $actualZipSha256"
if ($actualZipSha256 -ne $expectedZipSha256) {
    # 不符就失敗：不解壓、不打包未驗證的二進位。舊版下載請刪除 $zipPath 後重跑。
    throw "FATAL: SHA256 mismatch for $asset! Expected $expectedZipSha256, got $actualZipSha256. Delete $zipPath and retry, or update the pinned values deliberately."
}

if (-not (Test-Path $targetFullPath)) {
    New-Item -ItemType Directory -Path $targetFullPath -Force | Out-Null
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

Write-Host "Extracting OBS hook files to $targetFullPath..."
$zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
    foreach ($fileName in $expectedFiles.Keys) {
        $entryPath = "$zipEntryPrefix$fileName"
        $entry = $zip.GetEntry($entryPath)
        if ($null -eq $entry) {
            throw "FATAL: Entry '$entryPath' not found inside $zipPath"
        }
        $destPath = Join-Path $targetFullPath $fileName
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destPath, $true)
    }
} finally {
    $zip.Dispose()
}

function Remove-ExtractedHookFiles {
    foreach ($f in $expectedFiles.Keys) {
        $p = Join-Path $targetFullPath $f
        if (Test-Path $p) {
            Remove-Item -Path $p -Force -ErrorAction SilentlyContinue
        }
    }
}

foreach ($fileName in $expectedFiles.Keys) {
    $filePath = Join-Path $targetFullPath $fileName
    $expectedFileSha256 = $expectedFiles[$fileName]
    $actualFileSha256 = (Get-FileHash -Path $filePath -Algorithm SHA256).Hash
    Write-Host "Verifying SHA256 for ${fileName}: $actualFileSha256"
    if ($actualFileSha256 -ne $expectedFileSha256) {
        Remove-ExtractedHookFiles
        throw "FATAL: SHA256 mismatch for $fileName! Expected $expectedFileSha256, got $actualFileSha256."
    }
}

foreach ($fileName in $expectedFiles.Keys) {
    $filePath = Join-Path $targetFullPath $fileName
    $sig = Get-AuthenticodeSignature -FilePath $filePath
    $subject = if ($null -ne $sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { "" }
    Write-Host "Verifying Authenticode for ${fileName}: Status=$($sig.Status), Subject=$subject"
    if ($sig.Status -ne "Valid" -or -not $subject.Contains($expectedSigner)) {
        Remove-ExtractedHookFiles
        throw "FATAL: Authenticode signature verification failed for $fileName! Expected Status=Valid and Subject containing '$expectedSigner', got Status=$($sig.Status), Subject='$subject'."
    }
}

Write-Host "✓ OBS hook verification passed: SHA256 and Authenticode signature ($expectedSigner) verified."
