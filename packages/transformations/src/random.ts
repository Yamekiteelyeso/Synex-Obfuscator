/** Generador pseudoaleatorio determinista (mulberry32). Con la misma semilla produce la misma salida. */
export function createRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Crea un generador de identificadores válidos de Luau que nunca repite ni usa nombres reservados. */
export function createNameGenerator(rng: () => number, reserved: Set<string>): () => string {
  // Caracteres visualmente ambiguos a propósito: dificultan la lectura manual.
  const head = 'IlO_';
  const tail = 'Il1O0_';
  return () => {
    for (;;) {
      let name = head[Math.floor(rng() * head.length)];
      const len = 5 + Math.floor(rng() * 4);
      for (let i = 0; i < len; i++) name += tail[Math.floor(rng() * tail.length)];
      if (!reserved.has(name)) {
        reserved.add(name);
        return name;
      }
    }
  };
}
