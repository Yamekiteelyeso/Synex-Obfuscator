# Synex Obfuscador

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
| `packages/engine` | Motor de orquestación: planes públicos (Basic, Medium, Max), etapas con tiempos, digest SHA-256, comprobación de equivalencia, VM configurable y sistema de trabajos en worker_threads con límites de cola, tamaño y tiempo. Incluye pruebas del perfil completo en Lua 5.4 real (13 pruebas) |
| `apps/api` | API HTTP sin dependencias: registro y login con scrypt y sesiones con caducidad, bloqueo tras 5 fallos, límite de peticiones por IP, endpoints de trabajos (enviar, consultar, descargar, historial), estadísticas de usuario y panel de administración (usuarios, trabajos, errores y configuración). Persistencia en JSON (11 pruebas de integración) |
| `apps/web` | Implementado: acceso, panel, editor (resaltado, números de línea, importar/exportar, validación tamaño, planes Basic, Medium y Max), progreso por etapa, historial, administración. 9 pruebas de lógica y render. Pendiente: pruebas end-to-end en navegador y verificación de tipos JSX con `@types/react` (ahora con declaraciones mínimas en `src/types/shims.d.ts`; no se pudo instalar sin acceso al registro npm). |

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
| GET | /api/auth/discord, /api/auth/discord/callback | público (OAuth2) |
| POST | /api/discord/interactions | público (firma Ed25519 de Discord) |
| POST | /api/auth/discord/exchange | público (ticket OAuth de un solo uso) |
| POST | /api/auth/logout | usuario |
| GET | /api/me | usuario |
| POST | /api/jobs | usuario (`source`, `profile`, `seed`, `checkEquivalence`, `name`) |
| GET | /api/jobs | usuario (historial propio) |
| GET | /api/jobs/:id | dueño |
| GET | /api/jobs/:id/code | dueño (descarga `.obf.luau`) |
| GET | /api/stats | usuario |
| GET | /api/profiles, /api/health | público |
| GET | /api/admin/users, /jobs, /errors, /settings | admin |
| PUT | /api/admin/settings | admin (tamaño máximo, perfiles habilitados) |

Limitaciones: el código generado vive en memoria del proceso (se pierde al reiniciar); el historial sí persiste. Sin HTTPS, sin recuperación de contraseña y sin verificación de correo.

## Planes de ofuscación

La web expone únicamente tres planes. No hay perfiles personalizados ni opciones separadas de Roblox en la interfaz:

| Técnica | Basic | Medium | Max |
|---|---:|---:|---:|
| Renombrado de identificadores | ✓ | ✓ | ✓ |
| Protección de cadenas | ✓ | ✓ | ✓ |
| Transformación de constantes | — | ✓ | ✓ |
| Transformación de expresiones | — | ✓ | ✓ |
| Código muerto | — | ✓ | ✓ |
| Aplanado del flujo de control | — | ✓ | ✓ |
| Comprobación de integridad | — | — | ✓ |
| VM Luau | — | — | ✓ |

Los niveles aplican configuraciones predefinidas del motor. Basic es el nivel esencial; Medium añade transformaciones de expresiones, constantes, código muerto y flujo de control; Max añade las técnicas avanzadas y la virtualización. La salida sigue siendo ofuscación reversible, no cifrado ni almacenamiento seguro de secretos.

## Limitaciones de la VM

- El bytecode se valida antes de emitirse: operaciones conocidas, saltos, ranuras, constantes y upvalues dentro de rango (`validateProto`, error `E_BYTECODE`).
- La VM generada aborta tras un número configurable de instrucciones (por defecto 5 000 000) y los errores de ejecución indican la línea del original.

- La VM es de pila y no tiene optimizaciones; ejecuta cada instrucción con un contador de pasos.
- Recursión limitada a 200 niveles de llamadas JS.
- No implementa toda la semántica de metatablas ni corrutinas; conserva operaciones nativas de indexación y llamadas `__call` que usa el script huésped.
- El aplanado del flujo de control no se aplica a bloques con `type` ni a bloques que leen una variable antes de declararla (una función que la usa también cuenta). Las funciones locales se hoistean con su nombre, así que la recursión se conserva. Los `break`/`continue` del bucle exterior se reescriben con estados reservados.
- La VM generada tiene límite de pasos (5 000 000 por defecto) y conserva la línea fuente en mensajes de error.
- Los códigos de operación, los nombres de los campos del prototipo VM y las claves de cadenas varían por build. Cada operando del bytecode se enmascara con una clave derivada de semilla, prototipo, posición y campo; las constantes de texto se codifican en el pool. La VM valida saltos, ranuras, constantes y capturas antes de emitir, y aplica límites de instrucciones, profundidad y pila en runtime. Es ofuscación, no cifrado.
- La VM generada prefiere `getgenv()` en executors y usa `getfenv(0)`/`_G` como fallback, indexación nativa para Instances/userdata y llamadas `__call`; aun así, debe validarse en Roblox Luau y cada executor objetivo.

## Limitaciones de la ofuscación actual

- La equivalencia se verifica con Lua 5.4 real, no con Luau: este entorno no tiene `luau`. Se compila el ejecutor con `tools/lua54/build.sh` (requiere `liblua5.4-0` y `gcc`). Las pruebas que dependen de él se omiten si falta. Luau y Lua 5.4 difieren en sintaxis (`continue`, `+=`) y en biblioteca, así que el aplanado con `continue` se verifica sólo con el intérprete de referencia.
- Pendiente: ejecutar las pruebas en Luau real.
- La protección de cadenas codifica bytes UTF-8 con una clave por literal y una máscara dependiente de posición; se descifra de forma perezosa y se cachea. Sigue siendo ofuscación reversible, no cifrado ni almacenamiento seguro de secretos.
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

## Compatibilidad Roblox / Luau

El motor acepta scripts Luau y mantiene los globals y llamadas del entorno huésped. Los usuarios eligen Basic, Medium o Max; Max incorpora la VM. La compatibilidad concreta depende de las APIs dinámicas usadas por cada script y debe comprobarse en Roblox Studio y en cada executor objetivo. No se garantiza compatibilidad universal.

## Marca de salida

Todas las salidas comienzan con un comentario Luau de identificación, por ejemplo `-- [Synex Obf] | profile: roblox | vm: on`. Se añade después de transformar el código para que permanezca como primera línea tanto en los perfiles normales como en las salidas virtualizadas.


## Synex Obfuscador: planes y acceso con Discord

La aplicación ofrece únicamente tres niveles de ofuscación:

- **Basic:** renombrado de identificadores y protección de cadenas.
- **Medium:** más transformación de constantes, expresiones, código muerto y aplanado de flujo de control.
- **Max:** transformaciones intensivas, comprobación de integridad y virtualización mediante la VM Luau con bytecode protegido.

El registro e inicio de sesión por correo sigue disponible. También se puede registrar e iniciar sesión mediante el **bot de Discord**, sin OAuth ni client secret. El usuario instala el bot, ejecuta `/synex-login` y recibe una respuesta privada con un enlace de un solo uso y 90 segundos de vigencia. Al abrirlo, la web intercambia el ticket y crea/inicia su sesión.

### Solo tres variables de Discord

Configura exactamente estas variables en Railway:

- `DISCORD_CLIENT_ID`: Application ID de Discord.
- `DISCORD_REDIRECT_URI`: URL pública de la web, por ejemplo `https://TU-DOMINIO/` (no es un callback OAuth).
- `DISCORD_BOT_TOKEN`: token secreto de la pestaña Bot.

No hace falta guardar la Public Key ni un Application ID duplicado: la API obtiene la clave de verificación desde `/oauth2/applications/@me` usando el bot token y comprueba que el ID de la aplicación coincide con `DISCORD_CLIENT_ID`.

### Configuración en Discord

1. Crea una aplicación en el [Discord Developer Portal](https://discord.com/developers/applications).
2. Copia **Application ID** en `DISCORD_CLIENT_ID`.
3. En la pestaña **Bot**, genera/copia el token y guárdalo en `DISCORD_BOT_TOKEN`. Nunca lo publiques ni lo subas a GitHub.
4. Configura el Interactions Endpoint URL como `https://TU-DOMINIO/api/discord/interactions`.
5. En Railway, configura `DISCORD_REDIRECT_URI` con la URL de tu web.
6. Reinicia/despliega la API: sincroniza automáticamente el comando global `/synex-login` al arrancar. Si necesitas forzar una sincronización manual, puedes ejecutar `node apps/api/scripts/register-discord-command.mjs` con Node 22.
7. Invita el bot al servidor desde el botón Discord de Synex o con un enlace de instalación que incluya los scopes `bot` y `applications.commands`.

El endpoint valida las firmas Ed25519 y la antigüedad de cada interacción. Los tickets de acceso son aleatorios, privados, de un solo uso y expiran en 90 segundos. El token del bot solo vive en el servidor; nunca se envía al navegador.
