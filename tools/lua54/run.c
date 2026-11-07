/* Harness mínimo: ejecuta un fichero Lua 5.4 con la API C declarada a mano (sin cabeceras). */
#include <stdio.h>
#include <stdlib.h>
typedef struct lua_State lua_State;
extern lua_State *luaL_newstate(void);
extern void luaL_openlibs(lua_State *L);
extern int luaL_loadfilex(lua_State *L, const char *filename, const char *mode);
extern int lua_pcallk(lua_State *L, int nargs, int nresults, int errfunc, long ctx, void *k);
extern const char *lua_tolstring(lua_State *L, int idx, size_t *len);
extern void lua_close(lua_State *L);
int main(int argc, char **argv) {
  if (argc < 2) return 2;
  lua_State *L = luaL_newstate();
  luaL_openlibs(L);
  if (luaL_loadfilex(L, argv[1], NULL) != 0 || lua_pcallk(L, 0, 0, 0, 0, NULL) != 0) {
    size_t n; const char *m = lua_tolstring(L, -1, &n);
    fprintf(stderr, "LUAERR: %s\n", m ? m : "?");
    return 1;
  }
  lua_close(L);
  return 0;
}
