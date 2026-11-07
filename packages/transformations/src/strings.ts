/**
 * Protección de cadenas: cada literal se sustituye por una llamada a un
 * decodificador incluido en una cabecera de runtime. Cada cadena se guarda
 * XOR con una clave de un byte y se descifra la primera vez que se usa.
 *
 * Nota: el XOR de un byte es ofuscación ligera, no cifrado. La protección
 * fuerte corresponde a la VM y a las transformaciones de flujo.
 */
export interface StringEncoderNames {
  table: string;   // E: bytes cifrados por índice
  keys: string;    // K: clave por índice
  cache: string;   // C: valores ya descifrados
  decode: string;  // D: función de descifrado
}

export interface StringEncoder {
  /** Expresión Luau que devuelve el valor de la cadena. */
  encode(value: string): string;
  /**
   * Código Luau que debe anteponerse al programa. Con `verify`, la cabecera
   * recalcula al cargar una suma de comprobación de las tablas E y K y lanza
   * un error si no coincide con la calculada al ofuscar.
   */
  header(verify?: boolean): string;
  /** Número de cadenas distintas protegidas. */
  readonly count: number;
  /** Descifrado de referencia en TypeScript, usado por las pruebas. */
  decodeReference(index: number): string;
  /** Suma de comprobación de las tablas de datos (la misma que verifica la cabecera). */
  checksum(): number;
}

/** Módulo de la suma de comprobación. Con h*31 + x el producto cabe sin pérdida en doubles. */
export const CHECKSUM_MODULUS = 2147483647;

/** Suma sobre bytes cifrados y claves, en orden de índice. Debe coincidir con el código Luau de `header`. */
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

export function createStringEncoder(
  names: StringEncoderNames,
  rng: () => number,
): StringEncoder {
  const entries: Entry[] = [];
  const indexOf = new Map<string, number>();

  const encodeBytes = (value: string, key: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c > 255) throw new Error('la cadena debe contener bytes (0-255)');
      out.push(c ^ key);
    }
    return out;
  };

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
      return String.fromCharCode(...e.bytes.map((b) => b ^ e.key));
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
        'for j=1,#e do t[j]=string.char(bit32.bxor(e[j],k)) end',
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
