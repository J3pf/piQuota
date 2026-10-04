# github-actions-minutes-quota — minutos de GitHub Actions como quota de piQuota, con feature flag

## Goal

Añadir una **quota nueva** a piQuota: los **minutos de GitHub Actions** que el usuario
gasta en los repos `easypets-registry-*` (y, por defecto, en toda la org), mostrando

1. **cuántos minutos nos da** el plan ese mes (la "cuota"),
2. **cuántos we've consumed**,
3. **cuántos quedan**, y cuándo resetea el ciclo.

La funcionalidad debe ser **quirúrgica**: **apagada por defecto**, encenderse y apagarse
con una variable de entorno o por nombre de familia en la CLI, sin tocar el output por
defecto de `piquota` y sin degradar ningún proveedor existente.

## Why

- Los CI de `easypets-registry-app` (`android-release.yml`, `ios-build.yml`) y de
  `easypets-registry-api` (`deploy.yml`) consumen minutos reales de una org con pool
  compartido. Hoy nadie ve el consumo hasta que GitHub corta el CI o llega la factura.
- Los minutos son un **pool de org**, no un presupuesto por repos. El número que duele
  ("cuánto queda") es org-wide; el desglose por repo es solo atribución.
- **La API ya no expone el presupuesto.** El endpoint legado
  `GET /orgs/{org}/settings/billing/actions` (que devolvía `included_minutes`) responde
  **410 Gone**. Los endpoints nuevos (`/billing/usage`, `/billing/usage/summary`) devuelven
  **solo `usageItems`**, sin `includedItems`. Por eso el presupuesto se deriva del plan y
  admits override por env.

## Verified facts (live, 2026-10-04)

| Hecho | Valor | Evidencia |
|---|---|---|
| Auth disponible | `gh` CLI, scopes `gist read:org repo workflow` | `gh auth status` |
| Org | `KoralisSoft`, plan `free` | `GET /orgs/KoralisSoft` |
| Presupuesto incluido | **2000 min/mes** (Free org, válido también en repos privados) | GitHub docs, billing/concepts/product-billing/github-actions |
| Gasto del mes | **52 min** Actions Linux, `discountQuantity == grossQuantity`, `netQuantity: 0` | `GET /organizations/KoralisSoft/settings/billing/usage/summary?product=Actions` |
| Restante | **1948 min** | derivado |
| Reset | 1er día del mes siguiente | ciclo de facturación de GitHub |
| Desglose por repo | `easypets-registry-api` = 52 min; `easypets-registry-app` = **0** | `GET /organizations/KoralisSoft/settings/billing/usage` |
| Repos | los 4 de `KoralisSoft` son **privados** | `GET /repos/KoralisSoft/<r>` |
| Endpoint legado | **410 Gone** (verificado con headers) | `GET /organizations/KoralisSoft/settings/billing/actions` |

## Design decisions (taken with the user)

| Decisión | Valor | Motivo |
|---|---|---|
| Fuente del presupuesto | **plan-derived + override env** | La API no lo da. Tabla Free=2000, Pro=3000, Team=3000. |
| Default del flag | **apagado** | Surgical: cero cambio en el output por defecto. |
| Token | **nunca entra en memoria**; se delega a `gh api` | AGENTS.md: cero fuga de secretos, credenciales que Pi ya posee. |
| Unidad de la ventana | **porcentaje nativo** + nota con minutos exactos | `QuotaWindow` es percent-based; evita tocar el renderer. |
| Scope del quota | **org-wide**, con atribución por repo | El pool es de org; el repo es atribución. |

## Plan

| # | Task | File(s) | Acceptance |
|---|------|---------|------------|
| 1 | Tests primero (RED): contrato del provider, gate on/off, allowance plan-derived, overlay env, degradaciones (sin `gh`, org sin acceso, payload roto, plan desconocido). | `tests/github-actions.test.mjs`, `tests/helpers.mjs` | Tests fallan por el módulo inexistente. |
| 2 | `src/providers/github-actions.js`: resolver org/repos/allowance desde env, leer `usage/summary` (org) + `usage` (por repo) vía `gh api` con `runCommand`, derivar `usedPercent`/`remainingPercent`, nota con minutos exactos, `resetsAt` = 1er día del mes siguiente, y `degradedResult` accionable en cada fallo. | nuevo | GREEN en T1. Nunca lanza. |
| 3 | Registro y gate en el engine: familia `github-actions` en `FAMILIES`/`PROVIDERS`, **filtrada por defecto**, activa solo con `PI_QUOTA_GITHUB_ACTIONS=1` o selección explícita de familia. Fuente de credencial propia (no Pi store). Gate en **una sola función pura exportada**, `enabledFamilies({env, requested})`, compartida por el engine y el CLI. | `src/engine.js`, `bin/piquota.js` | `piquota` default sin cambios; `piquota github-actions` funciona; flag env lo añade. |
| 4 | Superficies de render: alias CLI, etiquetas de familia, fila condicional del widget box, mapas de color/label en la extensión TUI y en el cliente Moshi. | `src/cli/explain.js`, `src/auth/pi-auth.js`, `src/render/panel.js`, `extensions/quota-panel.ts`, `src/moshi/client.js` | La familia se renderiza en todas las superficies sin regresión. |
| 5 | Documentación y contador de tests: filas nuevas en las tablas de README, mapa de módulos, y **actualizar el contador publicado de tests**. | `README.md` | `node --test tests/docs.test.mjs` pasa. |
| 6 | Verificación completa y commit work-unit con Conventional Commit + cuerpo. | repo | `npm test` verde; commit en rama feature. |

## Config surface

| Variable | Default | Efecto |
|---|---|---|
| `PI_QUOTA_GITHUB_ACTIONS` | `0` | `1` enciende la familia en todas las superficies. |
| `PI_QUOTA_GITHUB_ORG` | `KoralisSoft` | Org consultada. |
| `PI_QUOTA_GITHUB_ACTIONS_MINUTES` | derivado del plan | Override del presupuesto mensual. |
| `PI_QUOTA_GITHUB_ACTIONS_REPOS` | vacío = org completa | CSV de repos para atribución (ej. `easypets-registry-api,easypets-registry-app`). |
| `GH_TOKEN` / `GITHUB_TOKEN` | — | Se pasan a `gh`; el token nunca se lee en memoria. |

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~420 |
| 400-line budget risk | Borderline |
| Chained PRs recommended | No (una sola feature coherente) |
| Riesgo dominante | Resiliencia (degradación + proceso externo) y riesgo (secretos) |

## Scope decisions taken during implementation

| Decisión | Resolución | Motivo |
|---|---|---|
| `bin/piquota.js` fuera de superficies | **Autorizado y editado** | `bin/piquota.js:144` pasaba el `FAMILIES` crudo a `withCache` **antes** del gate, así que la familia apagada igual entraba en la clave de caché y provocaba un refetch en cada run por defecto. Es una regresión real contra el objetivo surgical. |
| Agente de Moshi | **Se conserva el fallback `pi` genérico** | `src/moshi/artifact.js:52` ya fija `agent: "pi"` en cada snapshot y `src/moshi/client.js:154` ya resuelve `NATIVE_AGENT[family] ?? PI_AGENT`. El fallback es comportamiento previo y deliberado; `pi` es un agent id válido. El único coste es el logo de Pi en vez de GitHub, y solo para quien activa la feature. **No inventar un agent id.** |

## Evidence / commits

| Commit | Alcance | Verificación |
|---|---|---|
| `f14ffd1` `feat(github-actions): add opt-in GitHub Actions minutes quota` | rama `feat/github-actions-minutes-quota`, 16 archivos, +944 / -39 | `node --test tests/*.test.mjs` → **289 pass, 0 fail**; `tests/docs.test.mjs` 6/6; `tests/github-actions.test.mjs` 16/16 |

Evidencia de comportamiento real contra la API de GitHub (org `KoralisSoft`, plan `free`):

```json
{"family":"github-actions","label":"GitHub Actions","account":"KoralisSoft","plan":"free","source":"gh CLI",
 "windows":[{"id":"monthly","label":"Monthly window","usedPercent":3.75,"remainingPercent":96.25,
             "resetsAt":"2026-11-01T00:00:00.000Z","resetsInSec":2360018,"windowSeconds":null,
             "note":"75 of 2000 min used | 1925 left"}],
 "error":null,"ok":true,"primaryWindowId":"monthly"}
```

Propiedades verificadas una por una:

| Propiedad | Comando | Resultado |
|---|---|---|
| Apagado por defecto | `node bin/piquota.js --json \| grep -c github-actions` | `0` |
| Encendido por env | `PI_QUOTA_GITHUB_ACTIONS=1 node bin/piquota.js --json` | presente, `ok:true` |
| Selección explícita | `node bin/piquota.js github-actions --json` | presente, `ok:true` |
| Alias | `piquota gh`, `piquota actions` | exit `0` |
| Familia desconocida | `piquota nonexistent-family` | exit `2`, nombra la familia, no crashea |
| **Rollback con caché sucia** | run con flag ON (caché guarda 3) → run con flag OFF | `0` — la familia no se filtra de vuelta |
| Sin fuga de secretos | `grep -rniE 'gh[opsu]_[A-Za-z0-9]{20,}\|gho_\|github_pat_'` sobre salidas y caché | sin coincidencias |

## Review findings (resolved)

| # | Severidad | Hallazgo | Resolución |
|---|---|---|---|
| F1 | **blocker** | Un mes sin consumo degradaba con "no Linux minute rows" en vez de reportar `0 de 2000 min`. El test lo consagraba con `{usageItems: []}`. | Distinción payload-maloformado vs cero-consumo. Tests para array vacío **y** para array con solo la fila `actions_storage` (el caso real de un mes tranquilo). |
| F2 | baja | `options.now ?? 0` divergía de la convención y daba fechas de 1970 en silencio. | `options.now ?? Date.now()`, igual que el resto de providers. |
| F3 | baja | `31 * 86400` quedaba **exactamente** sobre el límite de `windowFromSeconds`; las filas del box filtran `id === "monthly"`. | Duración de 30 días, dentro del rango. Test que afirma el id exacto `monthly`. |
| F4 | media | Gate por `Symbol.for(...)` colgado del array: un spread o round-trip lo perdía y `piquota github-actions` fallaba en silencio. | `resolveFamilies` devuelve `explicit: boolean`; `enabledFamilies` lo recibe como dato plano. Test con la lista copiada. |
| F5 | **blocker** | `tests/refresh.test.mjs:343` fallaba: la suite estaba en **287/288**. | Assertion actualizada + barrido de las demás listas hardcodeadas de familias. |
| F6 | baja | El worker objetó que el `agent: "pi"` de Moshi podía ser rechazado. Falso positivo. | Verificado: `artifact.js:52` ya fija `agent:"pi"` en cada snapshot y `client.js:154` ya resuelve `NATIVE_AGENT[f] ?? PI_AGENT`. Es comportamiento previo y deliberado para cualquier familia no mapeada; `pi` es un agent id válido. Sin riesgo nuevo. |

## Review findings (superseded)

Los hallazgos F1 a F5 están resueltos y documentados en **Evidence / commits** más abajo. Este bloque se conserva como registro de la revisión original.

| # | Severidad | Hallazgo | Ubicación |
|---|---|---|---|
| F1 | **blocker** | Un mes sin consumo no debe degradar. `sumLinuxMinutes` devuelve `null` cuando no hay filas Linux, y eso se traduce en "no Linux minute rows" en vez de `0 of 2000 min used`. El test actual **consagra** el bug con `{usageItems: []}`. Impacto real: `easypets-registry-app` está en 0 y un mes tranquilo rompería el panel. | `src/providers/github-actions.js`, `tests/github-actions.test.mjs:217-218` |
| F2 | baja | `options.now ?? 0` diverge de la convención del repo (`?? Date.now()`) y produce fechas de 1970 en silencio si alguien llama al provider directo. No es alcanzable desde el engine, que siempre pasa `now`. | `src/providers/github-actions.js` |
| F3 | baja | `LINUX_MINUTES = 31 * 24 * 3600` queda **exactamente** sobre el límite `<= 31 * 86400` de `windowFromSeconds`. Funciona, pero cualquier cambio del constante rompe en silencio las filas del box widget, que filtran `window.id === "monthly"`. | `src/providers/github-actions.js` |
| F4 | media | El gate usa un canal oculto: `Symbol.for("piQuota.explicitFamilies")` colgado del array que devuelve `resolveFamilies`. Cualquier copia del array (spread, filter, round-trip JSON) pierde la marca y `piquota github-actions` deja de funcionar en silencio. Debería ser un campo `explicit` explícito. | `src/cli/explain.js`, `src/engine.js` |

## Notes

- **No inventar el presupuesto.** Si el plan no está en la tabla, el provider degrada con
  un mensaje que nombra `PI_QUOTA_GITHUB_ACTIONS_MINUTES`, en vez de mentir con un 2000.
- El consumo real siempre viene de la API; el override solo cambia el denominador.
- `src/exec.js` dice hoy que el único binario externo es moshi-hook. Añadir `gh` obliga a
  actualizar ese docstring — es un cambio honesto, no un parche.
- Los minutos de repos públicos no consumen quota; el `discountQuantity` lo delata.