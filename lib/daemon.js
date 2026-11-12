// Daemon liveness for the resident codegraph watcher.
//
// The official daemon writes `<root>/.codegraph/daemon.pid` at startup and
// deletes it on clean shutdown, but a crash (or an OOM kill) leaves a stale
// pidfile behind, and Windows reuses pids aggressively. Reporting
// "watch: active (daemon pid N)" from that file alone told the model the
// index was auto-syncing when nothing was watching. So: read the pidfile, ask
// the OS whether the pid is alive, and knock on the daemon's named pipe.

import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

export function readDaemonRecord(root) {
  try {
    const data = JSON.parse(readFileSync(join(root, '.codegraph', 'daemon.pid'), 'utf8'));
    if (data && Number.isInteger(data.pid)) return data;
  } catch {
    /* no pidfile, not JSON, transient rewrite — all mean "no record" */
  }
  return null;
}

export function probeDaemonSocket(socketPath, timeoutMs = 400) {
  return new Promise((resolve) => {
    if (!socketPath || typeof socketPath !== 'string') return resolve(false);
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* already gone */ }
      resolve(value);
    };
    let socket;
    try {
      socket = net.connect({ path: socketPath });
    } catch {
      return resolve(false);
    }
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// pid alive AND named pipe answers: the only combination that justifies
// "the watcher will pick up edits on its own".
export async function daemonLiveness(root) {
  const record = readDaemonRecord(root);
  if (!record) return { record: null, pid: null, pidAlive: false, socketAlive: null, alive: false, socketPath: null };
  const pidAlive = isProcessAlive(record.pid);
  if (!pidAlive) {
    return { record, pid: record.pid, pidAlive, socketAlive: null, alive: false, socketPath: record.socketPath ?? null };
  }
  if (!record.socketPath) {
    return { record, pid: record.pid, pidAlive, socketAlive: null, alive: true, socketPath: null };
  }
  const socketAlive = await probeDaemonSocket(record.socketPath);
  return { record, pid: record.pid, pidAlive, socketAlive, alive: socketAlive, socketPath: record.socketPath };
}

export function killProcessTree(pid) {
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    return result.status === 0;
  }
  try {
    process.kill(pid);
    return true;
  } catch {
    return false;
  }
}

export async function stopDaemon(root) {
  const live = await daemonLiveness(root);
  if (!live.record) return { stopped: false, pid: null, reason: 'no daemon.pid record' };
  if (!live.pidAlive) return { stopped: false, pid: live.pid, reason: `pid ${live.pid} is not running` };
  const stopped = killProcessTree(live.pid);
  return { stopped, pid: live.pid, reason: stopped ? null : 'taskkill/kill failed' };
}

// `~/.codegraph/daemons/*.json` is the global daemon registry the official
// CLI maintains. The registry accumulates stale entries (55 on this machine);
// surface only the verified ones.
export function listDaemonRecords() {
  const dir = join(homedir(), '.codegraph', 'daemons');
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const records = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const data = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (data && Number.isInteger(data.pid)) records.push(data);
    } catch {
      /* unreadable registry entry */
    }
  }
  return records;
}

export async function verifiedDaemons() {
  const out = [];
  for (const record of listDaemonRecords()) {
    const pidAlive = isProcessAlive(record.pid);
    const socketAlive = pidAlive && record.socketPath ? await probeDaemonSocket(record.socketPath) : null;
    const alive = pidAlive && (record.socketPath ? socketAlive === true : true);
    out.push({ ...record, pidAlive, socketAlive, alive });
  }
  return out;
}
