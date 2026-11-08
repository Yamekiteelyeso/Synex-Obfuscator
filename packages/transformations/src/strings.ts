/**
 * Protección de cadenas: cada literal se sustituye por una llamada a un
 * decodificador incluido en una cabecera de runtime. Los bytes UTF-8 se
 * transforman con una clave por cadena y una máscara dependiente de posición;
 * el resultado se descifra de forma perezosa y se cachea al primer uso.
 *
 * Nota: es ofuscación reversible, no cifrado ni una barrera contra análisis
 * dinámico. No debe usarse para almacenar secretos.
 */
export interface StringEncoderNames {
  table: string;   // E: bytes codificados por índice
  keys: string;    // K: clave por índice
  cache: string;   // C: valores ya descifrados
  decode: string;  // D: función de descifrado
}

export interface StringEncoder {
  /** Expresión Luau que devuelve el valor de la cadena. */
  encode(value: string): string;
  /** Código Luau del runtime de descifrado y verificación opcional. */
  header(verify?: boolean): string;
  /** Número de cadenas distintas protegidas. */
  readonly count: number;
  /** Descifrado de referencia en TypeScript, usado por las pruebas. */
  decodeReference(index: number): string;
  /** Suma de comprobación de las tablas de datos. */
  checksum(): number;
}

/** Módulo de la suma de comprobación; mantiene el acumulador dentro del rango exacto de doubles. */
export const CHECKSUM_MODULUS = 2147483647;

/** Suma sobre bytes codificados y claves, en orden de índice. */
export function dataChecksum(entries: { bytes: number[]; key: number }[]): number {
  let h = 0;
  entries.forEach((e) => {
    for (const b of e.bytes) h = (h * 31 + b) % CHECKSUM_MODULUS;
    h = (h * 31 + e.key) % CHECKSUM_MODULUS;
  });
  return h;
}

interface Entry {
  value: string;
  bytes: number[];
  key: number;
}

const textEncoder = new TextEncoder();
// Mantiene U+FEFF como dato; no elimina un BOM inicial del contenido original.
const textDecoder = new TextDecoder('utf-8', { ignoreBOM: true });

export function createStringEncoder(
  names: StringEncoderNames,
  rng: () => number,
): StringEncoder {
  const entries: Entry[] = [];
  const indexOf = new Map<string, number>();

  const encodeBytes = (value: string, key: number): number[] =>
    Array.from(textEncoder.encode(value), (byte, i) => (byte + key + (i + 1) * 31) % 256);

  return {
    get count() {
      return entries.length;
    },
    encode(value: string): string {
      let idx = indexOf.get(value);
      if (idx === undefined) {
        const key = 1 + Math.floor(rng() * 255);
        entries.push({ value, bytes: encodeBytes(value, key), key });
        idx = entries.length; // índices Luau empiezan en 1
        indexOf.set(value, idx);
      }
      return `${names.decode}(${idx})`;
    },
    decodeReference(index: number): string {
      const e = entries[index - 1];
      if (!e) throw new RangeError('índice de cadena fuera de rango');
      const decoded = e.bytes.map((byte, i) => ((byte - e.key - (i + 1) * 31) % 256 + 256) % 256);
      return textDecoder.decode(Uint8Array.from(decoded));
    },
    checksum(): number {
      return dataChecksum(entries);
    },
    header(verify = false): string {
      const { table, keys, cache, decode } = names;
      const check = verify
        ? [
            `do local h=0 for i=1,#${table} do local e=${table}[i]`,
            `for j=1,#e do h=(h*31+e[j])%${CHECKSUM_MODULUS} end`,
            `h=(h*31+${keys}[i])%${CHECKSUM_MODULUS} end`,
            `if h~=${dataChecksum(entries)} then error("integridad comprometida: datos alterados") end end`,
          ]
        : [];
      const bytesLua = entries.map((e) => '{' + e.bytes.join(',') + '}').join(',');
      const keysLua = entries.map((e) => String(e.key)).join(',');
      return [
        `local ${table}={${bytesLua}}`,
        `local ${keys}={${keysLua}}`,
        `local ${cache}={}`,
        ...check,
        `local function ${decode}(i)`,
        `local v=${cache}[i]`,
        'if v==nil then',
        `local e=${table}[i]`,
        `local k=${keys}[i]`,
        'local t={}',
        'for j=1,#e do t[j]=string.char((e[j]-k-j*31)%256) end',
        'v=table.concat(t)',
        `${cache}[i]=v`,
        'end',
        'return v',
        'end',
        '',
      ].join('\n');
    },
  };
}
