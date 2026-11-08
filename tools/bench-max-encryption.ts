import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { runProfile } from '../packages/engine/src/engine.js';

const rounds = Math.max(3, Number(process.env.SYNEX_BENCH_ROUNDS ?? 5));
const sizes = [1, 4, 16];
const luauAvailable = spawnSync('luau', ['--version'], { encoding: 'utf8' }).status === 0;

function sourceFor(targetKiB: number): string {
  const lines = ['local total = 0'];
  let index = 0;
  while (Buffer.byteLength(lines.join('\n'), 'utf8') < targetKiB * 1024) {
    index++;
    lines.push(`local value_${index} = ${index % 997}`);
    lines.push(`total = total + value_${index} * 3 - ${index % 17}`);
  }
  lines.push('print(total)');
  return lines.join('\n');
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]!;
}

function stats(values: number[]): string {
  return `median=${percentile(values, 0.5).toFixed(2)}ms p95=${percentile(values, 0.95).toFixed(2)}ms`;
}

function runLuau(path: string): number {
  const start = performance.now();
  const result = spawnSync('luau', [path], { encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'Luau execution failed');
  return performance.now() - start;
}

console.log('Synex Max encrypted-record benchmark');
console.log(`rounds=${rounds}; runtime=${luauAvailable ? 'Luau CLI' : 'not installed (runtime measurements skipped)'}`);
console.log('Times are wall-clock measurements; close other workloads for comparable runs.\n');

for (const size of sizes) {
  const source = sourceFor(size);
  for (const encryptedRecords of [false, true]) {
    const compileTimes: number[] = [];
    const outputBytes: number[] = [];
    const runtimeTimes: number[] = [];
    let artifact = '';
    for (let iteration = 0; iteration < rounds + 1; iteration++) {
      const start = performance.now();
      const result = runProfile(source, {
        profile: 'max',
        seed: 0x51_4e_58,
        encryptedRecords,
      });
      const elapsed = performance.now() - start;
      if (iteration > 0) {
        compileTimes.push(elapsed);
        outputBytes.push(result.stats.outputBytes);
      }
      artifact = result.code;
    }

    let directory: string | undefined;
    if (luauAvailable) {
      directory = mkdtempSync(join(tmpdir(), 'synex-max-bench-'));
      const file = join(directory, 'artifact.luau');
      writeFileSync(file, artifact, 'utf8');
      try {
        runLuau(file); // warm-up
        for (let i = 0; i < rounds; i++) runtimeTimes.push(runLuau(file));
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }

    const mode = encryptedRecords ? 'v3-encrypted' : 'legacy-clear';
    console.log(`${size} KiB input | ${mode} | output=${Math.round(percentile(outputBytes, 0.5))} bytes | compile ${stats(compileTimes)}`);
    if (runtimeTimes.length) console.log(`  Luau process + load + execute ${stats(runtimeTimes)}`);
  }
}
