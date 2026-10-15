// Conservative read-only command classifier.
//
// Decides whether a shell command line is plainly read-only (inventory, logs,
// status) so it can run without an approval prompt. It is deliberately strict:
// anything it does not fully understand is "not read-only" and falls back to
// normal confirmation. A false "no" costs one prompt; a false "yes" would let a
// write through unreviewed, so every rule below errs toward "no".
//
// Supported dialects: 'powershell', 'cmd', 'posix'.

// ── shared helpers ──────────────────────────────────────────────────────

// Harmless redirections that only discard or merge output streams. They are
// removed before analysis; any other redirection rejects the command.
const PS_SAFE_REDIRECTS = /(?:^|\s)(?:[2-6*]?>\s*\$null|[2-6*]>&1)(?=\s|$|\|)/gi;
const CMD_SAFE_REDIRECTS = /(?:^|\s)(?:[12]?>\s*nul|2>&1)(?=\s|$|\|)/gi;
const POSIX_SAFE_REDIRECTS = /(?:^|\s)(?:[12]?>\s*\/dev\/null|2>&1)(?=\s|$|\|)/g;

// Split a word list honouring '...' and "..." quoting (quotes are stripped).
function splitWords(text) {
  const words = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null; else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch; has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) words.push(cur);
      cur = ''; has = false;
    } else {
      cur += ch; has = true;
    }
  }
  if (quote) return null; // unbalanced
  if (has || cur) words.push(cur);
  return words;
}

// Split on single '|' outside quotes. Returns null for '||' or unbalanced quotes.
function splitPipes(text) {
  const parts = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch; cur += ch;
    } else if (ch === '|') {
      if (text[i + 1] === '|') return null;
      parts.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  if (quote) return null;
  parts.push(cur);
  return parts.map((p) => p.trim());
}

const positional = (args) => args.filter((a) => !/^[-/]/.test(a));
const lower = (s) => s.toLowerCase();
const hasAny = (args, flags) => args.some((a) => flags.some((f) => lower(a) === f || lower(a).startsWith(f + '=') || lower(a).startsWith(f + ':')));

// ── native-command rules (CMD, and native exes called from PowerShell) ──

const ALWAYS = () => true;
const NO_ARGS = (args) => args.length === 0;

const WIN_NATIVE = {
  dir: ALWAYS,
  type: ALWAYS,
  more: (a) => a.length > 0,
  findstr: ALWAYS,
  find: ALWAYS,
  sort: (a) => !hasAny(a, ['/o', '/output']),
  where: ALWAYS,
  echo: ALWAYS,
  ver: ALWAYS,
  vol: ALWAYS,
  systeminfo: ALWAYS,
  tasklist: ALWAYS,
  netstat: ALWAYS,
  whoami: ALWAYS,
  hostname: NO_ARGS,
  getmac: ALWAYS,
  driverquery: ALWAYS,
  quser: ALWAYS,
  qwinsta: ALWAYS,
  set: NO_ARGS,
  path: NO_ARGS,
  tracert: ALWAYS,
  pathping: ALWAYS,
  nslookup: (a) => a.length > 0, // no args = interactive
  ping: (a) => !hasAny(a, ['-t', '/t']),
  arp: (a) => a.length === 1 && ['-a', '/a', '-g'].includes(lower(a[0])),
  route: (a) => a.length >= 1 && lower(a[0]) === 'print',
  date: (a) => a.length === 1 && lower(a[0]) === '/t', // bare `date` prompts to set it
  time: (a) => a.length === 1 && lower(a[0]) === '/t',
  ipconfig: (a) => a.every((x) => ['/all', '/displaydns', '/?'].includes(lower(x))),
  query: (a) => a.length >= 1 && ['user', 'session', 'process', 'termserver'].includes(lower(a[0])),
  reg: (a) => a.length >= 1 && lower(a[0]) === 'query',
  schtasks: (a) => a.length >= 1 && lower(a[0]) === '/query',
  sc: (a) => a.length >= 1 && ['query', 'queryex', 'qc', 'qdescription', 'qfailure', 'qtriggerinfo', 'getdisplayname',
    'getkeyname', 'enumdepend', 'sdshow', 'showsid'].includes(lower(a[0])),
  wevtutil: (a) => a.length >= 1 && !a.some((x) => /^\/sbm/i.test(x)) && ['qe', 'query-events', 'gl', 'get-log', 'el', 'enum-logs', 'gli', 'get-loginfo',
    'ep', 'enum-publishers', 'gp', 'get-publisher'].includes(lower(a[0])),
  wmic: (a) => {
    const words = a.map(lower);
    if (words.some((w) => ['call', 'delete', 'set', 'create'].includes(w))) return false;
    // /format can load a remote XSL stylesheet containing script (a known code-execution trick).
    if (words.some((w) => /^\/(output|append|record|format|translate)/.test(w))) return false;
    return words.includes('get') || words.includes('list');
  },
  net: (a) => {
    if (!a.length) return false;
    const sub = lower(a[0]);
    const rest = a.slice(1);
    const extra = rest.filter((x) => lower(x) !== '/domain');
    if (extra.some((x) => x.startsWith('/'))) return false; // /add, /delete, /active, ...
    if (['user', 'localgroup', 'group'].includes(sub)) return positional(rest).length <= 1; // `net user x pw` sets a password
    if (['view', 'accounts', 'config', 'statistics'].includes(sub)) return positional(rest).length <= 1 && !rest.some((x) => x.includes(':'));
    if (['start', 'use', 'share', 'session'].includes(sub)) return rest.length === 0; // with args these change state
    return false;
  },
  gpresult: (a) => !hasAny(a, ['/h', '/x', '/f']),
  powercfg: (a) => a.length === 1 && ['/l', '/list', '/q', '/query', '/a', '/availablesleepstates', '/requests', '/lastwake',
    '/getactivescheme'].includes(lower(a[0])),
  icacls: (a) => a.length >= 1 && !a.slice(1).some((x) => !['/t', '/c', '/l', '/q'].includes(lower(x))),
};

function winNativeOk(name, args) {
  const rule = WIN_NATIVE[lower(name).replace(/\.exe$/, '')];
  return Boolean(rule && rule(args));
}

// ── CMD ─────────────────────────────────────────────────────────────────

export function isReadOnlyCmd(command) {
  if (typeof command !== 'string' || !command.trim()) return false;
  if (/[\r\n]/.test(command)) return false;
  const text = command.replace(CMD_SAFE_REDIRECTS, ' ');
  // chaining, redirection, escapes, grouping, and variable expansion (CMD expands
  // %VAR% before parsing, so a variable holding "& del x" would chain a command)
  if (/[&<>^()%!]/.test(text)) return false;
  const segments = splitPipes(text);
  if (!segments || segments.some((s) => !s)) return false;
  return segments.every((seg) => {
    const words = splitWords(seg);
    if (!words || !words.length) return false;
    const [name, ...args] = words;
    if (/[\\/:]/.test(name)) return false; // no path-qualified programs
    return winNativeOk(name, args);
  });
}

// ── POSIX shells ────────────────────────────────────────────────────────

const POSIX = {
  cat: ALWAYS, tac: ALWAYS, head: ALWAYS, nl: ALWAYS, rev: ALWAYS, wc: ALWAYS, cut: ALWAYS, column: ALWAYS,
  tail: ALWAYS, grep: ALWAYS, egrep: ALWAYS, fgrep: ALWAYS, zcat: ALWAYS, strings: ALWAYS,
  ls: ALWAYS, stat: ALWAYS, file: (a) => !a.some((x) => x === '-C' || x === '--compile'), df: ALWAYS, du: ALWAYS, free: ALWAYS, uptime: ALWAYS, uname: ALWAYS,
  whoami: ALWAYS, id: ALWAYS, groups: ALWAYS, ps: ALWAYS, pgrep: ALWAYS, pidof: ALWAYS, lsof: ALWAYS,
  ss: (a) => !a.some((x) => x === '--kill' || /^-[a-zA-Z]*K/.test(x)),
  netstat: ALWAYS, lsblk: ALWAYS, blkid: ALWAYS, findmnt: ALWAYS, lscpu: ALWAYS, lspci: ALWAYS, lsusb: ALWAYS,
  lsmod: ALWAYS, sensors: ALWAYS, vmstat: ALWAYS, iostat: ALWAYS, mpstat: ALWAYS, nproc: ALWAYS, arch: ALWAYS,
  last: ALWAYS, lastb: ALWAYS, lastlog: ALWAYS, w: ALWAYS, who: ALWAYS, getent: ALWAYS, printenv: ALWAYS,
  echo: ALWAYS, which: ALWAYS, basename: ALWAYS, dirname: ALWAYS, realpath: ALWAYS, readlink: ALWAYS,
  md5sum: ALWAYS, sha1sum: ALWAYS, sha256sum: ALWAYS, jq: ALWAYS, sestatus: ALWAYS, getenforce: ALWAYS,
  ping: ALWAYS, dig: ALWAYS, host: ALWAYS, nslookup: (a) => a.length > 0, traceroute: ALWAYS, tracepath: ALWAYS,
  true: ALWAYS, test: ALWAYS,
  sort: (a) => !a.some((x) => x.startsWith('--output') || x.startsWith('--compress-program') || /^-[a-zA-Z]*o/.test(x)),
  uniq: (a) => positional(a).length <= 1, // `uniq in out` writes `out`
  hostname: (a) => positional(a).length === 0 && !hasAny(a, ['-b', '--boot', '-F', '--file']),
  date: (a) => !a.some((x) => x === '-s' || x.startsWith('--set')),
  env: NO_ARGS,
  mount: NO_ARGS,
  ifconfig: (a) => positional(a).length <= 1,
  top: (a) => a.includes('-b') || a.some((x) => /^-[a-zA-Z]*b/.test(x)),
  dmesg: (a) => !a.some((x) => ['-c', '-C', '-D', '-E', '-n'].includes(x) || /^--(clear|read-clear|console-)/.test(x)),
  find: (a) => !a.some((x) => ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'].includes(x)),
  journalctl: (a) => !a.some((x) => /^--(vacuum|rotate|flush|sync|relinquish|setup-keys|update-catalog)/.test(x)),
  systemctl: (a) => {
    const verbs = positional(a);
    return verbs.length >= 1 && ['status', 'show', 'cat', 'is-active', 'is-enabled', 'is-failed', 'list-units',
      'list-unit-files', 'list-timers', 'list-sockets', 'list-dependencies', 'list-jobs'].includes(verbs[0]);
  },
  ip: (a) => {
    if (a.some((x) => /^-(b|batch|force)$/.test(x))) return false; // -batch reads commands from a file
    const words = positional(a);
    if (!words.length) return false;
    const objects = ['a', 'addr', 'address', 'r', 'route', 'l', 'link', 'n', 'neigh', 'neighbor', 'rule', 'maddr', 'netconf'];
    if (!objects.includes(words[0])) return false;
    return words.length === 1 || ['show', 'list', 'ls', 'get'].includes(words[1]);
  },
  timedatectl: (a) => positional(a).every((x) => ['status', 'show', 'list-timezones', 'timesync-status'].includes(x)),
  hostnamectl: (a) => positional(a).every((x) => ['status'].includes(x)),
  dpkg: (a) => a.length >= 1 && ['-l', '--list', '-L', '--listfiles', '-s', '--status', '-S', '--search', '-p', '--print-avail'].includes(a[0]),
  'dpkg-query': ALWAYS,
  rpm: (a) => a.length >= 1 && /^-q/.test(a[0]) && !a.some((x) => x.startsWith('--set')),
  apt: (a) => a.length >= 1 && ['list', 'show', 'search', 'policy'].includes(a[0]),
  'apt-cache': (a) => a.length >= 1 && ['show', 'search', 'policy', 'depends', 'rdepends', 'showpkg', 'stats'].includes(a[0]),
  docker: (a) => a.length >= 1 && ['ps', 'logs', 'inspect', 'images', 'stats', 'version', 'info', 'top'].includes(a[0]) &&
    !(a[0] === 'stats' && !a.includes('--no-stream')),
};

export function isReadOnlyPosix(command) {
  if (typeof command !== 'string' || !command.trim()) return false;
  if (/[\r\n]/.test(command)) return false;
  const text = command.replace(POSIX_SAFE_REDIRECTS, ' ');
  if (/[;&<>`(){}\\]|\$\(/.test(text)) return false; // chaining, redirection, substitution, subshells, escapes
  const segments = splitPipes(text);
  if (!segments || segments.some((s) => !s)) return false;
  return segments.every((seg) => {
    const words = splitWords(seg);
    if (!words || !words.length) return false;
    const [name, ...args] = words;
    if (/[$/=]/.test(name)) return false; // no variable, path-qualified, or VAR=x prefix commands
    const rule = POSIX[name];
    return Boolean(rule && rule(args));
  });
}

// ── PowerShell ──────────────────────────────────────────────────────────

const PS_CMDLETS = new Set([
  'select-object', 'where-object', 'sort-object', 'group-object', 'measure-object', 'compare-object',
  'format-table', 'format-list', 'format-wide', 'format-custom', 'out-string', 'out-null', 'out-host',
  'select-string', 'convertto-json', 'convertto-csv', 'convertto-html', 'convertto-xml', 'convertfrom-json',
  'convertfrom-csv', 'foreach-object', 'write-output', 'write-host', 'resolve-dnsname',
  'test-path', 'test-connection', 'test-netconnection', 'test-wsman', 'join-path', 'split-path', 'resolve-path',
]);
const PS_ALIASES = {
  gci: 'get-childitem', ls: 'get-childitem', dir: 'get-childitem', gc: 'get-content', cat: 'get-content',
  type: 'get-content', gi: 'get-item', gp: 'get-itemproperty', gps: 'get-process', ps: 'get-process',
  gsv: 'get-service', gwmi: 'get-wmiobject', gcim: 'get-ciminstance', select: 'select-object', where: 'where-object',
  '?': 'where-object', sort: 'sort-object', group: 'group-object', measure: 'measure-object', ft: 'format-table',
  fl: 'format-list', fw: 'format-wide', sls: 'select-string', '%': 'foreach-object', foreach: 'foreach-object',
  echo: 'write-output', gcm: 'get-command', gm: 'get-member', gl: 'get-location', pwd: 'get-location',
  gal: 'get-alias', gv: 'get-variable', ghy: 'get-history', history: 'get-history', gdr: 'get-psdrive',
};
// Get-* cmdlets that prompt, write files, or (third-party) change state.
const PS_GET_DENY = new Set(['get-credential', 'get-windowsupdatelog', 'get-clipboard', 'get-windowsupdate', 'get-wuinstall']);
const PS_METHODS = new Set([
  'tostring', 'tolower', 'toupper', 'trim', 'trimstart', 'trimend', 'split', 'substring', 'replace', 'contains',
  'startswith', 'endswith', 'indexof', 'lastindexof', 'padleft', 'padright', 'equals', 'compareto', 'gettype',
  'adddays', 'addhours', 'addminutes', 'addseconds', 'addmonths', 'addyears', 'tolocaltime', 'touniversaltime',
  'toshortdatestring', 'tolongdatestring', 'toshorttimestring', 'tostring', 'getvalue', 'getvaluenames',
  'getsubkeynames', 'count', 'where',
]);
// Variables that may be read. Anything else ($ExecutionContext, $host, ...) rejects.
const PS_VARS = /^\$(?:_|psitem|true|false|null|env:[a-z0-9_()]+|pshome|psversiontable|pwd|home)$/i;

// Tokenize a PowerShell line into a flat token list. Returns null on anything
// outside the small, safe subset this classifier understands.
function psTokenize(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "'") {
      let j = i + 1; let s = '';
      while (j < text.length) {
        if (text[j] === "'" && text[j + 1] === "'") { s += "'"; j += 2; continue; }
        if (text[j] === "'") break;
        s += text[j++];
      }
      if (j >= text.length) return null;
      tokens.push({ t: 'str', v: s }); i = j + 1; continue;
    }
    if (ch === '"') {
      const j = text.indexOf('"', i + 1);
      if (j === -1) return null;
      const s = text.slice(i + 1, j);
      if (/\$[({]|`/.test(s)) return null; // subexpressions / escapes inside expandable strings
      const vars = s.match(/\$[A-Za-z_][\w:]*/g) || [];
      if (vars.some((v) => !PS_VARS.test(v))) return null;
      tokens.push({ t: 'str', v: s }); i = j + 1; continue;
    }
    if (ch === '$') {
      const m = text.slice(i).match(/^\$(?:env:[A-Za-z0-9_]+|[A-Za-z_][A-Za-z0-9_]*|_)/);
      if (!m || !PS_VARS.test(m[0])) return null;
      tokens.push({ t: 'var', v: m[0] }); i += m[0].length; continue;
    }
    if (ch === '@' && text[i + 1] === '{') { tokens.push({ t: 'hash' }); i += 2; continue; }
    if (ch === '@' && text[i + 1] === '(') { tokens.push({ t: '(' }); i += 2; continue; }
    if (ch === ':' && text[i + 1] === ':') return null; // static member access ([type]::Method)
    if ('{}()|;,='.includes(ch)) {
      if (ch === '=' && (text[i + 1] === '=' || /[+\-*/%]/.test(text[i - 1] || ''))) return null;
      tokens.push({ t: ch }); i++; continue;
    }
    if (ch === '[') {
      const j = text.indexOf(']', i);
      if (j === -1) return null;
      const inner = text.slice(i + 1, j);
      if (!/^[\w.\s,-]*$/.test(inner)) return null;
      if (text.slice(j + 1, j + 3) === '::') return null;
      tokens.push({ t: 'index' }); i = j + 1; continue;
    }
    if (ch === '.') {
      // member access: .Name or .Name(...)
      const m = text.slice(i).match(/^\.([A-Za-z_][A-Za-z0-9_]*)/);
      if (m) {
        const isCall = text[i + m[0].length] === '(';
        tokens.push({ t: isCall ? 'method' : 'prop', v: m[1] }); i += m[0].length; continue;
      }
      const num = text.slice(i).match(/^\.\d+/);
      if (num) { tokens.push({ t: 'word', v: num[0] }); i += num[0].length; continue; }
      return null; // dot-sourcing or something exotic
    }
    if ('&`<>'.includes(ch)) return null;
    const m = text.slice(i).match(/^[^\s'"$@{}()|;,=[\].&`<>]+/);
    if (!m) return null;
    tokens.push({ t: 'word', v: m[0] }); i += m[0].length;
  }
  return tokens;
}

function psCommandOk(name, args) {
  const n = PS_ALIASES[lower(name)] || lower(name);
  if (n.startsWith('get-')) return !PS_GET_DENY.has(n);
  if (PS_CMDLETS.has(n)) {
    // ForEach-Object NAME invokes a member by name, which may be a method. Only
    // script-block forms are allowed (their contents are checked separately).
    if (n === 'foreach-object') return args.every((a) => a.t === 'block' || (a.t === 'word' && /^-(process|begin|end)$/i.test(a.v)));
    return true;
  }
  const native = lower(name).replace(/\.exe$/, '');
  if (WIN_NATIVE[native]) {
    if (args.some((a) => a.t !== 'word' && a.t !== 'str')) return false;
    return winNativeOk(native, args.map((a) => a.v));
  }
  return false;
}

// Walk the token stream. `stack` tracks open (, {, @{ so that command
// positions and hashtable keys are recognised.
function psValidate(tokens) {
  const stack = [];
  let i = 0;

  // Parse a pipeline segment starting at a command position; returns false on rejection.
  function command() {
    const tok = tokens[i];
    if (!tok) return false;
    if (tok.t !== 'word') return expressionUntilEnd();
    i++;
    const args = [];
    while (i < tokens.length) {
      const t = tokens[i];
      if (t.t === '|' || t.t === ';' || t.t === ')' || t.t === '}') break;
      if (t.t === '{') {
        i++;
        stack.push('{');
        if (!statements('}')) return false;
        args.push({ t: 'block' });
        continue;
      }
      if (!consumeValue(args)) return false;
    }
    return psCommandOk(tok.v, args);
  }

  // A value token (or nested group) in argument/expression position.
  function consumeValue(args) {
    const t = tokens[i];
    if (t.t === 'word' || t.t === 'str' || t.t === 'var' || t.t === 'prop' || t.t === 'index' || t.t === ',') {
      args?.push(t); i++; return true;
    }
    if (t.t === 'method') {
      if (!PS_METHODS.has(lower(t.v))) return false;
      i++; args?.push(t);
      // Method arguments are expressions, never commands: .AddDays(-1)
      if (tokens[i]?.t !== '(') return false;
      i++;
      while (tokens[i] && tokens[i].t !== ')') if (!consumeValue(null)) return false;
      if (!tokens[i]) return false;
      i++;
      return true;
    }
    if (t.t === '(') {
      i++; stack.push('(');
      if (!statements(')')) return false;
      args?.push({ t: 'group' });
      return true;
    }
    if (t.t === 'hash') {
      i++;
      if (!hashtable()) return false;
      args?.push({ t: 'hash' });
      return true;
    }
    return false; // '=', stray '{', etc.
  }

  // Expression that does not start with a bareword, e.g. `$_.Name -eq 'x'` or `(Get-Date)`.
  function expressionUntilEnd() {
    while (i < tokens.length) {
      const t = tokens[i];
      if (t.t === '|' || t.t === ';' || t.t === ')' || t.t === '}') return true;
      if (t.t === '{') {
        i++; stack.push('{');
        if (!statements('}')) return false;
        continue;
      }
      if (!consumeValue(null)) return false;
    }
    return true;
  }

  // Statements separated by ';' and pipelines by '|', until `close` (or end when close is null).
  function statements(close) {
    for (;;) {
      if (close && tokens[i]?.t === close) { i++; stack.pop(); return true; }
      if (i >= tokens.length) return close === null;
      if (!command()) return false;
      const t = tokens[i];
      if (!t) return close === null;
      if (t.t === '|' || t.t === ';') {
        i++;
        if (!tokens[i] || tokens[i].t === '|' || tokens[i].t === ';') return false;
        continue;
      }
      if (close && t.t === close) continue;
      return false;
    }
  }

  // @{ key = value; key = value } — keys are words/strings, values are expressions.
  function hashtable() {
    for (;;) {
      const t = tokens[i];
      if (!t) return false;
      if (t.t === '}') { i++; return true; }
      if (t.t === ';') { i++; continue; }
      if (t.t !== 'word' && t.t !== 'str') return false;
      i++;
      if (tokens[i]?.t !== '=') return false;
      i++;
      if (tokens[i]?.t === '{') { // calculated property expression = { ... }
        i++; stack.push('{');
        if (!statements('}')) return false;
      } else {
        let any = false;
        while (tokens[i] && !['}', ';'].includes(tokens[i].t)) {
          if (!consumeValue(null)) return false;
          any = true;
        }
        if (!any) return false;
      }
    }
  }

  return statements(null) && i === tokens.length;
}

// PowerShell treats typographic quotes (‘ ’ ‚ ‛ “ ” „) as quotes and en/em
// dashes as '-'. The tokenizer only knows the ASCII forms, so a curly quote could
// hide a second statement inside what looks like one string: refuse them.
const PS_TYPOGRAPHIC = /[\u2013-\u2015\u2018-\u201E]/;

export function isReadOnlyPowerShell(command) {
  if (typeof command !== 'string' || !command.trim()) return false;
  if (PS_TYPOGRAPHIC.test(command)) return false;
  if (/[\r\n]/.test(command)) return false;
  const text = command.replace(PS_SAFE_REDIRECTS, ' ');
  const tokens = psTokenize(text);
  if (!tokens || !tokens.length) return false;
  return psValidate(tokens);
}

export function isReadOnlyCommand(command, dialect) {
  if (dialect === 'powershell') return isReadOnlyPowerShell(command);
  if (dialect === 'cmd') return isReadOnlyCmd(command);
  if (dialect === 'posix') return isReadOnlyPosix(command);
  return false;
}
