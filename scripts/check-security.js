// Fails the build if the extension gains network code, remote code or extra permissions.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const problems = [];

const same = (a = [], b = []) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
if (!same(manifest.permissions, ['activeTab', 'scripting', 'storage'])) problems.push('Required permissions changed');
if (!same(manifest.optional_permissions, ['desktopCapture'])) problems.push('Optional permissions changed');
for (const key of ['host_permissions', 'optional_host_permissions', 'content_scripts', 'externally_connectable', 'web_accessible_resources', 'update_url']) {
  if (manifest[key]) problems.push(`Manifest must not use ${key}`);
}
if (!/default-src 'none'/.test(manifest.content_security_policy?.extension_pages || '')) problems.push('Network-blocking policy is missing');

const allowedUrl = /^https?:\/\/(schemas\.(openxmlformats|microsoft)\.org|purl\.org|www\.w3\.org)\//;
const banned = [/\beval\s*\(/, /new\s+Function\s*\(/, /XMLHttpRequest/, /WebSocket/, /sendBeacon/, /EventSource/, /importScripts/, /document\.write/, /innerHTML\s*=/];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(js|html|css|json)$/.test(entry.name)) scan(file);
  }
}

function scan(file) {
  const text = fs.readFileSync(file, 'utf8');
  const name = path.relative(root, file);
  for (const url of text.match(/https?:\/\/[^\s"'`<>)]+/g) || []) {
    if (!allowedUrl.test(url)) problems.push(`${name}: unexpected address ${url}`);
  }
  for (const pattern of banned) if (pattern.test(text)) problems.push(`${name}: banned code ${pattern}`);
  for (const call of text.match(/\bfetch\s*\([^)]*\)/g) || []) {
    if (!/dataUrl/.test(call)) problems.push(`${name}: unexpected network call ${call}`);
  }
  if (name.endsWith('.html') && /<script(?![^>]*\bsrc=)[^>]*>/.test(text)) problems.push(`${name}: inline script`);
}

walk(root);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('Security checks passed');
