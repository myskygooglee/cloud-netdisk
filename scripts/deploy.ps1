# 构建并部署到 vault 的插件目录
$ErrorActionPreference = "Stop"

$Repo = Split-Path -Parent $PSScriptRoot
$Vault = "D:\Books"
$Dest = Join-Path $Vault ".obsidian\plugins\obsidian-115"

Write-Host "[1/3] 构建…" -ForegroundColor Cyan
Push-Location $Repo
try {
    & npm run build
} finally {
    Pop-Location
}

Write-Host "[2/3] 复制到 vault…" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
foreach ($f in @("manifest.json", "versions.json", "styles.css")) {
    Copy-Item (Join-Path $Repo $f) (Join-Path $Dest $f) -Force
}
Copy-Item (Join-Path $Repo "dist\main.js") (Join-Path $Dest "main.js") -Force
if (Test-Path (Join-Path $Repo "dist\main.js.map")) {
    Copy-Item (Join-Path $Repo "dist\main.js.map") (Join-Path $Dest "main.js.map") -Force
}

Write-Host "[3/3] 提示…" -ForegroundColor Cyan
Write-Host "已部署到 $Dest"
Write-Host "接下来：Obsidian 设置 → 第三方插件 → 重新加载 obsidian-115（或重启 Obsidian）"
