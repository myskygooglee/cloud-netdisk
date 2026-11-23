# 构建并部署到 vault 的插件目录
$ErrorActionPreference = "Stop"

$Repo = Split-Path -Parent $PSScriptRoot

# vault 路径：可用 -Vault 参数覆盖；默认取本机上已知的库
$VaultArg = $null
if ($args -contains "-Vault") { $VaultArg = $args[($args.IndexOf("-Vault") + 1)] }
if (-not $VaultArg) {
    $known = @("F:\[ob]myskygooglee", "F:\[ob]LR-working", "D:\Books")
    $VaultArg = $known | Where-Object { Test-Path -LiteralPath (Join-Path $_ ".obsidian") } | Select-Object -First 1
}
if (-not $VaultArg) { throw "vault not found; pass -Vault <path>" }

$Vault = $VaultArg
$Dest = Join-Path $Vault ".obsidian\plugins\cloud-netdisk"

Write-Host "[1/3] 构建…" -ForegroundColor Cyan
Push-Location $Repo
try {
    & npm run build
} finally {
    Pop-Location
}

Write-Host "[2/3] 复制到 vault…" -ForegroundColor Cyan
# 目标路径含 [ ]（vault 名），New-Item / Copy-Item 的 -Path 会当通配符解析，
# 一律走 .NET API 按字面路径处理。
[System.IO.Directory]::CreateDirectory($Dest) | Out-Null
foreach ($f in @("manifest.json", "versions.json", "styles.css")) {
    [System.IO.File]::Copy((Join-Path $Repo $f), (Join-Path $Dest $f), $true)
}
[System.IO.File]::Copy((Join-Path $Repo "dist\main.js"), (Join-Path $Dest "main.js"), $true)
if (Test-Path -LiteralPath (Join-Path $Repo "dist\main.js.map")) {
    [System.IO.File]::Copy((Join-Path $Repo "dist\main.js.map"), (Join-Path $Dest "main.js.map"), $true)
}

Write-Host "[3/3] 提示…" -ForegroundColor Cyan
Write-Host "已部署到 $Dest"
Write-Host "接下来：Obsidian 设置 → 第三方插件 → 重新加载 cloud-netdisk（或重启 Obsidian）"
