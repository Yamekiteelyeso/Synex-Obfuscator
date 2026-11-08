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
| `packages/runtime` | Intérprete de referencia sobre el AST, con globals básicos, `table`, `string`, `math` y `bit32`; oráculo de equivalencia para la VM y las transformaciones. La biblioteca implementa un subconjunto documentado de Lua/Luau, no toda la biblioteca estándar. |
| `packages/engine` | Motor de orquestación: planes públicos (Basic, Medium, Max), etapas con tiempos, digest SHA-256, comprobación de equivalencia, VM configurable y sistema de trabajos en worker_threads con límites de cola, tamaño y tiempo. Incluye pruebas del perfil completo en Lua 5.4 real (13 pruebas) |
| `apps/api` | API HTTP sin dependencias: autenticación exclusiva por Discord, cuentas y planes persistidos en JSON, cuota Free por cuenta y asignación administrativa manual de planes, límite de peticiones por IP y endpoints de trabajos. |
| `apps/web` | Acceso solo por Discord, editor con perfiles Basic/Medium/Max según plan, sección Free/Premium/Plus con contacto directo para comprar y administración de cuentas. |

## Biblioteca estándar del runtime

El intérprete de referencia y la VM comparten estas implementaciones:

- **Globales:** `print`, `tostring`, `tonumber`, `type`, `error`, `pcall`, `select`, `pairs`, `ipairs`.
- **`table`:** `concat`, `pack`, `unpack`, `insert`, `remove`, `sort`, `move`, `clone`, `clear`, `find`, `create`.
- **`string`:** `char`, `len`, `byte`, `sub`, `rep`, `lower`, `upper`, `reverse`, `split`, `find` en modo literal y `format` con conversiones comunes.
- **`math`:** operaciones trigonométricas y numéricas habituales, `abs`, `min`, `max`, `clamp`, `sign`, `round`, `modf`, `random`, `randomseed`, `type`, `tointeger`, `pi` y `huge`.
- **`bit32`:** `band`, `bor`, `bxor`.

No están implementadas todavía todas las APIs de Lua/Luau: `string.find` sólo admite búsqueda literal con el argumento `plain=true` (los patrones Lua y capturas aún no están implementados); `string.format` cubre conversiones comunes pero no todos los modificadores y formatos (`%a` hexadecimal, por ejemplo); `string.match`, `string.gsub`, corrutinas, metatablas completas y APIs específicas de Roblox siguen pendientes. El generador aleatorio del runtime es reproducible y útil para pruebas, pero no pretende replicar bit a bit el PRNG de Lua 5.4 ni es criptográfico. Las cadenas internas son byte-strings UTF-8; las funciones de caso convierten sólo ASCII para evitar alterar bytes no ASCII.

## Estado del lexer

Soportado: identificadores, palabras clave de Luau (`continue`, `type`, `export`, `typeof`),
operadores compuestos (`+=`, `-=`, `*=`, `/=`, `//=`, `%=`, `^=`, `..=`), números
(decimal, exponente, hex, binario, separador `_`), cadenas con escapes (`\n`, `\x`, `\u{}`,
`\ddd`, `\z`), corchetes largos con nivel, comentarios de línea y de bloque.

Limitaciones actuales: sin tokens de tipos de Luau completos (los tokens se reconocen,
pero aún no hay parser de tipos); sin soporte de cadenas con `\` seguido de bytes
UTF-8 fuera del rango ASCII tratados de forma especial.

## API

La autenticación de usuarios es exclusivamente mediante Discord OAuth2. El backend valida el `state`, intercambia el código en el servidor y consulta el perfil con el scope mínimo `identify`. Después emite un ticket de un solo uso para establecer la sesión. No hay bot instalado, comandos slash ni permisos sobre servidores. Las rutas antiguas de correo y contraseña devuelven `410 E_DISCORD_ONLY`.

| Método | Ruta | Acceso |
|---|---|---|
| GET | /api/auth/discord | público (redirige a OAuth2) |
| GET | /api/auth/discord/callback | público (callback OAuth2) |
| POST | /api/auth/discord/exchange | público (ticket de un solo uso) |
| POST | /api/auth/register, /api/auth/login | desactivado (410) |
| POST | /api/auth/logout | usuario |
| GET | /api/me | usuario (identidad, plan y cuota) |
| GET | /api/plans | público |
| POST | /api/jobs | usuario (cuota y perfiles comprobados en servidor) |
| GET | /api/jobs | usuario (historial propio) |
| GET | /api/jobs/:id | dueño |
| GET | /api/jobs/:id/code | dueño (descarga `.obf.luau`) |
| GET | /api/stats | usuario |
| GET | /api/profiles, /api/health | público |
| GET | /api/admin/users, /jobs, /errors, /settings | admin |
| PUT | /api/admin/settings, /api/admin/users/:id/plan | admin |

Las cuentas, el plan, el contador de usos y el historial se guardan en el archivo configurado en `SYNEX_DATA_FILE`. Para conservarlos en Railway, monta un Volume en `/data`. Los tokens de sesión se persisten en el JSON. Los estados OAuth se limitan a 10.000 entradas (5 minutos), los tickets de intercambio a 10.000 (90 segundos), las ventanas de rate limit por IP a 50.000 (60 segundos) y el limitador de intentos de login a 10.000 claves; al alcanzar capacidad se eliminan entradas caducadas y después las más antiguas. Los resultados descargables se mantienen temporalmente en memoria (máximo 100 resultados, 64 MiB agregados y 30 minutos); los resultados individuales que superen el presupuesto no se almacenan. La cola conserva como máximo 5.000 registros de trabajo recientes y libera el bytecode resultante después de transferirlo a la caché de descargas. Los estados OAuth y los tickets de intercambio también residen en memoria. Por ello, ejecuta una sola réplica de API mientras no se migren esos estados efímeros a un almacén compartido; varias réplicas pueden romper el callback OAuth o perder descargas tras reiniciar.

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
- Los códigos de operación y los campos del prototipo varían por build; además, el orden real de los brazos del dispatcher se baraja por semilla, no sólo sus identificadores. Cada operando se enmascara según semilla, prototipo, posición y campo; el layout físico de instrucciones se permuta y los sucesores se enlazan explícitamente. Los metadatos de línea se codifican por prototipo. Las constantes numéricas se serializan como bytes IEEE-754; las cadenas largas se dividen en fragmentos con claves independientes y se reconstruyen bajo demanda mediante closures. Cada fragmento de cadena y cada bloque de bytes numéricos incorpora su propio sello de integridad, verificado antes de decodificar; cada instrucción también se valida con dos sellos antes del despacho; los prototipos y bloques usan sellos de doble acumulador que cubren instrucciones, mapas, descriptores y disposición de upvalues. Los decoders no mantienen una caché persistente de texto plano: los valores reconstruidos existen en memoria mientras el programa los usa y pueden observarse mediante un volcado o instrumentación del runtime. Esto reduce la exposición estática, pero no puede impedir un volcado de memoria en un proceso controlado por un tercero. La integridad es tamper-evident, no una firma criptográfica: un atacante que controle el proceso puede parchear el verificador. Es ofuscación, no cifrado.
- La VM generada prefiere `getgenv()` en executors y usa `getfenv(0)`/`_G` como fallback, indexación nativa para Instances/userdata y llamadas `__call`; aun así, debe validarse en Roblox Luau y cada executor objetivo.

## Limitaciones de la ofuscación actual

- La equivalencia se verifica con Lua 5.4 real, no con Luau: este entorno no tiene `luau`. Se compila el ejecutor con `tools/lua54/build.sh` (requiere `liblua5.4-0` y `gcc`). Las pruebas que dependen de él se omiten si falta. Luau y Lua 5.4 difieren en sintaxis (`continue`, `+=`) y en biblioteca, así que el aplanado con `continue` se verifica sólo con el intérprete de referencia.
- CI instala Luau CLI oficial (versión fijada y checksum SHA-256 verificado) y ejecuta una prueba de la VM emitida en Luau real, además de las pruebas existentes en Lua 5.4. Esto verifica una ruta representativa, pero no sustituye pruebas de todos los perfiles ni de Roblox Studio/executors.
- La protección de cadenas codifica bytes UTF-8 con una clave por literal y una máscara dependiente de posición; se descifra bajo demanda sin mantener una caché persistente de texto plano. El valor reconstruido existe durante su uso y puede observarse en memoria o interceptando el runtime. Sigue siendo ofuscación reversible, no cifrado ni almacenamiento seguro de secretos.
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

El único administrador autorizado está fijado en el servidor por ID de Discord `1518079144590573690`; las demás cuentas reciben rol de usuario. Configura las tres variables OAuth2 de Discord descritas abajo. Para conservar cuentas, planes, cuotas e historial entre despliegues, monta un Volume en `/data` y define `SYNEX_DATA_FILE=/data/synex-data.json`. Sin un Volume, el almacenamiento JSON local puede perderse al reemplazar el contenedor.

## Compatibilidad Roblox / Luau

El motor acepta scripts Luau y mantiene los globals y llamadas del entorno huésped. Los usuarios eligen Basic, Medium o Max; Max incorpora la VM. La compatibilidad concreta depende de las APIs dinámicas usadas por cada script y debe comprobarse en Roblox Studio y en cada executor objetivo. No se garantiza compatibilidad universal.

## Uso de la VM desde TypeScript

El paquete `@synex/vm` exporta `compileToLuauVm`, `emitLuauVm`, `runInVm` y `VM`.
La emisión acepta una semilla uint32 para hacer reproducible un build y opciones opcionales: El motor valida el mismo rango para todos los perfiles; la API rechaza semillas inválidas antes de aceptar el trabajo y genera semillas automáticas en todo el rango uint32.

```ts
import { compileToLuauVm } from '@synex/vm';

const output = compileToLuauVm(source, 123456, {
  stepLimit: 5_000_000,
  watermark: 'synex.release:2026-11',
});
```

- `seed`: entero entre `0` y `4294967295`; la misma fuente, semilla y opciones generan la misma salida.
- `stepLimit`: entero seguro positivo; limita las instrucciones ejecutadas por la VM emitida.
- `watermark`: identificador opcional de 1 a 64 caracteres ASCII (`A-Z a-z 0-9 . _ : -`). Se añade como comentario visible al principio de la salida y sirve como marca de procedencia, no como marca resistente a eliminación.
- La instancia TypeScript `VM` reinicia el contador de pasos en cada llamada de nivel superior a `execute`; las llamadas anidadas comparten el presupuesto de esa ejecución.

Los límites son defensas de robustez y consumo de recursos, no sustituyen límites externos de CPU/memoria ni hacen seguro ejecutar código no confiable dentro del proceso del servidor.

## Marca de salida

Todas las salidas comienzan con un comentario Luau de identificación, por ejemplo `-- [Synex Obf] | profile: roblox | vm: on`. Se añade después de transformar el código para que permanezca como primera línea tanto en los perfiles normales como en las salidas virtualizadas.


## Synex Obfuscador: planes y acceso con Discord

La aplicación ofrece únicamente tres niveles de ofuscación:

- **Basic:** renombrado de identificadores y protección de cadenas.
- **Medium:** más transformación de constantes, expresiones, código muerto y aplanado de flujo de control.
- **Max:** transformaciones intensivas, comprobación de integridad y virtualización mediante la VM Luau con bytecode protegido.

El registro y el inicio de sesión son **exclusivamente mediante Discord OAuth2**. La persona pulsa **Continuar con Discord**, acepta la autorización de Synex y regresa automáticamente a la web. Synex solicita únicamente el scope `identify` para verificar el ID y nombre de la cuenta. **No instala un bot, no solicita acceso a servidores, no requiere invitarlo a ningún servidor y no utiliza comandos slash.** Cada cuenta se crea una sola vez por ID de Discord y se reutiliza en accesos posteriores.

### Solo tres variables de Discord

Configura estas tres variables en Railway:

- `DISCORD_CLIENT_ID`: Application ID de tu aplicación de Discord.
- `DISCORD_CLIENT_SECRET`: Client Secret de la sección OAuth2. **No uses aquí el Bot Token.** Es un secreto de servidor y nunca se envía al navegador.
- `DISCORD_REDIRECT_URI`: callback OAuth2 exacto, por ejemplo `https://TU-DOMINIO/api/auth/discord/callback`.

### Configuración en Discord

1. Abre el [Discord Developer Portal](https://discord.com/developers/applications) y crea o selecciona la aplicación.
2. Copia **Application ID** y **Client Secret** desde la configuración OAuth2 de la aplicación.
3. En OAuth2, agrega como Redirect URI exactamente `https://TU-DOMINIO/api/auth/discord/callback`. Debe coincidir con `DISCORD_REDIRECT_URI` en Railway, incluido el path.
4. En Railway define `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` y `DISCORD_REDIRECT_URI`, y despliega la aplicación.

No necesitas configurar la pestaña Bot, un Bot Token, un Interactions Endpoint ni un servidor de Discord. El backend valida el parámetro `state`, canjea el código OAuth2 en el servidor y consulta `/users/@me` con el permiso mínimo `identify`. La sesión se entrega mediante un ticket aleatorio de un solo uso y 90 segundos de vigencia; el token de sesión no aparece en la URL.

## Synex v6 — entorno y privacidad de cadenas

La VM usa un proxy privado para resolver globals y filtra APIs de introspección/hooking habituales (`getgenv`, `getfenv`, `getreg`, `getgc`, `debug`, `hookfunction`, `hookmetamethod`, entre otras) desde el entorno del script virtual. Las cadenas del pipeline se descifran bajo demanda y no se guardan en una caché persistente de texto plano.

Estas medidas reducen exposición accidental y dificultan algunas formas simples de inspección, pero **no son una garantía anti-logger**: un executor que controla el proceso puede parchear funciones, instrumentar llamadas, leer memoria o capturar argumentos ya descifrados. No guardes credenciales, tokens ni secretos dentro de scripts ofuscados.

La interfaz principal abre directamente el Ofuscador; Panel e Historial ya no aparecen en la navegación del usuario. La autenticación por Discord utiliza un botón azul con el logotipo oficial.


## Planes de cuenta Free / Premium / Plus

Los planes de cuenta son independientes de los perfiles de ofuscación:

| Plan de cuenta | Cuota | Perfiles |
|---|---:|---|
| **Free** | 2 trabajos aceptados por cuenta de Discord, en total | Basic |
| **Premium** | Ilimitada | Basic y Medium |
| **Plus** | Ilimitada | Basic, Medium y Max |

Cada petición de trabajo aceptada consume un uso Free, incluso si luego el script falla al procesarse. El contador vive en el registro persistente de la cuenta y las cuentas antiguas migran su contador desde el historial existente. El servidor aplica la cuota y los perfiles permitidos; la interfaz no es la única barrera.

La sección **Planes** no permite enviar solicitudes ni procesar compras dentro de la web: los botones de Premium y Plus muestran `Contact one admin for buy`. El administrador asigna manualmente el plan desde Administración después de confirmar la compra por un canal externo. No hay pasarela de pago integrada.

El único ID con privilegios administrativos está fijado en `apps/api/src/server.ts`: `1518079144590573690`. No hay acceso administrativo por correo o contraseña.
