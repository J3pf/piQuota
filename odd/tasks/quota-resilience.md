# quota-resilience — sticky/last-good aplicado a la extensión TUI + glifos por causa

## Goal

Que el plugin sea **verdaderamente resiliente**: cuando un proveedor falla por una causa
transitoria (throttle, timeout, 5xx, ECONNRESET) el TUI y el panel deben mostrar el último
valor bueno conocido en lugar de un `!` ciego. Los fallos que sí son permanentes
(token expirado, sin credencial, sin cookie de opencode.ai) deben distinguirse
visualmente de los transitorios y nunca enmascararse.

## Why

- Hoy el binario CLI y el watcher Moshi ya usan `mergeLastGood` para restaurar el último
  valor bueno. La **extensión TUI no**, así que un throttle de Anthropic, un timeout
  de Codex o un 5xx momentáneo de Antigravity dejan al usuario con un `!` durante
  5 minutos (la ventana de backoff) aunque hay un valor sano de hace 30 segundos.
- Todos los fallos se renderizan con el mismo glifo `!`. El usuario no puede distinguir
  "esperando" (transitorio, recuperándose) de "acción requerida" (permanente).
- El filtro `notConfigured` se hace por string-match del mensaje de error, que es frágil.

## Plan

| # | Task | File(s) | Acceptance |
|---|------|---------|------------|
| 1 | Helper `errorKind(error)` que clasifica cada error en `transient`, `expired`, `auth`, `missing`, `throttle`, `unknown` y devuelve el glifo + color asociado. | `src/providers/error-kind.js` (nuevo) | Función pura, exportada, cubierta por tests unitarios para cada categoría. |
| 2 | Aplicar `mergeLastGood` a la extensión TUI: leer `~/.cache/pi-quota/last-good.json`, mergear, pintar el resultado. | `extensions/quota-panel.ts` | El panel y la línea reflejan el último bueno cuando el fetch falla transitoriamente. |
| 3 | Distinguir glifos en `renderLine` (TUI) y `renderStatusLine` (CLI) por categoría de error: `…` throttle, `~` transient sin sticky, `!` permanente, `?` sin dato. | `extensions/quota-panel.ts`, `src/render/panel.js` | Cada categoría tiene glifo + tooltip/mensaje diferenciados. Cubierto por tests. |
| 4 | Filtro `notConfigured` robusto: usar el flag, no el string del mensaje. | `extensions/quota-panel.ts`, `src/render/panel.js` | Ningún renderer depende del texto literal del mensaje. |
| 5 | Tests: casos nuevos en `tests/render.test.mjs` y `tests/extension.test.mjs` cubriendo cada categoría, sticky en TUI, filtro notConfigured. | `tests/*.test.mjs` | Todos los tests pasan (192 + nuevos). |
| 6 | Commit de work-unit con mensaje Conventional Commit. | repo | Un commit en la rama feature. |

## Evidence / commits

Pendiente hasta T6.

## Notes

- `mergeLastGood` ya distingue auth de transient y descarta valores viejos (30 min
  de antigüedad por default). Reusarlo es seguro.
- Los nuevos glifos deben seguir el principio de "leer en mono / colourblind":
  forma + color, no solo color.
- El cambio en el TUI extension NO debe romper el contrato de la extensión (status key,
  widget key, comandos `/quota *`). Se mantiene todo igual.
