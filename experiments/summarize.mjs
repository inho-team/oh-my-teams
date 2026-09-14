import fs from 'node:fs';
import path from 'node:path';
import { readJSON, writeJSON } from '../plugins/orca/scripts/core.mjs';

const dir = path.resolve(process.argv[2]);
const manifest = readJSON(path.join(dir, 'manifest.json'));
const models = manifest.records.map(record => {
  const attempts = [];
  for (const first of record.results) {
    attempts.push({ task: first.task, attempt: 1, passed: first.passed, promptHash: first.promptHash, usage: first.usage, elapsedMs: first.elapsedMs });
    const retryFile = path.join(dir, record.model, first.task, 'retry/measurement.json');
    if (fs.existsSync(retryFile)) {
      const retry = readJSON(retryFile);
      attempts.push({ task: retry.task, attempt: 2, passed: retry.passed, promptHash: retry.promptHash, usage: retry.usage, elapsedMs: retry.elapsedMs });
    }
  }
  return { model: record.model, attempts, calls: attempts.length, firstPass: record.results.filter(r => r.passed).length, finalPass: record.results.filter(r => attempts.filter(a => a.task === r.task).at(-1).passed).length, totalTokens: attempts.every(a => Number.isFinite(a.usage?.total_tokens)) ? attempts.reduce((sum, a) => sum + a.usage.total_tokens, 0) : null, elapsedMs: attempts.reduce((sum, a) => sum + a.elapsedMs, 0), costUsd: null, quotaConsumption: null };
});
writeJSON('experiments/measurements.json', { date: '2026-09-14', provider: 'agy', base: manifest.base, taskCount: manifest.taskCount, models, caveat: 'Two small tasks, first-attempt matched prompts, one OSS repair with failure feedback. Provider-reported tokens are not monetary cost or subscription quota consumption.' });
console.log(JSON.stringify(models.map(({ model, totalTokens, elapsedMs, firstPass, finalPass }) => ({ model, totalTokens, elapsedMs, firstPass, finalPass })), null, 2));
