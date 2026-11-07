# Synex Obfuscator

Ofuscador profesional de scripts Luau. Monorepo TypeScript.

## Estructura

| Paquete | Estado |
|---|---|
| `packages/shared` | Implementado: errores con posición (`SynexError`) |
| `packages/parser` | Lexer y parser de Luau con AST implementados (incluye tipos, `continue`, compuestos, `if`-expr, `::`). 49 pruebas |
| `packages/semantic` | Análisis de ámbitos, referencias, globales y validación de break/continue/... (17 pruebas). Limitación: la posición de los parámetros es la del primer statement del cuerpo |
| `packages/ir` | Bytecode de pila por función y compilador AST→IR: slots, celdas para locales capturados, upvalues, bucles, llamadas múltiples, tablas |
| `packages/transformations` | Pipeline: renombrado de locales (determinista por semilla), protección de cadenas con cabecera de descifrado, aplanado del flujo de control (incluye funciones locales y break/continue), comprobación de integridad en tiempo de ejecución y verificación de salida (25 pruebas de aplanado e integridad, con ejecución real en Lua 5.4) |
| `packages/vm` | VM de pila que ejecuta el IR (referencia en TypeScript) y emisor de la transformación mediante VM: compila el programa al IR y lo sustituye por un intérprete en Luau con códigos de operación aleatorios por build. Pruebas: 18 programas ejecutados en Lua 5.4 original y emitido, con salida idéntica (19 pruebas) |
| `packages/runtime` | Intérprete de referencia de Luau sobre el AST, con biblioteca mínima (print, pairs, ipairs, table.concat/insert, string.char, bit32). Oráculo para pruebas de equivalencia (18 pruebas) |
| `packages/engine` | Motor de orquestación: perfiles reales (Basic, Advanced, Professional, Custom), etapas con tiempos, digest SHA-256, comprobación de equivalencia, VM configurable y sistema de trabajos en worker_threads con límites de cola, tamaño y tiempo. Incluye pruebas del perfil completo en Lua 5.4 real (13 pruebas) |
| `apps/api` | API HTTP sin dependencias: registro y login con scrypt y sesiones con caducidad, bloqueo tras 5 fallos, límite de peticiones por IP, endpoints de trabajos (enviar, consultar, descargar, historial), estadísticas de usuario y panel de administración (usuarios, trabajos, errores y configuración). Persistencia en JSON (11 pruebas de integración) |
| `apps/web` | Implementado: acceso, panel, editor (resaltado, números de línea, importar/exportar, validación tamaño, técnicas personalizadas), progreso por etapa, historial, administración. 9 pruebas de lógica y render. Pendiente: pruebas end-to-end en navegador y verificación de tipos JSX con `@types/react` (ahora con declaraciones mínimas en `src/types/shims.d.ts`; no se pudo instalar sin acceso al registro npm). |

## Estado del lexer

Soportado: identificadores, palabras clave de Luau (`continue`, `type`, `export`, `typeof`),
operadores compuestos (`+=`, `-=`, `*=`, `/=`, `//=`, `%=`, `^=`, `..=`), números
(decimal, exponente, hex, binario, separador `_`), cadenas con escapes (`\n`, `\x`, `\u{}`,
`\ddd`, `\z`), corchetes largos con nivel, comentarios de línea y de bloque.

Limitaciones actuales: sin tokens de tipos de Luau completos (los tokens se reconocen,
pero aún no hay parser de tipos); sin soporte de cadenas con `\` seguido de bytes
UTF-8 fuera del rango ASCII tratados de forma especial.

## API

```
SYNEX_ADMIN_EMAIL=admin@ejemplo.com SYNEX_ADMIN_PASSWORD=... PORT=8080 node apps/api/dist/server.js
```

| Método | Ruta | Acceso |
|---|---|---|
| POST | /api/auth/register | público |
| POST | /api/auth/login | público (bloqueo tras 5 fallos) |
| POST | /api/auth/logout | usuario |
| GET | /api/me | usuario |
| POST | /api/jobs | usuario (`source`, `profile`, `seed`, `custom`, `checkEquivalence`, `name`) |
| GET | /api/jobs | usuario (historial propio) |
| GET | /api/jobs/:id | dueño |
| GET | /api/jobs/:id/code | dueño (descarga `.obf.luau`) |
| GET | /api/stats | usuario |
| GET | /api/profiles, /api/health | público |
| GET | /api/admin/users, /jobs, /errors, /settings | admin |
| PUT | /api/admin/settings | admin (tamaño máximo, perfiles habilitados) |

Limitaciones: el código generado vive en memoria del proceso (se pierde al reiniciar); el historial sí persiste. Sin HTTPS, sin recuperación de contraseña y sin verificación de correo.

## Perfiles

Niveles de protección para código propio: **NORMAL** (renombrado, cadenas, constantes y expresiones), **MEDIUM** (añade aplanado del flujo de control y código muerto) y **MAX** (todo lo anterior más la transformación mediante VM). Los perfiles Basic, Advanced y Professional se conservan. Custom permite elegir técnicas.

| Técnica | Basic | Advanced | Professional | Custom |
|---|---|---|---|---|
| Renombrado de identificadores | ✓ | ✓ | ✓ | opcional |
| Protección de cadenas | ✓ | ✓ | ✓ | opcional |
| Transformación de constantes | | ✓ | ✓ | opcional |
| Transformación de expresiones (`==`) | | 50 % | 100 % | opcional |
| Código muerto | | 15 % | 35 % | opcional |
| Comprobación de integridad en tiempo de ejecución | | | ✓ | opcional |
| Aplanado del flujo de control | no | no | sí (probabilidad 0.5) | sí (configurable) |
| Transformación mediante VM | no | no | no | opcional |
| Perfil Roblox (VM + transformaciones conservadoras) | — | — | — | perfil dedicado |

La comprobación de integridad verifica al cargar el script las tablas de datos incrustadas (bytes cifrados y claves) con una suma calculada al ofuscar; si se alteran, el script lanza el error `integridad comprometida`. Requiere la protección de cadenas, que el perfil Custom activa automáticamente. El digest SHA-256 del resultado sigue calculándose fuera del script.

La VM se activa en MAX y ROBLOX, y puede seleccionarse en Custom. El perfil ROBLOX mantiene desactivado el aplanado de control y el código muerto por compatibilidad con APIs dinámicas; la VM resuelve globals desde el entorno Luau.

## Limitaciones de la VM

- El bytecode se valida antes de emitirse: operaciones conocidas, saltos, ranuras, constantes y upvalues dentro de rango (`validateProto`, error `E_BYTECODE`).
- La VM generada aborta tras un número configurable de instrucciones (por defecto 5 000 000) y los errores de ejecución indican la línea del original.

- La VM es de pila y no tiene optimizaciones; ejecuta cada instrucción con un contador de pasos.
- Recursión limitada a 200 niveles de llamadas JS.
- No implementa toda la semántica de metatablas ni corrutinas; conserva operaciones nativas de indexación y llamadas `__call` que usa el script huésped.
- El aplanado del flujo de control no se aplica a bloques con `type` ni a bloques que leen una variable antes de declararla (una función que la usa también cuenta). Las funciones locales se hoistean con su nombre, así que la recursión se conserva. Los `break`/`continue` del bucle exterior se reescriben con estados reservados.
- La VM generada tiene límite de pasos (5 000 000 por defecto) y conserva la línea fuente en mensajes de error.
- Los códigos de operación y las claves de cadenas varían por build; las constantes de texto se codifican en el pool. Es ofuscación, no cifrado.
- La VM generada prefiere `getgenv()` en executors y usa `getfenv(0)`/`_G` como fallback, indexación nativa para Instances/userdata y llamadas `__call`; aun así, debe validarse en Roblox Luau y cada executor objetivo.

## Limitaciones de la ofuscación actual

- La equivalencia se verifica con Lua 5.4 real, no con Luau: este entorno no tiene `luau`. Se compila el ejecutor con `tools/lua54/build.sh` (requiere `liblua5.4-0` y `gcc`). Las pruebas que dependen de él se omiten si falta. Luau y Lua 5.4 difieren en sintaxis (`continue`, `+=`) y en biblioteca, así que el aplanado con `continue` se verifica sólo con el intérprete de referencia.
- Pendiente: ejecutar las pruebas en Luau real.
- El cifrado de cadenas usa XOR de un byte: es ofuscación ligera, no seguridad.
- Las posiciones de los parámetros en el análisis semántico son aproximadas.

## Pruebas

```
npx tsc -b packages/shared packages/parser packages/semantic packages/runtime packages/transformations packages/ir packages/vm packages/engine
tsx --test packages/parser/test/*.test.ts packages/semantic/test/*.test.ts packages/runtime/test/*.test.ts packages/transformations/test/*.test.ts packages/vm/test/*.test.ts packages/engine/test/*.test.ts
```

Ejecución en Lua 5.4 real (opcional, las pruebas se omiten si falta):

```
tools/lua54/build.sh
```

Requiere `tsx` (ejecutor TypeScript). `npm install` no se ha podido completar en este entorno
(sin acceso al registro npm), por lo que los paquetes se enlazan manualmente en `node_modules/@synex`.

## Aplicación web

- Compilar: `node apps/web/scripts/build.mjs` (genera `apps/web/dist`, con esbuild).
- La API sirve `apps/web/dist` en `/` si existe; las rutas `/api/*` no se ven afectadas.
- Pruebas: `cd apps/web && tsx --test test/web.test.tsx`.
- Dependencias: React 19 y esbuild se toman de `/opt/npm-tools` mediante enlaces en `node_modules` en este entorno sin acceso al registro.


## Despliegue en Railway

El repositorio incluye `railway.json`. Railway debe usar Node.js 22 o superior, ejecutar `npm run build` como comando de compilación y `npm start` para iniciar la API. El build compila primero todos los paquetes transitivos del motor y la API, y después genera `apps/web/dist`; la API sirve la web y expone `GET /api/health` como healthcheck.

Configura `SYNEX_ADMIN_EMAIL` y `SYNEX_ADMIN_PASSWORD` como variables de entorno. Para conservar usuarios e historial entre despliegues, monta un Volume en `/data` y define `SYNEX_DATA_FILE=/data/synex-data.json`. Sin un Volume, el almacenamiento JSON local puede perderse al reemplazar el contenedor.

## Perfil Roblox / Luau

El perfil `roblox` está pensado para scripts Luau de Roblox Studio y entornos Luau compatibles. Activa la VM, renombrado de locales, protección de cadenas, constantes y expresiones. Mantiene desactivados el aplanado de control y el código muerto para reducir incompatibilidades con APIs dinámicas. No inyecta funciones de executor ni añade `getgenv`, `getrawmetatable`, `hookfunction`, `firetouchinterest` u otras APIs específicas/no estándar. Las APIs estándar del juego (`game`, `workspace`, `script`, `task`, `Instance`, `Enum`, `Vector3`, `CFrame`, servicios Roblox) se dejan como globals del código fuente.

El perfil no promete compatibilidad con todas las extensiones de sintaxis/tipado Luau ni con todos los executors. Prueba cada salida en un entorno de prueba de Roblox. La VM resuelve globals mediante `getgenv()` en executors y `getfenv(0)`/`_G` como fallback y conserva indexación de Instances/userdata y llamadas `__call`, pero no garantiza compatibilidad universal con todos los executors.
