# Desktop toast for the JD babel push loop.
# Pure ASCII source on purpose (works in Windows PowerShell 5.1 without a BOM);
# the Chinese title is read from data/push/latest.txt as UTF-8.
# No-op when the round has no added / removed / changed items.

$ErrorActionPreference = 'SilentlyContinue'

$root = Split-Path -Parent $PSScriptRoot
$jsonl = Join-Path $root 'data\push\feed.jsonl'
$latest = Join-Path $root 'data\push\latest.txt'
$dashboard = Join-Path $root 'data\push\dashboard.html'

if (-not (Test-Path $jsonl)) { exit 0 }
$last = Get-Content -Path $jsonl -Tail 1 -Encoding UTF8
if (-not $last) { exit 0 }
try { $row = $last | ConvertFrom-Json } catch { exit 0 }

$added = [int]$row.added
$removed = [int]$row.removed
$changed = [int]$row.changed
if (($added + $removed + $changed) -le 0) { exit 0 }

$title = 'JD Babel'
if (Test-Path $latest) {
  $first = Get-Content -Path $latest -TotalCount 1 -Encoding UTF8
  if ($first) { $title = $first.Trim() }
}
$body = "NEW $added   DROP $removed   CHG $changed   |   total $($row.count)"

[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

$esc = { param($s) $s -replace '&', '&amp;' -replace '<', '&lt;' -replace '>', '&gt;' }
$xmlText = @"
<toast activationType="protocol" launch="file:///$($dashboard -replace '\\','/')">
  <visual>
    <binding template="ToastGeneric">
      <text>$(& $esc $title)</text>
      <text>$(& $esc $body)</text>
    </binding>
  </visual>
</toast>
"@

$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($xmlText)
$toast = New-Object Windows.UI.Notifications.ToastNotification $xml
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
