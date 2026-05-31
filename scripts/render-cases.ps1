param([string]$CasesJson, [string]$OutDir)
Add-Type -AssemblyName System.Drawing
$cases = Get-Content $CasesJson -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Force $OutDir | Out-Null
foreach ($c in $cases) {
  $w = [int]$c.w; $h = [int]$c.h
  $bmp = New-Object System.Drawing.Bitmap -ArgumentList $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $bg = [System.Drawing.Color]::FromArgb([int]$c.bg[0], [int]$c.bg[1], [int]$c.bg[2])
  $g.Clear($bg)
  $style = [System.Drawing.FontStyle]::Regular
  if ($c.bold)   { $style = $style -bor [System.Drawing.FontStyle]::Bold }
  if ($c.italic) { $style = $style -bor [System.Drawing.FontStyle]::Italic }
  $font = New-Object System.Drawing.Font([string]$c.font, [float]$c.size, $style, [System.Drawing.GraphicsUnit]::Pixel)
  $fg = [System.Drawing.Color]::FromArgb([int]$c.fg[0], [int]$c.fg[1], [int]$c.fg[2])
  $brush = New-Object System.Drawing.SolidBrush($fg)
  $lineH = [int]([float]$c.size * 1.5)
  $y = [int]([float]$c.size * 0.4)
  foreach ($line in $c.lines) {
    $g.DrawString([string]$line, $font, $brush, [float]8, [float]$y)
    $y += $lineH
  }
  # Optional second column (for multi-column reading-order tests).
  if ($c.rightLines) {
    $y2 = [int]([float]$c.size * 0.4)
    $rx = [float]([int]$c.w * 0.55)
    foreach ($line in $c.rightLines) {
      $g.DrawString([string]$line, $font, $brush, $rx, [float]$y2)
      $y2 += $lineH
    }
  }
  $brush.Dispose(); $font.Dispose(); $g.Dispose()
  $path = Join-Path $OutDir ($c.name + '.png')
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}
Write-Output ("Rendered " + $cases.Count + " images to " + $OutDir)
