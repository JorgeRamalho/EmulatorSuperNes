$origem = "C:\Users\jorge\Downloads\Donkey Kong Country (USA).sfc"
$destinoDir = Join-Path $PSScriptRoot "..\games\roms"
$destino = Join-Path $destinoDir "donkey-kong-country-usa.sfc"

if (-not (Test-Path $origem)) {
  Write-Error "Arquivo não encontrado: $origem"
  exit 1
}

New-Item -ItemType Directory -Path $destinoDir -Force | Out-Null
Copy-Item -Path $origem -Destination $destino -Force
Write-Host "ROM copiada para $destino ($((Get-Item $destino).Length) bytes)"
