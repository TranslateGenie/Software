# Packages each Lambda function into a zip file ready for AWS upload.
# Run from the lambda/ directory: .\package-lambdas.ps1

$ErrorActionPreference = 'Stop'

$outDir = Join-Path $PSScriptRoot 'dist'
if (Test-Path $outDir) { Remove-Item $outDir -Recurse -Force }
New-Item -ItemType Directory $outDir | Out-Null

$shared = @('storage.mjs', 'package.json', 'node_modules')
$functions = @('create-checkout', 'square-webhook')

foreach ($fn in $functions) {
    $tmpDir = Join-Path $outDir $fn
    New-Item -ItemType Directory $tmpDir | Out-Null

    # Copy shared files
    foreach ($item in $shared) {
        $src = Join-Path $PSScriptRoot $item
        Copy-Item $src $tmpDir -Recurse
    }

    # Copy the handler, rename to index.mjs
    $handlerSrc = Join-Path $PSScriptRoot "$fn.mjs"
    Copy-Item $handlerSrc (Join-Path $tmpDir 'index.mjs')

    # Zip it up
    $zipPath = Join-Path $outDir "$fn.zip"
    Compress-Archive -Path "$tmpDir\*" -DestinationPath $zipPath
    Remove-Item $tmpDir -Recurse -Force

    Write-Host "Packaged: dist\$fn.zip"
}

Write-Host "`nDone. Upload each zip to its Lambda function in the AWS Console."
