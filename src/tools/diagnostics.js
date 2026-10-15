import { z } from 'zod';
import { deviceResult, errorResult, trimLines, psQuote } from '../safety.js';

// RF — built-in diagnostics.
//
// Fixed, tested read-only scripts for the questions asked on every support call,
// so the model does not improvise long scripts (which time out, need approval,
// and block the device). Parameters are validated and quoted before they reach
// a script; nothing user-supplied is ever interpolated raw.
// Windows events that are known noise, left out of the health check's and the
// chat diagnostics' error summaries (mesh_event_log still returns them). Each
// is counted and reported as ignored, never dropped silently. Only add events
// that are harmless on every machine they appear on.
export const DEFAULT_IGNORED_EVENTS = [
  { provider: 'vmStatsProvider', ids: [257, 259], reason: 'VMware Tools installed on a machine that is not a VMware VM' },
];

// PowerShell that loads System+Application events of the given levels from the
// last `hours` into `$<name>`, leaving out `ignored` (provider + IDs) before the
// -MaxEvents cap, and counts what was left out into `$<name>_ignored`.
// Provider names are validated in config (no quotes), IDs are integers.
export function winEventsScript(name, { hours, levels, max, ignored }) {
  const ms = Math.round(hours * 3_600_000);
  const select = `*[System[(${levels.map((l) => `Level=${l}`).join(' or ')}) and TimeCreated[timediff(@SystemTime) &lt;= ${ms}]]]`;
  const suppress = ignored.map((e) =>
    `*[System[Provider[@Name="${e.provider}"] and (${e.ids.map((i) => `EventID=${i}`).join(' or ')})]]`);
  const xml = '<QueryList><Query Id="0">' + ['System', 'Application'].map((log) =>
    `<Select Path="${log}">${select}</Select>` + suppress.map((x) => `<Suppress Path="${log}">${x}</Suppress>`).join('')
  ).join('') + '</Query></QueryList>';
  const counts = ignored.map((e) =>
    `[pscustomobject]@{ source = '${e.provider} ${e.ids.join('/')}'; events = @(Get-WinEvent -FilterHashtable @{ ProviderName = '${e.provider}'; ` +
    `Id = ${e.ids.join(', ')}; Level = ${levels.join(', ')}; StartTime = (Get-Date).AddHours(-${hours}) } -MaxEvents 50000).Count }`);
  return `$${name} = @(Get-WinEvent -FilterXml ([xml]'${xml}') -MaxEvents ${max})\n` +
    `$${name}_ignored = @(${counts.join(', ')}) | Where-Object { $_.events -gt 0 }`;
}

export default function register(ctx) {
  const { define, requireNode, isWindowsNode, runShell, withProgress, config = {} } = ctx;
  const ignoredEvents = [...(config.ignoreDefaultEvents === false ? [] : DEFAULT_IGNORED_EVENTS), ...(config.ignoreEvents ?? [])];

  // ── quoting helpers ───────────────────────────────────────────────────────
  const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const SAFE_NAME = /^[\w .\/@$:()-]{1,200}$/; // log, provider, unit and service names

  async function targets({ node_id, node_ids }) {
    const refs = [...(node_id ? [node_id] : []), ...(node_ids ?? [])];
    if (!refs.length) throw new Error('Provide node_id or node_ids.');
    const out = [];
    for (const r of refs) {
      const n = await requireNode(r);
      if (!out.some((x) => x._id === n._id)) out.push(n);
    }
    return out;
  }

  // Run per device in parallel; returns [{ node, out | error }].
  const perDevice = (nodes, fn) => Promise.all(nodes.map(async (node) => {
    try { return { node, out: await fn(node) }; } catch (err) { return { node, error: err.message }; }
  }));

  // ════════════════════════════════════════════════════════════════════════
  // Health check
  // ════════════════════════════════════════════════════════════════════════

  const WIN_HEALTH = (days, deep) => `
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$r = [ordered]@{}
$os = Get-CimInstance Win32_OperatingSystem
$r.host = $env:COMPUTERNAME
$r.os = "$($os.Caption) ($($os.Version))"
$r.last_boot = $os.LastBootUpTime.ToString('s')
$r.uptime_days = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalDays, 1)
$r.memory_gb = [ordered]@{ total = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1); free = [math]::Round($os.FreePhysicalMemory / 1MB, 1) }
$r.cpu_load_pct = [math]::Round((Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average, 0)
$r.disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
  [ordered]@{ drive = $_.DeviceID; size_gb = [math]::Round($_.Size / 1GB, 1); free_gb = [math]::Round($_.FreeSpace / 1GB, 1)
    free_pct = $(if ($_.Size) { [math]::Round(100 * $_.FreeSpace / $_.Size, 1) } else { $null }) } })
$ignore = '^(gupdate|gupdatem|edgeupdate|edgeupdatem|GoogleUpdater.*|MapsBroker|RemoteRegistry|sppsvc|WbioSrvc|tiledatamodelsvc|CDPSvc|BITS|wuauserv|TrustedInstaller|ShellHWDetection|WSearch|DoSvc|UsoSvc|clr_optimization.*|stisvc|camsvc|WaaSMedicSvc|IntelAudioService|RtkAudioUniversalService|AGMService|AGSService|SysMain|Wcmsvc|NetTcpPortSharing|DPS|TabletInputService|cbdhsvc_.*|OneSyncSvc_.*|WpnUserService_.*|CDPUserSvc_.*|DevicesFlowUserSvc_.*|MSDTC)$'
$r.stopped_auto_services = @(Get-Service | Where-Object { $_.StartType -eq 'Automatic' -and $_.Status -ne 'Running' -and $_.Name -notmatch $ignore } |
  ForEach-Object { "$($_.Name) ($($_.DisplayName))" })
$since = (Get-Date).AddDays(-${days})
${winEventsScript('ev', { hours: days * 24, levels: [1, 2], max: 3000, ignored: ignoredEvents })}
$r.ignored_noise = @($ev_ignored)
$r.errors_in_window = $ev.Count
$r.top_errors = @($ev | Group-Object LogName, ProviderName, Id | Sort-Object Count -Descending | Select-Object -First 10 | ForEach-Object {
  $e = $_.Group[0]; $m = "$($e.Message)" -replace '\\s+', ' '
  [ordered]@{ count = $_.Count; log = $e.LogName; source = $e.ProviderName; id = $e.Id; last = $e.TimeCreated.ToString('s')
    message = $m.Substring(0, [math]::Min(180, $m.Length)) } })
$r.critical_events = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; Level = 1; StartTime = $since } -MaxEvents 5 |
  ForEach-Object { "$($_.TimeCreated.ToString('s')) $($_.ProviderName) $($_.Id)" })
$r.unexpected_shutdowns_30d = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 6008; StartTime = (Get-Date).AddDays(-30) } -MaxEvents 100).Count
$pend = @()
if (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending') { $pend += 'component servicing' }
if (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired') { $pend += 'windows update' }
if ((Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager' -Name PendingFileRenameOperations).PendingFileRenameOperations) { $pend += 'file rename' }
$r.pending_reboot = $pend
$hf = Get-HotFix | Where-Object { $_.InstalledOn } | Sort-Object InstalledOn -Descending | Select-Object -First 1
$r.last_hotfix = $(if ($hf) { "$($hf.HotFixID) on $($hf.InstalledOn.ToString('yyyy-MM-dd'))" } else { $null })
$mp = Get-MpComputerStatus
if ($mp) { $r.defender = [ordered]@{ realtime = $mp.RealTimeProtectionEnabled; signature_age_days = $mp.AntivirusSignatureAge
  threats_30d = @(Get-MpThreatDetection | Where-Object { $_.InitialDetectionTime -gt (Get-Date).AddDays(-30) }).Count } }
$r.time_sync = ((w32tm /query /status 2>$null) | Select-String 'Source|Last Successful' | ForEach-Object { $_.Line.Trim() }) -join '; '
$roles = @()
if (Get-Service NTDS) { $roles += 'domain-controller' }
if (Get-Service vmms) { $roles += 'hyper-v-host' }
if ((Get-CimInstance -Namespace root\\cimv2\\TerminalServices Win32_TerminalServiceSetting).TerminalServerMode -eq 1) { $roles += 'rds-host' }
$r.roles = $roles
if ($roles -contains 'hyper-v-host') {
  $r.vms = @(Get-VM | ForEach-Object { "$($_.Name): $($_.State)$(if ($_.State -eq 'Running') { ", up $([math]::Round($_.Uptime.TotalDays, 1))d" })" })
  $r.vm_checkpoints = @(Get-VM | Get-VMSnapshot).Count
}
if ($roles -contains 'rds-host') { $r.user_sessions = @((quser 2>$null) | Select-Object -Skip 1 | ForEach-Object { ($_ -replace '\\s+', ' ').Trim() }) }
if ($roles -contains 'domain-controller') {
  $r.replication = ((repadmin /replsummary 2>&1) | Where-Object { $_.Trim() } | Select-Object -Last 8) -join ' / '
  ${deep ? "$r.dcdiag_failures = @((dcdiag /q 2>&1) | Where-Object { $_ -match 'failed test' } | ForEach-Object { $_.Trim() })" : ''}
}
'@@JSON@@'
$r | ConvertTo-Json -Depth 5 -Compress
`;

  const LINUX_HEALTH = (days) => `
s() { echo "@@ $1"; }
s host; hostname
s os; (. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME, kernel $(uname -r)")
s uptime; uptime -p 2>/dev/null; echo "booted $(uptime -s 2>/dev/null)"
s load; echo "$(cut -d' ' -f1-3 /proc/loadavg) on $(nproc) cpus"
s memory; free -h | head -3
s disks; df -hP -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs 2>/dev/null
s inodes_over_80pct; df -iP -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null | awk 'NR>1 && $5+0>=80'
s failed_units; systemctl --failed --no-legend --plain 2>/dev/null
s top_errors; journalctl -p err --since "${days} days ago" --no-pager -q -o cat 2>/dev/null | sed -E 's/[0-9]+/N/g' | sort | uniq -c | sort -rn | head -12
s oom_kills; journalctl -k --since "${days} days ago" --no-pager -q 2>/dev/null | grep -ci 'out of memory'
s reboot_required; if [ -f /var/run/reboot-required ]; then cat /var/run/reboot-required.pkgs 2>/dev/null | head -5; echo yes; else echo no; fi
s pending_updates; if command -v apt >/dev/null; then apt list --upgradable 2>/dev/null | tail -n +2 | wc -l; elif command -v dnf >/dev/null; then dnf -q check-update 2>/dev/null | grep -c '^[a-zA-Z0-9]'; else echo n/a; fi
s time_sync; timedatectl show -p NTPSynchronized --value 2>/dev/null || echo unknown
s recent_reboots; last -x reboot shutdown 2>/dev/null | head -5
`;

  const flagWindows = (r) => {
    const f = [];
    for (const d of r.disks ?? []) {
      if (d.free_pct != null && d.free_pct < 10) f.push(`LOW DISK ${d.drive} ${d.free_pct}% free (${d.free_gb} GB)`);
      else if (d.free_pct != null && d.free_pct < 20) f.push(`disk ${d.drive} ${d.free_pct}% free`);
    }
    if (r.memory_gb?.total && r.memory_gb.free / r.memory_gb.total < 0.1) f.push(`LOW MEMORY ${r.memory_gb.free} of ${r.memory_gb.total} GB free`);
    if (r.stopped_auto_services?.length) f.push(`${r.stopped_auto_services.length} auto-start service(s) not running`);
    if (r.pending_reboot?.length) f.push(`reboot pending (${r.pending_reboot.join(', ')})`);
    if (r.unexpected_shutdowns_30d) f.push(`${r.unexpected_shutdowns_30d} unexpected shutdown(s) in 30 days`);
    if (r.critical_events?.length) f.push(`${r.critical_events.length} critical event(s)`);
    if (r.uptime_days > 60) f.push(`up ${r.uptime_days} days (patching?)`);
    const hotfixDate = Date.parse((r.last_hotfix ?? '').split(' on ')[1] ?? '');
    if (hotfixDate && Date.now() - hotfixDate > 60 * 86_400_000) f.push(`last hotfix ${r.last_hotfix} - updates may be failing`);
    if (r.defender && r.defender.realtime === false) f.push('DEFENDER REAL-TIME PROTECTION OFF');
    if (r.defender?.signature_age_days > 3) f.push(`Defender signatures ${r.defender.signature_age_days} days old`);
    if (r.defender?.threats_30d) f.push(`${r.defender.threats_30d} Defender detection(s) in 30 days`);
    if (r.dcdiag_failures?.length) f.push(`dcdiag: ${r.dcdiag_failures.length} failed test(s)`);
    if (/fail|error/i.test(r.replication ?? '')) f.push('AD replication reports failures');
    if (r.vms?.some((v) => !/Running/.test(v))) f.push('some VMs are not running');
    if (r.vm_checkpoints) f.push(`${r.vm_checkpoints} VM checkpoint(s) present`);
    return f;
  };

  function formatWindowsHealth(out) {
    const i = out.lastIndexOf('@@JSON@@');
    if (i === -1) return out;
    let r;
    try { r = JSON.parse(out.slice(i + 8).trim()); } catch { return out; }
    const flags = flagWindows(r);
    const lines = [
      `${r.host}: ${r.os}`,
      `Findings: ${flags.length ? '\n  - ' + flags.join('\n  - ') : 'none flagged'}`,
      `Uptime ${r.uptime_days}d (boot ${r.last_boot}); CPU ${r.cpu_load_pct}%; RAM ${r.memory_gb?.free}/${r.memory_gb?.total} GB free`,
      `Disks: ${(r.disks ?? []).map((d) => `${d.drive} ${d.free_gb}/${d.size_gb} GB free (${d.free_pct}%)`).join('; ')}`,
      `Roles: ${r.roles?.length ? r.roles.join(', ') : 'none detected'}`,
    ];
    if (r.stopped_auto_services?.length) lines.push(`Auto-start services not running: ${r.stopped_auto_services.join('; ')}`);
    lines.push(`Errors (System+Application, window): ${r.errors_in_window >= 3000 ? '3000+ (capped)' : r.errors_in_window}`);
    for (const e of r.top_errors ?? []) lines.push(`  ${e.count}x ${e.log}/${e.source} ${e.id} (last ${e.last}): ${e.message}`);
    for (const n of r.ignored_noise ?? []) lines.push(`  ignored as known noise: ${n.events}x ${n.source}`);
    if (r.critical_events?.length) lines.push(`Critical: ${r.critical_events.join('; ')}`);
    lines.push(`Unexpected shutdowns (30d): ${r.unexpected_shutdowns_30d}; pending reboot: ${r.pending_reboot?.length ? r.pending_reboot.join(', ') : 'no'}`);
    lines.push(`Last hotfix: ${r.last_hotfix ?? 'unknown'}; time sync: ${r.time_sync || 'unknown'}`);
    if (r.defender) lines.push(`Defender: real-time ${r.defender.realtime}, signatures ${r.defender.signature_age_days}d old, threats 30d ${r.defender.threats_30d}`);
    if (r.vms) lines.push(`VMs: ${r.vms.join('; ')}; checkpoints: ${r.vm_checkpoints}`);
    if (r.user_sessions) lines.push(`User sessions: ${r.user_sessions.join(' / ') || 'none'}`);
    if (r.replication) lines.push(`AD replication: ${r.replication}`);
    if (r.dcdiag_failures) lines.push(`dcdiag failures: ${r.dcdiag_failures.join('; ') || 'none'}`);
    return lines.join('\n');
  }

  function formatLinuxHealth(out) {
    const sections = {};
    let cur = null;
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^@@ (\S+)$/);
      if (m) { cur = m[1]; sections[cur] = []; } else if (cur && line.trim()) sections[cur].push(line);
    }
    const flags = [];
    for (const l of (sections.disks ?? []).slice(1)) {
      const parts = l.trim().split(/\s+/);
      const pct = parseInt(parts[4], 10);
      if (pct >= 90) flags.push(`LOW DISK ${parts[5]} ${pct}% used`);
      else if (pct >= 80) flags.push(`disk ${parts[5]} ${pct}% used`);
    }
    if (sections.inodes_over_80pct?.length) flags.push('inodes over 80% on some filesystems');
    if (sections.failed_units?.length) flags.push(`${sections.failed_units.length} failed systemd unit(s)`);
    if (parseInt(sections.oom_kills?.[0] ?? '0', 10) > 0) flags.push(`${sections.oom_kills[0]} out-of-memory kill(s)`);
    if ((sections.reboot_required ?? []).includes('yes')) flags.push('reboot required');
    if (parseInt(sections.pending_updates?.[0] ?? '0', 10) > 0) flags.push(`${sections.pending_updates[0]} pending update(s)`);
    if (sections.time_sync?.[0] === 'no') flags.push('clock not NTP-synchronised');
    const body = Object.entries(sections).map(([k, v]) => `${k}:\n  ${v.join('\n  ') || '(none)'}`).join('\n');
    return `Findings: ${flags.length ? '\n  - ' + flags.join('\n  - ') : 'none flagged'}\n${body}`;
  }

  async function healthReport(node, days, deep = false) {
    return isWindowsNode(node)
      ? formatWindowsHealth(await runShell(node, WIN_HEALTH(days, deep), 2, deep ? 600_000 : 240_000))
      : formatLinuxHealth(await runShell(node, LINUX_HEALTH(days), 3, 180_000));
  }

  // Warnings and errors of the last few hours, grouped, plus failed logons: what
  // is going on right now, as opposed to the health check's multi-day view.
  const WIN_RECENT = (hours) => `
$ErrorActionPreference = 'SilentlyContinue'
$since = (Get-Date).AddHours(-${hours})
${winEventsScript('ev', { hours, levels: [1, 2, 3], max: 2000, ignored: ignoredEvents })}
"warnings and errors (System+Application): $($ev.Count)"
$ev_ignored | ForEach-Object { "  ignored as known noise: $($_.events)x $($_.source)" }
$ev | Group-Object LogName, ProviderName, Id | Sort-Object Count -Descending | Select-Object -First 15 | ForEach-Object {
  $e = $_.Group[0]; $m = "$($e.Message)" -replace '\\s+', ' '
  '  {0}x {1}/{2} {3} {4} (last {5}): {6}' -f $_.Count, $e.LogName, $e.ProviderName, $e.Id, $e.LevelDisplayName, $e.TimeCreated.ToString('s'), $m.Substring(0, [math]::Min(200, $m.Length)) }
$fl = @(Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4625; StartTime = $since } -MaxEvents 1000)
"failed logons (Security 4625): $($fl.Count)"
$fl | Group-Object { $_.Properties[5].Value } | Sort-Object Count -Descending | Select-Object -First 5 | ForEach-Object { "  $($_.Count)x account $($_.Name)" }
`;
  const LINUX_RECENT = (hours) =>
    `journalctl --no-pager -q -o short-iso -p warning --since '${hours} hours ago' 2>&1 | tail -n 40; ` +
    `echo "failed logins: $(journalctl --no-pager -q --since '${hours} hours ago' 2>/dev/null | grep -ciE 'authentication failure|failed password')"`;

  async function recentEvents(node, hours) {
    const out = isWindowsNode(node)
      ? await runShell(node, WIN_RECENT(hours), 2, 180_000)
      : await runShell(node, LINUX_RECENT(hours), 3, 120_000);
    return out.trim() || '(nothing)';
  }

  // Used by mesh_chat_open's background diagnostics.
  ctx.healthReport = healthReport;
  ctx.recentEvents = recentEvents;

  define({
    name: 'mesh_health_check', tier: 'RF', title: 'Health check',
    description:
      'Read-only health snapshot of one or more devices (no approval needed), with problems flagged at the top. ' +
      'Windows: OS/uptime, CPU, memory, disk space, auto-start services not running, top System/Application errors ' +
      'and critical events, unexpected shutdowns, pending reboot, last hotfix, Defender, time sync, and role checks ' +
      '(Hyper-V VMs/checkpoints, RDS sessions, AD replication; dcdiag with deep=true). Linux: uptime, load, memory, ' +
      'disks/inodes, failed units, top journal errors, OOM kills, reboot-required, pending updates, time sync. ' +
      'Use this first instead of writing a health script.',
    schema: {
      node_id: z.string().optional().describe('Device node ID or name'),
      node_ids: z.array(z.string()).optional().describe('Several devices, checked in parallel'),
      days: z.number().int().positive().max(90).optional().describe('Event/error window in days (default 7)'),
      deep: z.boolean().optional().describe('Also run slow checks (dcdiag on domain controllers). Default false'),
    },
    describe: async ({ days, deep }) => `Health check (${days ?? 7}d${deep ? ', deep' : ''})`,
    handler: async ({ node_id, node_ids, days, deep }, extra) => {
      const nodes = await targets({ node_id, node_ids });
      const d = days ?? 7;
      const results = await withProgress(extra, `Health check on ${nodes.length} device(s)`, () =>
        perDevice(nodes, (node) => healthReport(node, d, Boolean(deep))));
      const text = results.map(({ node, out, error }) =>
        `=== ${node.name}${error ? ' (FAILED)' : ''} ===\n${error ?? out}`).join('\n\n');
      return deviceResult(text, `Health check (${d}-day window):`);
    },
  });

  // ════════════════════════════════════════════════════════════════════════
  // Event log query
  // ════════════════════════════════════════════════════════════════════════

  const WIN_LEVELS = { critical: [1], error: [1, 2], warning: [1, 2, 3], info: [1, 2, 3, 4, 0] };
  const JOURNAL_PRIO = { critical: 'crit', error: 'err', warning: 'warning', info: 'info' };

  define({
    name: 'mesh_event_log', tier: 'RF', title: 'Query event log',
    description:
      'Query a device\'s event log without writing a script (no approval needed). Windows: Get-WinEvent on any log ' +
      '(System, Application, Security, or a channel like "Microsoft-Windows-TaskScheduler/Operational"), filtered by ' +
      'level, time window, source (provider), event IDs and text. Linux: journalctl filtered by priority, unit ' +
      '(source), window and text. Newest first, one line per event.',
    schema: {
      node_id: z.string().describe('Device node ID or name'),
      log: z.string().optional().describe('Windows log name (default "System"); ignored on Linux'),
      level: z.enum(['critical', 'error', 'warning', 'info']).optional().describe('Minimum severity (default "error")'),
      since_hours: z.number().positive().max(24 * 365).optional().describe('Window in hours (default 24)'),
      source: z.string().optional().describe('Windows provider name, or Linux systemd unit'),
      event_ids: z.array(z.number().int().nonnegative()).max(20).optional().describe('Windows event IDs'),
      contains: z.string().max(200).optional().describe('Only events whose message contains this text'),
      max: z.number().int().positive().max(500).optional().describe('Max events (default 50)'),
    },
    describe: async ({ log, level, since_hours, source }) =>
      `Event log ${log ?? ''} ${level ?? 'error'}+ last ${since_hours ?? 24}h${source ? ` source ${source}` : ''}`.replace(/\s+/g, ' '),
    handler: async ({ node_id, log, level, since_hours, source, event_ids, contains, max }, extra) => {
      for (const [k, v] of [['log', log], ['source', source]]) {
        if (v != null && !SAFE_NAME.test(v)) return errorResult(`${k} contains unsupported characters.`);
      }
      const node = await requireNode(node_id);
      const lvl = level ?? 'error';
      const hours = since_hours ?? 24;
      const n = max ?? 50;
      let script;
      let type;
      if (isWindowsNode(node)) {
        type = 2;
        const filter = [
          `LogName = ${psQuote(log ?? 'System')}`,
          `StartTime = (Get-Date).AddHours(-${hours})`,
          `Level = ${WIN_LEVELS[lvl].join(', ')}`,
          ...(source ? [`ProviderName = ${psQuote(source)}`] : []),
          ...(event_ids?.length ? [`Id = ${event_ids.join(', ')}`] : []),
        ].join('; ');
        const textFilter = contains
          ? `| Where-Object { "$($_.Message)".IndexOf(${psQuote(contains)}, [StringComparison]::OrdinalIgnoreCase) -ge 0 } `
          : '';
        script =
          `$ErrorActionPreference = 'SilentlyContinue'\n` +
          `$e = @(Get-WinEvent -FilterHashtable @{ ${filter} } -MaxEvents ${contains ? n * 20 : n} ${textFilter}| Select-Object -First ${n})\n` +
          `if (-not $e.Count) { 'No matching events.' } else { $e | ForEach-Object { $m = "$($_.Message)" -replace '\\s+', ' '; ` +
          `'{0} | {1} | {2} | {3} | {4}' -f $_.TimeCreated.ToString('s'), $_.LevelDisplayName, $_.ProviderName, $_.Id, $m.Substring(0, [math]::Min(400, $m.Length)) } }`;
      } else {
        type = 3;
        script =
          `journalctl --no-pager -q -r -o short-iso -p ${JOURNAL_PRIO[lvl]} --since ${shQuote(`${hours} hours ago`)}` +
          `${source ? ` -u ${shQuote(source)}` : ''} 2>&1` +
          `${contains ? ` | grep -iF -- ${shQuote(contains)}` : ''} | head -n ${n}`;
      }
      const out = await withProgress(extra, `Querying ${node.name} event log`, () => runShell(node, script, type, 180_000));
      return deviceResult(out.trim() || 'No matching events.',
        `${node.name} ${isWindowsNode(node) ? log ?? 'System' : 'journal'} (${lvl}+, last ${hours}h${source ? `, ${source}` : ''}; newest first):`);
    },
  });

  // ════════════════════════════════════════════════════════════════════════
  // Services
  // ════════════════════════════════════════════════════════════════════════

  define({
    name: 'mesh_services', tier: 'RF', title: 'List services',
    description:
      'List services on a device (no approval needed). state "problem" (default) = auto-start services that are not ' +
      'running (Windows) / failed units (Linux); also "running", "stopped", or "all". Optional name filter.',
    schema: {
      node_id: z.string().describe('Device node ID or name'),
      state: z.enum(['problem', 'running', 'stopped', 'all']).optional().describe('Default "problem"'),
      filter: z.string().max(100).optional().describe('Only services whose name or display name contains this'),
      ...{ tail_lines: z.number().int().positive().optional().describe('Return only the last N lines') },
    },
    describe: async ({ state, filter }) => `List services (${state ?? 'problem'}${filter ? `, "${filter}"` : ''})`,
    handler: async ({ node_id, state, filter, tail_lines }) => {
      if (filter != null && !SAFE_NAME.test(filter)) return errorResult('filter contains unsupported characters.');
      const node = await requireNode(node_id);
      const st = state ?? 'problem';
      let out;
      if (isWindowsNode(node)) {
        // Get-Service, not Win32_Service: WMI service queries can take 30s+ on some hosts.
        const where = {
          problem: "$_.StartType -eq 'Automatic' -and $_.Status -ne 'Running'",
          running: "$_.Status -eq 'Running'",
          stopped: "$_.Status -ne 'Running'",
          all: '$true',
        }[st];
        const nameFilter = filter
          ? ` -and ("$($_.Name) $($_.DisplayName)".IndexOf(${psQuote(filter)}, [StringComparison]::OrdinalIgnoreCase) -ge 0)`
          : '';
        out = await runShell(node,
          `$s = @(Get-Service | Where-Object { (${where})${nameFilter} } | Sort-Object Name)\n` +
          `if (-not $s.Count) { 'No matching services.' } else { 'Name | Status | StartType | DisplayName'; ` +
          `$s | ForEach-Object { '{0} | {1} | {2} | {3}' -f $_.Name, $_.Status, $_.StartType, $_.DisplayName } }`,
          2, 120_000);
      } else {
        const stateArg = { problem: '--state=failed', running: '--state=running', stopped: '--state=inactive,failed', all: '--all' }[st];
        out = await runShell(node,
          `systemctl list-units --type=service ${stateArg} --no-legend --plain --no-pager 2>&1` +
          `${filter ? ` | grep -iF -- ${shQuote(filter)}` : ''} || true`, 3, 120_000);
        if (!out.trim()) out = 'No matching services.';
      }
      return deviceResult(trimLines(out.trim(), { tail: tail_lines }), `Services on ${node.name} (${st}${filter ? `, "${filter}"` : ''}):`);
    },
  });
}
