'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const manager = path.join(__dirname, '..', 'scripts', 'manage-raspi-ipatool.sh');

async function fixture({
  installedVersion = null,
  serviceActive = false,
  serviceStartFails = false,
  archiveVersion = '2.5.0',
  checksum = true,
  fakeArch = 'x86_64',
} = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ipatool-manager-'));
  const fakeBin = path.join(root, 'fake-bin');
  const archiveSourceDir = path.join(root, 'archive-source');
  const installPath = path.join(root, 'bin', 'ipatool');
  const archive = path.join(root, 'ipatool.tar.gz');
  const curlLog = path.join(root, 'curl.log');
  const systemctlLog = path.join(root, 'systemctl.log');
  await fsp.mkdir(fakeBin);
  await fsp.mkdir(archiveSourceDir);
  await fsp.mkdir(path.dirname(installPath), { recursive: true });

  const archiveBinary = path.join(archiveSourceDir, 'ipatool');
  await fsp.writeFile(archiveBinary, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "ipatool version ${archiveVersion}"; else exit 9; fi\n`);
  await fsp.chmod(archiveBinary, 0o755);
  execFileSync('tar', ['-czf', archive, '-C', archiveSourceDir, 'ipatool']);
  const digest = execFileSync('sha256sum', [archive], { encoding: 'utf8' }).split(/\s+/)[0];

  if (installedVersion) {
    await fsp.writeFile(installPath, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "ipatool version ${installedVersion}"; fi\n`);
    await fsp.chmod(installPath, 0o755);
  }

  async function command(name, contents) {
    const commandPath = path.join(fakeBin, name);
    await fsp.writeFile(commandPath, contents);
    await fsp.chmod(commandPath, 0o755);
  }

  await command('id', '#!/bin/sh\nif [ "$1" = "-u" ]; then echo 0; else exec /usr/bin/id "$@"; fi\n');
  await command('uname', '#!/bin/sh\nif [ "$1" = "-s" ]; then echo Linux; else echo "${FAKE_UNAME_M:-x86_64}"; fi\n');
  await command('curl', `#!/bin/sh
set -eu
url=
output=
for arg in "$@"; do
  case "$arg" in
    http*) url="$arg" ;;
    -o) : ;;
  esac
done
prev=
for arg in "$@"; do
  if [ "$prev" = -o ]; then output="$arg"; fi
  prev="$arg"
done
printf '%s\\n' "$url" >> "$CURL_LOG"
case "$url" in
  *api.github.com*) printf '%s\\n' "{\\"tag_name\\":\\"v\${LATEST_VERSION:-2.5.0}\\"}" ;;
  *.sha256sum) printf '%s\\n' "$CHECKSUM_TEXT" > "$output" ;;
  *) cp "$ARCHIVE_SOURCE" "$output" ;;
esac
`);
  await command('systemctl', `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$SYSTEMCTL_LOG"
  case "$1" in
    is-active) [ "\${SERVICE_ACTIVE:-0}" = 1 ] ;;
  stop) exit 0 ;;
  start) [ "\${SERVICE_START_FAILS:-0}" != 1 ] ;;
  *) exit 1 ;;
esac
`);
  await command('runuser', '#!/bin/sh\nshift 3\nexec "$@"\n');

  const env = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    ARCHIVE_SOURCE: archive,
    CHECKSUM_TEXT: checksum ? digest : '0'.repeat(64),
    CURL_LOG: curlLog,
    SYSTEMCTL_LOG: systemctlLog,
    SERVICE_ACTIVE: serviceActive ? '1' : '0',
    SERVICE_START_FAILS: serviceStartFails ? '1' : '0',
    IPATOOL_INSTALL_PATH: installPath,
    FAKE_UNAME_M: fakeArch,
  };
  return { root, installPath, curlLog, systemctlLog, env };
}

function runManager(args, env) {
  return spawnSync('bash', [manager, ...args], {
    env,
    encoding: 'utf8',
  });
}

async function readIfExists(file) {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

test('latest resolves the official release and selects the Linux amd64 asset', async (t) => {
  const f = await fixture();
  t.after(() => fsp.rm(f.root, { recursive: true, force: true }));
  f.env.LATEST_VERSION = '2.5.0';
  const result = runManager(['upgrade', 'latest'], f.env);
  assert.equal(result.status, 0, result.stderr);
  const urls = await readIfExists(f.curlLog);
  assert.match(urls, /api\.github\.com\/repos\/majd\/ipatool\/releases\/latest/);
  assert.match(urls, /releases\/download\/v2\.5\.0\/ipatool-2\.5\.0-linux-amd64\.tar\.gz$/m);
  assert.match(urls, /ipatool-2\.5\.0-linux-amd64\.tar\.gz\.sha256sum$/m);
});

test('aarch64 selects the official Linux arm64 assets', async (t) => {
  const f = await fixture({ fakeArch: 'aarch64' });
  t.after(() => fsp.rm(f.root, { recursive: true, force: true }));
  const result = runManager(['upgrade', '2.5.0'], f.env);
  assert.equal(result.status, 0, result.stderr);
  const urls = await readIfExists(f.curlLog);
  assert.match(urls, /releases\/download\/v2\.5\.0\/ipatool-2\.5\.0-linux-arm64\.tar\.gz$/m);
  assert.match(urls, /ipatool-2\.5\.0-linux-arm64\.tar\.gz\.sha256sum$/m);
});

test('checksum failure leaves the installed binary and service untouched', async (t) => {
  const f = await fixture({ installedVersion: '2.3.0', serviceActive: true, checksum: false });
  t.after(() => fsp.rm(f.root, { recursive: true, force: true }));
  const result = runManager(['upgrade', '2.5.0'], f.env);
  assert.notEqual(result.status, 0);
  assert.match(await fsp.readFile(f.installPath, 'utf8'), /2\.3\.0/);
  assert.doesNotMatch(await readIfExists(f.systemctlLog), /stop|start/);
});

test('a post-install version mismatch restores the rollback binary before restart', async (t) => {
  const f = await fixture({ installedVersion: '2.3.0', archiveVersion: '2.4.0', serviceActive: true });
  t.after(() => fsp.rm(f.root, { recursive: true, force: true }));
  const result = runManager(['upgrade', '2.5.0'], f.env);
  assert.notEqual(result.status, 0);
  assert.match(await fsp.readFile(f.installPath, 'utf8'), /2\.3\.0/);
  assert.match(await readIfExists(f.systemctlLog), /^is-active.*\nstop.*\nstart.*\n$/);
});

test('an already installed requested version is a no-op', async (t) => {
  const f = await fixture({ installedVersion: '2.5.0', serviceActive: true });
  t.after(() => fsp.rm(f.root, { recursive: true, force: true }));
  const result = runManager(['upgrade', '2.5.0'], f.env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /nothing to do/);
  assert.equal(await readIfExists(f.curlLog), '');
  assert.equal(await readIfExists(f.systemctlLog), '');
});

test('active upgrades stop and restart, while inactive upgrades stay inactive', async (t) => {
  const active = await fixture({ installedVersion: '2.3.0', serviceActive: true });
  const inactive = await fixture({ installedVersion: '2.3.0', serviceActive: false });
  t.after(async () => {
    await Promise.all([
      fsp.rm(active.root, { recursive: true, force: true }),
      fsp.rm(inactive.root, { recursive: true, force: true }),
    ]);
  });

  assert.equal(runManager(['upgrade', '2.5.0'], active.env).status, 0);
  assert.match(await readIfExists(active.systemctlLog), /^is-active.*\nstop.*\nstart.*\n$/);
  assert.equal(runManager(['upgrade', '2.5.0'], inactive.env).status, 0);
  assert.doesNotMatch(await readIfExists(inactive.systemctlLog), /stop|start/);
});

test('an unrecoverable active-service restart makes the upgrade fail', async (t) => {
  const f = await fixture({ installedVersion: '2.3.0', serviceActive: true, serviceStartFails: true });
  t.after(() => fsp.rm(f.root, { recursive: true, force: true }));
  const result = runManager(['upgrade', '2.5.0'], f.env);
  assert.notEqual(result.status, 0);
  assert.match(await readIfExists(f.systemctlLog), /^is-active.*\nstop.*\nstart.*\n/);
});

test('reauth resumes an active service when login fails', async (t) => {
  const f = await fixture({ installedVersion: '2.5.0', serviceActive: true });
  const installDir = path.join(f.root, 'checkout');
  await fsp.mkdir(path.join(installDir, 'analyser'), { recursive: true });
  await fsp.writeFile(path.join(installDir, 'analyser', '.env'), 'APPLE_EMAIL=test@example.com\nPASS=not-for-output\n');
  const authBinary = `#!/bin/sh
if [ "$1" = auth ] && [ "$2" = login ]; then exit 17; fi
`;
  await fsp.writeFile(f.installPath, authBinary);
  await fsp.chmod(f.installPath, 0o755);
  f.env.INSTALL_DIR = installDir;

  t.after(() => fsp.rm(f.root, { recursive: true, force: true }));
  const result = runManager(['reauth'], f.env);
  assert.equal(result.status, 17);
  assert.match(await readIfExists(f.systemctlLog), /^is-active.*\nstop.*\nstart.*\n$/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /not-for-output/);
});

test('successful reauth still fails if an active service cannot be restored', async (t) => {
  const f = await fixture({ installedVersion: '2.5.0', serviceActive: true, serviceStartFails: true });
  const installDir = path.join(f.root, 'checkout');
  await fsp.mkdir(path.join(installDir, 'analyser'), { recursive: true });
  await fsp.writeFile(path.join(installDir, 'analyser', '.env'), 'APPLE_EMAIL=test@example.com\nPASS=not-for-output\n');
  await fsp.writeFile(f.installPath, '#!/bin/sh\nexit 0\n');
  await fsp.chmod(f.installPath, 0o755);
  f.env.INSTALL_DIR = installDir;

  t.after(() => fsp.rm(f.root, { recursive: true, force: true }));
  const result = runManager(['reauth'], f.env);
  assert.notEqual(result.status, 0);
  assert.match(await readIfExists(f.systemctlLog), /^is-active.*\nstop.*\nstart.*\n/);
});
