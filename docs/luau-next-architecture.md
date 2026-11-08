# Synex Luau Next — arquitectura y seguridad

## Estado de implementación

Synex compila actualmente mediante TypeScript y emite un intérprete Luau desde packages/vm/src/emit.ts. Los módulos bajo packages/vm/luau son bibliotecas de runtime; sólo afectarán a los payloads cuando el emisor los integre explícitamente.

## Pipeline

1. Parseo, validación y análisis semántico.
2. Compilación del AST a IR tipada.
3. Optimizaciones que preservan semántica y transformaciones de flujo.
4. Asignación de mapas de opcode y salts por prototipo.
5. Serialización versionada de prototipos y constantes.
6. Autenticación de registros y validación de índices antes del dispatcher.
7. Emisión del wrapper Luau y pruebas de equivalencia, manipulación y rendimiento.

## Criptografía disponible en esta fase

crypto.lua ofrece SHA-256, HMAC-SHA-256, HChaCha20, ChaCha20 y XChaCha20. La API seal/open usa cifrado XChaCha20 y Encrypt-then-MAC con una clave HMAC-SHA-256 separada por domain separation. Esto NO es XChaCha20-Poly1305 y no debe anunciarse como tal.

El llamador proporciona una clave de 32 bytes y un nonce de 24 bytes. El nonce no debe repetirse para una misma clave. entropy.lua sólo produce variación no criptográfica y nunca debe utilizarse como generador de claves o nonces. Para secretos y nonces de producción se requiere un servicio de build confiable o un CSPRNG de plataforma.

## Integridad

integrity.lua encadena HMAC-SHA-256 sobre PC, stack pointer, registro previo, contador de pasos y opcode. La autenticación sólo protege frente a un atacante que no conoce la clave MAC. Una clave embebida en un payload cliente puede extraerse; por tanto, las verificaciones con clave embebida son evidencia de manipulación, no una frontera criptográfica de confianza.

## Compatibilidad

Ningún global exclusivo de executors es obligatorio. Las capacidades opcionales se consultan defensivamente. La VM conserva los límites de pasos y profundidad y no debe cambiar la semántica del programa.

## No objetivos

- No se afirma que Luau cliente pueda ocultar plaintext al propietario del proceso.
- Heap addresses, memoria del GC, timing, scheduler y hooks de debug no son entropía criptográfica.
- No se implementan mecanismos anti-análisis ni anti-inspección.
- No se afirma compatibilidad con todos los executors sin pruebas.

## Validación requerida

- Vectores conocidos SHA-256 y HMAC.
- Vectores conocidos HChaCha20 y ChaCha20.
- Round-trip XChaCha20 y pruebas de alteración de AAD, ciphertext y tag.
- Mutación del estado de la cadena de integridad.
- Suites de equivalencia Lua 5.4 y Luau CLI.
- Benchmarks antes de declarar metas de rendimiento o tamaño.
