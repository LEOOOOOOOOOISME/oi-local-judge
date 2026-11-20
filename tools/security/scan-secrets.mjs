#!/usr/bin/env node
/**
 * Fails when the repository contains credentials or personal data that must
 * not be published.
 *
 *   node tools/security/scan-secrets.mjs            # tracked files
 *   node tools/security/scan-secrets.mjs --history  # tracked files + history
 *
 * The history mode scans every added line in `git log -p --all`, plus commit
 * and tag identities. It is intentionally independent of any third-party
 * scanner so the release workflow can run it with no extra installation.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const repo = process.cwd();
const withHistory = process.argv.includes('--history');
const verbose = process.argv.includes('--verbose');

function resolveGit() {
  if (process.env.GIT_EXE) return process.env.GIT_EXE;
  if (process.platform === 'win32') {
    for (const candidate of [
      'C:/Program Files/Git/cmd/git.exe',
      'C:/Program Files/Git/bin/git.exe',
    ]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return 'git';
}

const gitExe = resolveGit();

function git(args) {
  return execFileSync(gitExe, args, {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 1024,
  });
}

/** High-signal credential formats. Kept narrow to avoid noisy false positives. */
const CREDENTIAL_RULES = [
  ['private-key', /-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----/g],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ['openai-key', /\bsk-[A-Za-z0-9]{32,}\b/g],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['stripe-live-key', /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b/g],
];

/** Personal data that must not appear in a public repository. */
const PERSONAL_RULES = [
  [
    'personal-windows-path',
    /\bC:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)(?!Public\b|Default\b|Default User\b|All Users\b|WDAGUtilityAccount\b)([A-Za-z0-9._-]+)/g,
  ],
  ['personal-repo-path', /\bD:(?:\\{1,2}|\/)Documents(?:\\{1,2}|\/)ai-powered-study/g],
  ['phone-email', /\b1[3-9]\d{9}@/g],
  ['cn-mobile-number', /(?<!\d)1[3-9]\d{9}(?!\d)/g],
];

const TREE_RULES = [...CREDENTIAL_RULES, ...PERSONAL_RULES];
const HISTORY_RULES = TREE_RULES;

const FORBIDDEN_NAMES = [
  [/(^|\/)\.env(?:\.(?!example$).*)?$/i, 'tracked .env file'],
  [/(^|\/)secrets\.json$/i, 'tracked secrets.json'],
  [/\.(?:pem|key|pfx|p12|kdbx|jks|keystore)$/i, 'tracked key/certificate file'],
  [/(^|\/)id_(?:rsa|ed25519|ecdsa)(?:\.pub)?$/i, 'tracked SSH key'],
  [/\.(?:db|sqlite|sqlite3|db-wal|db-shm)$/i, 'tracked database file'],
];

const findings = [];

function addFinding(rule, file, line, match, commit) {
  const value = match.length > 160 ? `${match.slice(0, 160)}...` : match;
  findings.push({ rule, file, line, commit, match: value });
}

function scanText(rel, text, rules, commit) {
  for (const [rule, pattern] of rules) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const line = text.slice(0, match.index).split('\n').length;
      addFinding(rule, rel, line, match[0], commit);
      if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
    }
  }
}

function trackedFiles() {
  return git(['ls-files', '-z']).split('\0').filter(Boolean);
}

function checkTrackedFiles() {
  const files = trackedFiles();
  for (const rel of files) {
    const abs = join(repo, rel);
    let size;
    try {
      size = statSync(abs).size;
    } catch {
      continue;
    }
    if (size > 20 * 1024 * 1024) continue; // media assets are handled by name rules
    for (const [pattern, label] of FORBIDDEN_NAMES) {
      if (pattern.test(rel)) addFinding(label, rel, 0, rel);
    }
    let buffer;
    try {
      buffer = readFileSync(abs);
    } catch {
      continue;
    }
    if (buffer.includes(0)) continue; // binary: name rules only
    scanText(rel, buffer.toString('utf8'), TREE_RULES);
  }
  console.log(`[scan-secrets] scanned ${files.length} tracked files`);
}

function checkHistory() {
  const patch = git(['log', '-p', '--all', '--no-color', '--no-ext-diff', '--unified=0']);
  let commit = '';
  let file = '';
  for (const line of patch.split(/\r?\n/)) {
    const commitMatch = /^commit ([0-9a-f]{40})/.exec(line);
    if (commitMatch) {
      commit = commitMatch[1].slice(0, 12);
      file = '';
      continue;
    }
    const fileMatch = /^\+\+\+ b\/(.+)$/.exec(line);
    if (fileMatch) {
      file = fileMatch[1];
      continue;
    }
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const text = line.slice(1);
    if (text.length > 4000) continue;
    scanText(file || '(unknown)', text, HISTORY_RULES, commit);
  }

  // Scan subjects/bodies only. Including %H here would make long hexadecimal
  // commit ids look like 11-digit mobile numbers.
  const messages = git(['log', '--all', '--format=%B%x00']);
  for (const block of messages.split('\0')) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    scanText('(commit message)', trimmed, PERSONAL_RULES);
  }

  const identities = new Set();
  for (const line of git(['log', '--all', '--format=%an <%ae>%n%cn <%ce>']).split(/\r?\n/)) {
    if (line.trim()) identities.add(line.trim());
  }
  for (const line of git([
    'for-each-ref',
    'refs/tags',
    '--format=%(taggername) <%(taggeremail)>',
  ]).split(/\r?\n/)) {
    if (line.trim()) identities.add(`tag: ${line.trim()}`);
  }
  for (const identity of identities) {
    scanText('(git identity)', identity, PERSONAL_RULES);
  }

  console.log(
    `[scan-secrets] scanned history: ${git(['rev-list', '--all', '--count']).trim()} commits, ` +
      `${identities.size} distinct author/committer/tagger identities`,
  );
  if (verbose) {
    for (const identity of [...identities].sort()) console.log(`  identity: ${identity}`);
  }
}

checkTrackedFiles();
if (withHistory) checkHistory();

if (findings.length === 0) {
  console.log('[scan-secrets] OK: no credentials or personal data found');
  process.exit(0);
}

// One line per unique finding keeps a leaked fixture from flooding the log.
const unique = new Map();
for (const finding of findings) {
  const key = `${finding.rule}|${finding.file}|${finding.line}|${finding.match}|${finding.commit ?? ''}`;
  if (!unique.has(key)) unique.set(key, finding);
}

console.error(`[scan-secrets] FAIL: ${unique.size} finding(s)`);
for (const finding of unique.values()) {
  const where = finding.commit
    ? `${finding.file}:${finding.line} @ ${finding.commit}`
    : `${finding.file}:${finding.line}`;
  console.error(`  [${finding.rule}] ${where}\n    ${finding.match}`);
}
process.exit(1);
