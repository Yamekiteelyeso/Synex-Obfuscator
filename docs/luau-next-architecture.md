# Synex Luau Next — arquitectura y seguridad

## Estado de implementación

Synex compila actualmente mediante TypeScript y emite un intérprete Luau desde `packages/vm/src/emit.ts`. Los módulos bajo `packages/vm/luau` son una base modular probada; todavía no están conectados al emisor que produce los payloads del producto.

## Pipeline objetivo

1. Parseo, validación y análisis semántico.
2. Compilación del AST a IR tipada.
3. Optimizaciones que preservan semántica y transformaciones de flujo.
4. Asignación determinista de opcodes, nombres y salts por build seed.
5. Serialización versionada de registros por instrucción.
6. Cifrado autenticado de cada registro con nonce único y AAD ligado a prototipo/posición.
7. Cadena HMAC estática sobre los registros cifrados, más validación de límites y flujo en runtime.
8. Emisión del wrapper Luau y pruebas de equivalencia, manipulación y rendimiento.

## Criptografía disponible en esta fase

`crypto.lua` ofrece SHA-256, HMAC-SHA-256, HChaCha20, ChaCha20, XChaCha20 y Poly1305. La API heredada `seal/open` usa XChaCha20 con Encrypt-then-MAC HMAC-SHA-256 (tag de 32 bytes). Las nuevas APIs `sealPoly1305/openPoly1305` implementan XChaCha20-Poly1305 (tag de 16 bytes), con Poly1305 de diez limbs de 13 bits para mantener productos enteros exactos en Luau. La implementación se valida con el vector RFC de Poly1305 y pruebas de round-trip/manipulación. Los módulos de compilación todavía usan la API heredada hasta completar pruebas de interoperabilidad y migración del formato.

El llamador proporciona una clave de 32 bytes y un nonce de 24 bytes. Un nonce no debe repetirse para una misma clave. `compiler.lua` exige nonces suministrados externamente y rechaza duplicados dentro de un prototipo. `entropy.lua` y `build.lua` producen variación/diseño determinista, no secretos criptográficos. Para claves y nonces de producción se requiere un servicio de build confiable o un CSPRNG de plataforma.

## Formato de registro v1

Cada instrucción en claro ocupa 20 bytes: cinco enteros unsigned de 32 bits little-endian (`opcode, a, b, c, nextPC`). Cada registro se cifra individualmente y contiene `nonce[24]`, `ciphertext[20]`, `tag[32]`, `chainTag[32]` y AAD. La cadena HMAC se calcula sobre el registro cifrado anterior, PC, nonce, AAD, ciphertext y tag. La VM sólo descifra el registro actual.

## Formatos versionados (módulos Luau)
 
- **v1** conserva compatibilidad: XChaCha20 + HMAC-SHA-256 por registro, tag de 32 bytes.
- **v2** usa XChaCha20-Poly1305 por registro, tag de 16 bytes. La cadena HMAC estática adicional sigue encadenando nonce, AAD, ciphertext y tag para detectar reordenamientos y sustituciones antes del descifrado.
- `compiler.lua` mantiene v1 como valor predeterminado; `options.version = 2` solicita explícitamente v2. `runtime.lua` despacha según `artifact.version` y rechaza versiones desconocidas.
- El lector de registros selecciona la primitiva de autenticación por versión. Los artefactos v1 existentes siguen siendo legibles; no se hace autodetección ambigua del algoritmo.
- Este versionado aplica al runtime modular bajo `packages/vm/luau`. **Todavía no está integrado al emisor TypeScript `emit.ts` ni habilitado en los perfiles de producto.**

## Modelo de integridad y límites

La cadena HMAC estática puede generarse durante el build y detecta cambios, reordenamientos o sustituciones de registros mientras la clave MAC permanezca fuera del alcance del atacante. Si la clave se incluye en el cliente, puede extraerse: estas verificaciones son tamper-evident, no una frontera de confianza frente al propietario del proceso.

El estado dinámico (PC, SP, registro previo, contador y opcode) se incorpora a un digest de ejecución local. Sin un valor esperado autenticado externo o una ruta de control totalmente conocida, ese digest no puede demostrar por sí solo que el estado runtime es legítimo: SP y PC dependen de ramas y entradas. No se debe afirmar que un MAC precalculado autentica estados runtime arbitrarios.

Las cadenas Luau son inmutables. Asignar `nil` a una variable tras descifrar no garantiza sobrescribir la memoria interna del string. La VM evita materializar el bytecode completo, pero no promete zeroización física del plaintext.

## Compatibilidad

Los módulos no requieren `getgenv`, `identifyexecutor`, `typeof` ni `Instance`. La compatibilidad real con Synapse, Script-Ware, Wave y Roblox Studio debe probarse en cada entorno; CI sólo confirma el CLI Luau utilizado en GitHub Actions.

## No objetivos

- No se afirma que Luau cliente pueda ocultar plaintext al propietario del proceso.
- Heap addresses, memoria del GC, timing, scheduler y hooks de debug no son entropía criptográfica.
- No se implementan mecanismos anti-análisis ni anti-inspección.
- No se promete compatibilidad universal sin pruebas.
- No se prometen 500k instrucciones/s, overhead inferior al 20% ni tamaño inferior a 3x sin benchmarks.

## Validación

- Vectores conocidos SHA-256, HMAC, HChaCha20 y ChaCha20.
- Round-trip XChaCha20 y rechazo de alteraciones en AAD, ciphertext y tag.
- Verificación de cadena estática y ejecución de registros individuales.
- Detección de nonce repetido por prototipo.
- Pruebas de determinismo del build planner.
- Suites de equivalencia Lua 5.4/Luau y benchmarks antes de integrar en el perfil Max.
