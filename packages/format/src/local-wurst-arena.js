import fs from 'node:fs/promises';
import path from 'node:path';
import { makeFsRecord } from './pig-fs-records.js';

const localWurstArenas = new Map();

/**
 * Coordinate all append-only system/PigFS writers for one local Wurst file.
 * Reservations are serialized in memory, while durability stays explicit via
 * sync() and publication records.
 */
export async function acquireLocalWurstArena(filePath, source) {
  const key = path.resolve(filePath);
  let state = localWurstArenas.get(key);
  if (!state) {
    const handle = await fs.open(key, 'r+');
    const stat = await handle.stat();
    state = { handle, tail: stat.size, refs: 0, lane: Promise.resolve(), sources: new Map() };
    localWurstArenas.set(key, state);
  }
  state.refs += 1;
  state.sources.set(source, Number(state.sources.get(source) ?? 0) + 1);
  source.size = Math.max(source.size, state.tail);
  let released = false;

  const appendRecord = async (type, payload, { previousCommitOffset = 0, sequence = 0 } = {}) => {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? []);
    const task = state.lane.then(async () => {
      const recordStart = state.tail;
      const record = makeFsRecord(type, body, { recordStart, previousCommitOffset, sequence });
      let written = 0;
      while (written < record.length) {
        const step = await state.handle.write(record, written, record.length - written, recordStart + written);
        if (step.bytesWritten <= 0) throw new Error('Could not append WRST arena record');
        written += step.bytesWritten;
      }
      state.tail += record.length;
      for (const tracked of state.sources.keys()) tracked.size = Math.max(tracked.size, state.tail);
      return { recordStart, recordEnd: state.tail, recordLength: record.length, payloadLength: body.length };
    });
    state.lane = task.then(() => undefined, () => undefined);
    return task;
  };

  const sync = async () => {
    await state.lane;
    await state.handle.sync();
  };

  const release = async () => {
    if (released) return;
    released = true;
    state.refs -= 1;
    const sourceRefs = Number(state.sources.get(source) ?? 1) - 1;
    if (sourceRefs > 0) state.sources.set(source, sourceRefs); else state.sources.delete(source);
    if (state.refs > 0) return;
    await state.lane.catch(() => {});
    localWurstArenas.delete(key);
    await state.handle.close();
  };

  return { appendRecord, sync, release, get tail() { return state.tail; } };
}
