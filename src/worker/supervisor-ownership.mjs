import fs from 'node:fs';

export function supervisorOwnsProcess(pidFile, pid = process.pid) {
  try {
    const value = fs.readFileSync(pidFile, 'utf8').trim();
    return /^[1-9]\d*$/.test(value) && Number(value) === pid;
  } catch {
    return false;
  }
}
