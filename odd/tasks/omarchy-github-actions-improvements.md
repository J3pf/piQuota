# omarchy-github-actions-improvements — Ajustes de Omarchy para GitHub Actions (nombre resumido y consumo por organización)

## Goal

Mejorar la integración de piQuota con el panel de agentes de Omarchy para la familia `github-actions`:
1. **Resumir el nombre de la pestaña**: "GitHub Actions" (14 caracteres) satura y rompe el selector de pestañas cuando hay múltiples agentes configurados. Debe abreviarse a `"GH Actions"` en el registro de Omarchy.
2. **Identificar la organización y los minutos consumidos**:
   - En el Hero del panel (`tierLabel`): mostrar la organización configurada junto al plan (ej. `KoralisSoft · free`, o `KoralisFut, J3pf · free`).
   - En los límites (`limits[].title`): desglosar los minutos consumidos y la cuota total con el nombre de la organización (ej. `KoralisSoft (134 / 2000 min)`), permitiendo distinguir organizaciones con presupuestos y consumos independientes (ej. `KoralisFut != J3pf`).
   - Soportar múltiples organizaciones separadas por coma en `PI_QUOTA_GITHUB_ORG` (ej. `KoralisFut, J3pf`) para consultar y reportar cada una en ventanas dedicadas.

## Why

- En el panel de agentes de Omarchy (`Panel.qml`), el ancho de los botones de pestañas se calcula equitativamente dividiendo el ancho total entre el número de proveedores: `(width - spacing * (N - 1)) / N`. Con 4 o más agentes, "GitHub Actions" se desborda y corta o rompe el layout visual.
- El panel solo mostraba el porcentaje y "Monthly" / "Free", sin indicar qué organización se estaba consultando ni cuántos minutos reales se habían gastado sobre el total del plan.
- Los usuarios con múltiples cuentas u organizaciones (ej. una personal `J3pf` y una corporativa `KoralisFut` o `KoralisSoft`) tienen diferentes planes y consumos de minutos que necesitan auditar sin ambigüedad.

## Plan

| # | Task | File(s) | Acceptance |
|---|---|---|---|
| 1 | Tests primero (RED): verificar que `buildRecord` para `github-actions` produzca `name: "GH Actions"`, `tierLabel: "<account> · <plan>"`, y que `limits[0].title` contenga la organización y minutos consumidos. Test para soporte multi-org en `github-actions.js`. | `tests/omarchy.test.mjs`, `tests/github-actions.test.mjs` | Tests fallan antes de los cambios. |
| 2 | Modificar `src/omarchy/record.js`: abreviar el nombre a `"GH Actions"` para `github-actions`, incluir la organización en `tierLabel`, y enriquecer `windowTitle` con los minutos consumidos y la organización para `github-actions`. | `src/omarchy/record.js` | Tests de Omarchy en GREEN. |
| 3 | Extender `src/providers/github-actions.js`: soportar lista separada por comas en `PI_QUOTA_GITHUB_ORG`, consultar cada una, generar ventanas específicas por org, y admitir fallback a `/users/{org}` si `/orgs/{org}` es una cuenta personal. | `src/providers/github-actions.js` | Tests de GitHub Actions en GREEN. |
| 4 | Actualizar el contador de tests en `README.md` y verificar integridad de documentación. | `README.md` | `node --test tests/docs.test.mjs` pasa al 100%. |
| 5 | Preparar release 0.10.2: bump en `package.json` y `bin/piquota.js`, commit convencional descriptivo en `master`, push a `origin/master`, y crear GitHub release para activar el workflow de npm. | `package.json`, `bin/piquota.js` | Release en GitHub y publicación en npm ejecutada. |
