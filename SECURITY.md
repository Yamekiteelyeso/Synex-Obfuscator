# Synex security validation notes

## Security model

Synex is a source-code obfuscator. Its output is intended to increase the effort required for static inspection and casual modification; it is not encryption and cannot make client-executed code unrecoverable.

The Max pipeline currently combines AST transformations, string/number encoding, control-flow flattening, randomized per-build VM opcode assignments, per-prototype instruction layout changes, encoded operands, and runtime integrity checks. Builds without an explicit test seed now obtain their 32-bit build seed from Node's cryptographic random source. Supplying a fixed seed remains supported for reproducible tests.

## Trust boundaries

- A user controlling the target process can inspect memory, hook functions, patch the generated verifier, or record decoded values when the program uses them.
- Runtime checks in the same process are tamper-evident controls, not a cryptographic trust anchor.
- The build seed is not a secret once the generated artifact and runtime are delivered.
- Environment filtering reduces accidental exposure of common introspection APIs; it does not isolate hostile executors or replace an operating-system sandbox.
- Server-side secrets and authorization decisions must remain on the server. Do not embed API keys, OAuth secrets, license signing keys, or other credentials in protected Lua/Luau output.

## Validation expected for releases

1. Run the complete CI suite, including Lua 5.4 VM execution and tamper tests.
2. Test representative Roblox Luau scripts in Roblox Studio and the actual supported target runtime; Lua 5.4 passing is not proof of Luau/executor compatibility.
3. Compare observable output and return values between original and transformed scripts.
4. Mutate encoded constants, instruction fields, jump targets, block maps, and prototype descriptors; verify malformed artifacts fail closed.
5. Test on mobile widths of 320, 360, 390, 430, 768, and desktop widths; check horizontal overflow, editor usability, navigation, dialogs, and touch targets.
6. Record failures and regressions. Do not use an AI-generated score as a substitute for a reproducible test report.

## Honest guarantees

No universal 10/10 score, impossible deobfuscation claim, or absolute anti-dump guarantee is made. A release should report tested runtimes, passing tests, known limitations, and performance overhead.
