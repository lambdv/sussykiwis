param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ComposeArgs
)

$ErrorActionPreference = 'Stop'

$RootDir = Split-Path -Parent $PSCommandPath
$ComposeFile = Join-Path $RootDir 'container/docker-compose.yml'
$ProjectName = 'kiwi-dev'
$AppContainer = 'kiwi-app'
$TunnelContainer = 'kiwi-cloudflared'
$HostsTag = '# kiwi-dev-cloudflared'

function Compose {
    & docker compose -p $ProjectName -f $ComposeFile @args
}

function Cleanup-Stack {
    Write-Host ""
    Write-Host "Cleaning up old app/tunnel containers..."

    try {
        Compose down --remove-orphans --timeout 2 | Out-Host
    } catch {
        # Ignore cleanup failures, because force-removal below handles interrupted runs.
    }

    try {
        $ids = @(& docker ps -aq --filter "label=com.docker.compose.project=$ProjectName" 2>$null)
        $ids = @($ids | Where-Object { $_ -and $_.Trim().Length -gt 0 })

        if ($ids.Count -gt 0) {
            & docker rm -f @ids 2>$null | Out-Null
        }
    } catch {
    }

    try {
        & docker rm -f $TunnelContainer $AppContainer 2>$null | Out-Null
    } catch {
    }
}

function Test-IsAdmin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Remove-HostsEntryForTag {
    if (-not (Test-IsAdmin)) {
        return
    }

    $hostsPath = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'

    try {
        $lines = @(Get-Content -LiteralPath $hostsPath -ErrorAction Stop)
        $filtered = @($lines | Where-Object { $_ -notmatch [regex]::Escape($HostsTag) })

        if ($filtered.Count -ne $lines.Count) {
            Set-Content -LiteralPath $hostsPath -Value $filtered -Encoding ascii
        }
    } catch {
        Write-Host "Warning: could not clean old hosts entries."
    }
}

function Add-HostsEntry {
    param(
        [string]$HostName,
        [string]$Ip
    )

    if (-not (Test-IsAdmin)) {
        Write-Host "Tip: run PowerShell as Administrator to pin this hostname in hosts for the browser."
        return
    }

    $hostsPath = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'

    Remove-HostsEntryForTag

    try {
        Add-Content -LiteralPath $hostsPath -Value "$Ip $HostName $HostsTag"
        & ipconfig /flushdns | Out-Null
        Write-Host "Pinned hosts entry: $HostName -> $Ip"
    } catch {
        Write-Host "Warning: failed to patch hosts."
    }
}

function Get-TunnelUrl {
    for ($i = 0; $i -lt 45; $i++) {
        $text = ""
        try {
            $text = (& docker logs $TunnelContainer 2>&1) -join "`n"
        } catch {
            $text = ""
        }

        $matches = [regex]::Matches($text, 'https://[a-z0-9-]+\.trycloudflare\.com')
        if ($matches.Count -gt 0) {
            return $matches[$matches.Count - 1].Value
        }

        Start-Sleep -Seconds 1
    }

    return $null
}

function Wait-TunnelRegistered {
    for ($i = 1; $i -le 45; $i++) {
        try {
            $text = (& docker logs $TunnelContainer 2>&1) -join "`n"

            if ($text -match 'Registered tunnel connection') {
                return $true
            }
        } catch {
        }

        Start-Sleep -Seconds 1
    }

    return $false
}

function Wait-LocalAppReady {
    for ($i = 1; $i -le 30; $i++) {
        try {
            $status = & curl.exe `
                --silent `
                --show-error `
                --connect-timeout 2 `
                --max-time 4 `
                --output NUL `
                --write-out "%{http_code}" `
                'http://localhost:8080/healthz' 2>$null

            if ($LASTEXITCODE -eq 0 -and $status -eq '200') {
                return $true
            }
        } catch {
        }

        Start-Sleep -Seconds 1
    }

    return $false
}

function Resolve-PublicARecord {
    param(
        [string]$TunnelUrl,
        [int]$TimeoutSeconds = 45
    )

    if (-not $TunnelUrl) {
        return $null
    }

    if (-not (Get-Command Resolve-DnsName -ErrorAction SilentlyContinue)) {
        return $null
    }

    $hostName = ([Uri]$TunnelUrl).Host
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)

    while ((Get-Date) -lt $deadline) {
        foreach ($server in @('1.1.1.1', '8.8.8.8')) {
            try {
                $records = @(Resolve-DnsName $hostName -Type A -Server $server -ErrorAction SilentlyContinue)
                $answer = $records | Where-Object { $_.Type -eq 'A' -and $_.IPAddress } | Select-Object -First 1

                if ($answer) {
                    return $answer.IPAddress
                }
            } catch {
            }
        }

        Write-Host "Waiting for public DNS for $hostName..."
        Start-Sleep -Seconds 2
    }

    return $null
}

function Test-TunnelViaResolvedIp {
    param(
        [string]$TunnelUrl,
        [string]$Ip
    )

    if (-not $TunnelUrl) {
        return $false
    }

    if (-not $Ip) {
        return $false
    }

    $uri = [Uri]$TunnelUrl
    $hostName = $uri.Host
    $healthUrl = "https://$hostName/healthz"
    $resolveArg = "$hostName`:443`:$Ip"

    try {
        $status = & curl.exe `
            --silent `
            --show-error `
            --location `
            --connect-timeout 5 `
            --max-time 10 `
            --output NUL `
            --write-out "%{http_code}" `
            --resolve $resolveArg `
            $healthUrl 2>$null

        return $LASTEXITCODE -eq 0 -and $status -eq '200'
    } catch {
        return $false
    }
}

function Start-FreshTunnelAttempt {
    param([int]$Attempt)

    Write-Host ""
    Write-Host "Starting quick tunnel attempt $Attempt..."

    try {
        & docker rm -f $TunnelContainer 2>$null | Out-Null
    } catch {
    }

    Compose up --force-recreate --no-deps -d cloudflared | Out-Host

    $TunnelUrl = Get-TunnelUrl
    if (-not $TunnelUrl) {
        Write-Host "No trycloudflare URL appeared."
        return $null
    }

    Write-Host "Tunnel URL found: $TunnelUrl"

    if (-not (Wait-TunnelRegistered)) {
        Write-Host "Tunnel URL appeared, but cloudflared did not register a connection."
        return $null
    }

    $publicIp = Resolve-PublicARecord $TunnelUrl
    if (-not $publicIp) {
        Write-Host "Could not resolve the hostname through public DNS after waiting, so this tunnel is not trusted yet."
        return $null
    }

    Write-Host "Public DNS resolved to: $publicIp"

    if (-not (Test-TunnelViaResolvedIp $TunnelUrl $publicIp)) {
        Write-Host "Public tunnel check failed for /healthz."
        return $null
    }

    Add-HostsEntry -HostName ([Uri]$TunnelUrl).Host -Ip $publicIp
    return $TunnelUrl
}

$exitCode = 0

try {
    Remove-HostsEntryForTag
    Cleanup-Stack

    $upArgs = @('up', '--build', '--force-recreate', '--remove-orphans', '-d', 'app') + $ComposeArgs
    Compose @upArgs

    if (-not (Wait-LocalAppReady)) {
        throw 'Local app did not become healthy at http://localhost:8080/healthz'
    }

    $TunnelUrl = $null
    for ($attempt = 1; $attempt -le 6; $attempt++) {
        $TunnelUrl = Start-FreshTunnelAttempt -Attempt $attempt
        if ($TunnelUrl) {
            break
        }
    }

    Write-Host ""
    if ($TunnelUrl) {
        Write-Host "Tunnel ready: $TunnelUrl"
    } else {
        Write-Host "Failed to validate a quick tunnel after multiple attempts."
    }
    Write-Host "Local fallback: http://localhost:8080"
    Write-Host ""

    Compose logs -f
    $exitCode = $LASTEXITCODE
} catch {
    Write-Error $_
    $exitCode = 1
} finally {
    Remove-HostsEntryForTag
    Cleanup-Stack
}

exit $exitCode
