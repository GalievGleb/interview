param(
    [switch]$ListOnly,
    [switch]$SkipLiveModel,
    [switch]$SkipVisual,
    [switch]$SkipFastSoak,
    [switch]$Run95MinuteSoak
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$ApiRoot = Join-Path $RepoRoot 'apps\api-py'
$Python = Join-Path $ApiRoot '.venv\Scripts\python.exe'
$OutputRoot = Join-Path $RepoRoot 'output\verification\real-interview-overlay'

function Format-Argument([string]$Value) {
    if ($Value -match '[\s"]') {
        return '"' + $Value.Replace('"', '\"') + '"'
    }
    return $Value
}

function Invoke-Gate {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [string]$WorkingDirectory = $RepoRoot
    )
    $Display = @($Executable) + $Arguments | ForEach-Object { Format-Argument $_ }
    Write-Host ("GATE {0}: {1}" -f $Name, ($Display -join ' '))
    if ($ListOnly) { return }

    Push-Location $WorkingDirectory
    try {
        & $Executable @Arguments
        $Code = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
    if ($Code -ne 0) {
        throw ("FAILED {0} (exit {1}): {2}" -f $Name, $Code, ($Display -join ' '))
    }
}

if (-not $ListOnly) {
    New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null
}

Invoke-Gate -Name 'harness-unit' -Executable $Python -Arguments @(
    '-m', 'pytest',
    '.\tools\tests\test_real_interview_acceptance.py',
    '.\tools\tests\test_verify_long_live_session.py',
    '.\tools\tests\test_verify_screen_code_task.py',
    '.\tools\tests\test_verify_real_interview_overlay.py',
    '-q'
)

Invoke-Gate -Name 'source-ui-guard-unit' -Executable 'node' -WorkingDirectory (Join-Path $RepoRoot 'apps\desktop') -Arguments @(
    '--test', 'tools\source-ui-vite-guard.test.mjs'
)

Invoke-Gate -Name 'api-sequence' -Executable $Python -WorkingDirectory $ApiRoot -Arguments @(
    '-m', 'pytest',
    'tests\test_real_interview_overlay_regressions.py',
    'tests\test_chat_review.py',
    'tests\test_provider_adapter.py',
    'tests\test_provider_live.py',
    '-q'
)
Invoke-Gate -Name 'api-ruff' -Executable $Python -WorkingDirectory $ApiRoot -Arguments @(
    '-m', 'ruff', 'check', 'app', 'tests'
)

Invoke-Gate -Name 'desktop-sequence' -Executable 'pnpm' -Arguments @(
    '--filter', '@interview/desktop', 'exec', 'vitest', 'run',
    'electron/queuedRendererSignal.test.ts',
    'electron/persistentGlobalShortcut.test.ts',
    'src/test-lab/realInterviewOverlayRegression.test.ts',
    'src/lib/candidateFollowUp.test.ts',
    'src/lib/latestForcedAnswer.test.ts',
    'src/lib/screenRequestCoordinator.test.ts',
    'src/lib/screenFrameMemory.test.ts',
    'src/lib/screenAssistStream.test.ts',
    'src/components/MarkdownText.test.ts',
    'src/pages/OverlayPage.behavior.test.ts',
    '--reporter=dot'
)

Invoke-Gate -Name 'desktop-full' -Executable 'pnpm' -Arguments @(
    '--filter', '@interview/desktop', 'test'
)
Invoke-Gate -Name 'desktop-typecheck' -Executable 'pnpm' -Arguments @(
    '--filter', '@interview/desktop', 'typecheck'
)
Invoke-Gate -Name 'electron-typecheck' -Executable 'pnpm' -Arguments @(
    '--filter', '@interview/desktop', 'exec', 'tsc', '--noEmit', '-p', 'tsconfig.electron.json'
)
Invoke-Gate -Name 'api-full' -Executable $Python -WorkingDirectory $ApiRoot -Arguments @(
    '-m', 'pytest', '-q'
)
Invoke-Gate -Name 'workspace-build' -Executable 'pnpm' -Arguments @('build')

if (-not $SkipLiveModel) {
    Invoke-Gate -Name 'screen-live-3x3' -Executable $Python -Arguments @(
        '.\tools\verify_screen_code_task.py',
        '--source-backend',
        '--real-interview-regressions',
        '--repetitions', '3',
        '--report', (Join-Path $OutputRoot 'screen-live.json')
    )
}

if (-not $SkipVisual) {
    Invoke-Gate -Name 'source-overlay-ui' -Executable 'pnpm' -Arguments @(
        '--filter', '@interview/desktop', 'verify:source:overlay-ui'
    )
}

if (-not $SkipFastSoak) {
    Invoke-Gate -Name 'soak-smoke' -Executable $Python -Arguments @(
        '.\tools\verify_long_live_session.py',
        '--source-backend',
        '--duration-minutes', '1.5',
        '--checkpoint-minutes', '0,0.5,1.1',
        '--screen-checkpoint-minutes', '0.25,1.25',
        '--report', (Join-Path $OutputRoot 'soak-smoke.json')
    )
}

if ($Run95MinuteSoak) {
    Invoke-Gate -Name 'soak-95m' -Executable $Python -Arguments @(
        '.\tools\verify_long_live_session.py',
        '--source-backend',
        '--duration-minutes', '95',
        '--checkpoint-minutes', '0,30,61,91',
        '--screen-checkpoint-minutes', '2,62,92',
        '--report', (Join-Path $OutputRoot 'soak-95m.json')
    )
}

if ($ListOnly) {
    Write-Host ("LIST ONLY {0} NO GATES EXECUTED" -f [char]0x2014)
}
else {
    Write-Host 'ALL REQUESTED REAL-INTERVIEW OVERLAY GATES PASSED'
}
