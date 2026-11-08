# Max encrypted-record benchmark

Run from the repository root after installing dependencies:

```sh
npm run bench:max
```

The benchmark compares the Max VM emitter with `encryptedRecords: false` (legacy
nine-field records) and `encryptedRecords: true` (authenticated v3 records).
It generates deterministic source programs near 1, 4, and 16 KiB, warms each
compilation once, and reports median/p95 wall-clock compilation time and median
output size. If the Luau CLI is installed and on `PATH`, it also reports the
wall-clock time to start a fresh Luau process, load the generated standalone
artifact, and execute it. Set `SYNEX_BENCH_ROUNDS` to change the number of
measured iterations (minimum 3).

These measurements are comparative diagnostics, not performance guarantees:
run both modes on the same machine, with the same Node/Luau versions and no
competing heavy workloads. Runtime figures include process startup and file
loading; they are not an isolated VM dispatch measurement. The benchmark does
not publish machine-specific thresholds and is intentionally not part of CI.
