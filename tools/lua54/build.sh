#!/bin/sh
# Compila el ejecutor de Lua 5.4 usado por las pruebas de equivalencia real.
# Requiere la biblioteca compartida liblua5.4 (paquete liblua5.4-0 en Debian/Ubuntu).
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
LIB="${LUA54_LIB:-/usr/lib/x86_64-linux-gnu/liblua5.4.so.0}"
gcc -O1 "$HERE/run.c" "$LIB" -o "$HERE/lua54run"
echo "Ejecutor: $HERE/lua54run"
