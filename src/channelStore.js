import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { idFromFilename, sanitizeName } from './files.js';

const RECORD_FILE = '.channel.json';
const SAVE_DELAY_MS = 1000;

async function readRecord(directory) {
  try {
    const record = JSON.parse(await readFile(path.join(directory, RECORD_FILE), 'utf8'));
    return record?.channelKey ? record : null;
  } catch {
    return null;
  }
}

// A channel keeps its folder through renames by matching on its permanent key.
// A folder with no record is adopted by name, which covers downloads made
// before records existed. A folder owned by another channel is never shared.
async function findChannelFolder(platformDir, key, name) {
  const entries = await readdir(platformDir, { withFileTypes: true });
  const folders = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);

  for (const folder of folders) {
    const record = await readRecord(path.join(platformDir, folder));
    if (record?.channelKey === key) return { directory: path.join(platformDir, folder), record };
  }

  const base = sanitizeName(name) || 'unknown-channel';
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? base : `${base} (${n})`;
    const directory = path.join(platformDir, candidate);
    if (!folders.includes(candidate)) {
      await mkdir(directory);
      return { directory, record: null };
    }
    if (!await readRecord(directory)) return { directory, record: null };
  }
}

// What is known about a channel across runs. Files on disk decide what is saved,
// so a deleted video downloads again; the record holds what files can't show:
// failures, unplayable videos, and whether a run ever reached the end.
export async function openChannelStore({ root, platform, key, name }) {
  const platformDir = path.join(root, platform.name);
  await mkdir(platformDir, { recursive: true });
  const { directory, record: existing } = await findChannelFolder(platformDir, key, name);

  const record = existing ?? {
    version: 1,
    platform: platform.name,
    channelKey: key,
    reachedEndAt: null,
    lastRun: null,
    problems: {},
  };
  record.name = name;

  const saved = new Set((await readdir(directory)).map(idFromFilename).filter(Boolean));
  for (const id of saved) delete record.problems[id];
  const touched = new Set();

  let timer = null;
  let writing = Promise.resolve();
  const write = () => {
    const recordPath = path.join(directory, RECORD_FILE);
    const temporary = `${recordPath}.tmp`;
    const content = JSON.stringify(record, null, 2);
    writing = writing.then(async () => {
      await writeFile(temporary, content);
      await rename(temporary, recordPath);
    });
    return writing;
  };
  const scheduleWrite = () => {
    timer ??= setTimeout(() => {
      timer = null;
      write().catch(() => {});
    }, SAVE_DELAY_MS);
  };
  const setProblem = (id, problem) => {
    touched.add(id);
    record.problems[id] = { ...problem, at: new Date().toISOString() };
    scheduleWrite();
  };

  return {
    directory,
    isSaved: (id) => saved.has(id),
    markSaved(id) {
      saved.add(id);
      delete record.problems[id];
      scheduleWrite();
    },
    markFailed: (id, title, error) => setProblem(id, { kind: 'failed', title, error }),
    markUnplayable: (id, title) => setProblem(id, { kind: 'unplayable', title }),

    // Reaching the end proves anything not seen this run has left the channel.
    async finishRun(reason) {
      const at = new Date().toISOString();
      record.lastRun = { at, reason };
      if (reason === 'complete') {
        record.reachedEndAt = at;
        for (const id of Object.keys(record.problems)) {
          if (!touched.has(id)) delete record.problems[id];
        }
      }
      clearTimeout(timer);
      timer = null;
      await write();
    },

    summary() {
      const problems = Object.values(record.problems);
      return {
        name: record.name,
        saved: saved.size,
        failed: problems.filter((p) => p.kind === 'failed').length,
        unplayable: problems.filter((p) => p.kind === 'unplayable').length,
        reachedEndAt: record.reachedEndAt,
      };
    },
  };
}
