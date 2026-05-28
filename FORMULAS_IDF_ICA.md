# Fórmulas IDF e ICA — Documento Canónico v1.0

Este documento es la **fuente única de verdad matemática** para los dos índices del producto.

- **Ag06 (FinOps Auditor)** implementa estas fórmulas en TypeScript.
- **Ag02 (Pattern Architect)** implementa la función SQL `calcular_idf_dimensions`.

Cualquier divergencia entre las implementaciones se resuelve actualizando este documento, no las implementaciones. Cualquier cambio aquí dispara bump de versión + nota en CHANGELOG + consideración de migración de scores históricos.

## Convenciones

- Todos los scores normalizados al rango [0, 100].
- Todos los pesos suman 1.0 (100%).
- "Mes" = mes calendario, no rolling 30 días, salvo indicación explícita.
- Promedios móviles usan ventana de 3 meses salvo indicación.
- Tipo de retorno SQL: jsonb. Tipo de retorno TS: estructura tipada con `null` cuando aplique.

---

# IDF — Índice de Dominio Financiero

## Fórmula maestra

```
IDF = 0.40 × ProgresoMeta
    + 0.25 × ControlFugas
    + 0.20 × EstabilidadBase
    + 0.15 × VelocidadAhorro
```

## Niveles

| Rango | Nivel | Icono UI |
|-------|-------|----------|
| 0–25 | Bronce | ⬜ |
| 26–50 | Plata | 🔵 |
| 51–75 | Oro | 🟡 |
| 76–100 | Diamante | 💎 |

## Precondición

El IDF **requiere meta declarada activa** (`goals.status = 'active'`). Sin meta, devolver:

```json
{
  "idf_total": null,
  "nivel": null,
  "datos_disponibles": false,
  "razon": "no_goal_declared",
  "siguiente_accion": "consigliere_debe_pedir_meta"
}
```

---

## Componente 1 — ProgresoMeta (peso 40%)

Mide qué tan cerca está el usuario de cumplir su meta en el plazo declarado.

### Inputs

- `T` = `goals.target_amount` (target en €)
- `D_target` = `goals.target_date`
- `D_now` = fecha actual (UTC)
- `D_start` = `goals.created_at`
- `total_saved` = suma de transacciones con `type = 'saving'` entre `D_start` y `D_now`
- `monthly_avg_3mo` = promedio de ahorro mensual en los últimos 3 meses calendario

### Pseudocódigo

```
meses_restantes = max(1, months_between(D_now, D_target))

if (T - total_saved) <= 0:
    ProgresoMeta = 100  // meta ya cumplida o superada
    return

if D_target < D_now:
    // meta vencida sin cumplirse
    ProgresoMeta = min(100, 100 * (total_saved / T))
    return

required_monthly = (T - total_saved) / meses_restantes
actual_monthly = monthly_avg_3mo

if required_monthly <= 0:
    ProgresoMeta = 100
    return

ratio = actual_monthly / required_monthly
base_score = min(100, max(0, 100 * ratio))

// Bonus de momentum
savings_this_month = sum(savings_in_current_calendar_month)
savings_last_month = sum(savings_in_previous_calendar_month)
momentum_bonus = 5 if savings_this_month > savings_last_month else 0

ProgresoMeta = min(100, base_score + momentum_bonus)
```

### Edge cases

| Situación | Comportamiento |
|-----------|----------------|
| No hay transacciones tipo 'saving' | `actual_monthly = 0` → score = 0 |
| `meses_restantes` ≤ 0 | Aplicar lógica de meta vencida arriba |
| Meta declarada hace < 30 días | Usar período disponible para `monthly_avg`, no forzar 3 meses |
| `total_saved` > `T` | Score = 100 (meta superada) |

---

## Componente 2 — ControlFugas (peso 25%)

Mide si las "Fugas de Poder" (gastos impulsivos / innecesarios identificados por el Consigliere) se están reduciendo.

### Definición de "fuga"

Una transacción es fuga si: `transactions.is_leak = true` (campo seteado por el Consigliere durante categorización LLM).

### Inputs

- `baseline_leak` = suma de fugas en el **primer mes calendario completo** del usuario en la plataforma
- `current_leak` = suma de fugas en los **últimos 30 días**
- `monthly_income` = promedio ingresos mensuales últimos 3 meses (para edge case)

### Pseudocódigo

```
if baseline_leak == 0 AND current_leak == 0:
    ControlFugas = 100  // sin fugas, nada que controlar
    return

if baseline_leak == 0 AND current_leak > 0:
    // aparecieron fugas que antes no había
    leak_as_pct_income = current_leak / max(1, monthly_income)
    ControlFugas = max(0, 60 - 100 * leak_as_pct_income)
    return

if current_leak == 0 AND baseline_leak > 0:
    ControlFugas = 100  // eliminación total
    return

reduction_pct = (baseline_leak - current_leak) / baseline_leak

if reduction_pct >= 0:
    // mejorando: 50 base + hasta 50 por reducción total
    ControlFugas = min(100, 50 + 50 * reduction_pct)
else:
    // empeorando: 50 base menos penalización
    increase_pct = (current_leak - baseline_leak) / baseline_leak
    ControlFugas = max(0, 50 - 50 * min(1, increase_pct))
```

### Edge cases

| Situación | Comportamiento |
|-----------|----------------|
| Usuario con < 30 días en plataforma | `ControlFugas = 50` (sin baseline aún, neutralidad) |
| < 5 transacciones evaluadas | Marcar `confidence: 'low'` en metadata |
| Categorización LLM no ejecutada aún | `ControlFugas = 50` con flag `pending_categorization` |

---

## Componente 3 — EstabilidadBase (peso 20%)

Mide la salud estructural: ingresos cubren gastos + reserva de emergencia adecuada.

### Inputs

- `I` = promedio ingresos mensuales últimos 3 meses
- `E` = promedio gastos fijos + esenciales mensuales últimos 3 meses (categorías: alquiler, hipoteca, energía, agua, telecom, supermercado básico, transporte esencial, seguros, educación)
- `R` = monto actual marcado como "Reserva de Soberanía" (transacciones con `category = 'emergency_fund'` o `saving_destination = 'reserve'`)

### Pseudocódigo

```
if E <= 0:
    // sin gastos registrados — no se puede calcular
    EstabilidadBase = 0
    flag = 'insufficient_data'
    return

cobertura_gastos = min(1.0, I / E)
meses_reserva = R / E
cobertura_reserva = min(1.0, meses_reserva / 6.0)

EstabilidadBase = 50 * cobertura_gastos + 50 * cobertura_reserva
```

### Umbrales de referencia

| Métrica | Umbral target | Justificación |
|---------|---------------|---------------|
| `meses_reserva` | 6 meses | Estándar planificación financiera personal anglosajona/europea |
| `I / E` | ≥ 1.0 | Por debajo = endeudamiento progresivo |

### Edge cases

| Situación | Comportamiento |
|-----------|----------------|
| `E = 0` | score = 0 con flag `insufficient_data` |
| `I < E` (gasta más que gana) | `cobertura_gastos < 1` → componente 1 penalizado |
| `R` no marcado por usuario | Asumir `R = 0`; Consigliere debe sugerir designar reserva |
| `I` o `E` con outliers (un mes con bonus, un mes con gasto excepcional) | Usar mediana en lugar de promedio si CV (coef. variación) > 0.5 |

---

## Componente 4 — VelocidadAhorro (peso 15%)

Mide la tasa de ahorro mensual del usuario.

### Inputs

- `monthly_savings` = promedio ahorro mensual últimos 3 meses
- `monthly_income` = promedio ingresos mensuales últimos 3 meses
- `tasa_objetivo` = 0.20 (20% como objetivo default; configurable por arquetipo en futuro)

### Pseudocódigo

```
if monthly_income <= 0:
    VelocidadAhorro = 0
    return

tasa_actual = monthly_savings / monthly_income

if tasa_actual < 0:
    // desahorra (gasta de ahorros previos)
    VelocidadAhorro = 0
    return

base_score = min(100, 100 * (tasa_actual / tasa_objetivo))

// Bonus por crecimiento trimestral
tasa_quarter_actual = sum(savings_quarter_actual) / max(1, sum(income_quarter_actual))
tasa_quarter_anterior = sum(savings_quarter_anterior) / max(1, sum(income_quarter_anterior))

growth_bonus = 10 if tasa_quarter_actual > tasa_quarter_anterior else 0

VelocidadAhorro = min(100, base_score + growth_bonus)
```

### Edge cases

| Situación | Comportamiento |
|-----------|----------------|
| `monthly_savings < 0` | score = 0 |
| Menos de 3 meses datos | Usar período disponible |
| Sin trimestre anterior comparable | `growth_bonus = 0` |

---

# ICA — Índice de Conocimiento del Asistido

## Fórmula maestra

```
ICA = 0.25 × PerfilCompleto
    + 0.25 × ProfundidadHistorica
    + 0.20 × DiversidadFuentes
    + 0.15 × Consistencia
    + 0.15 × Engagement
```

## Niveles narrativos

| Rango | Mensaje del Consigliere |
|-------|-------------------------|
| 0–30 | "Te conozco poco — necesito más información para asesorarte bien." |
| 31–60 | "Empiezo a entenderte." |
| 61–85 | "Tengo un perfil sólido tuyo." |
| 86–100 | "Te conozco como un asesor de toda la vida." |

A diferencia del IDF, el ICA **siempre se puede calcular** (incluso para usuario nuevo recién registrado).

---

## Componente 1 — PerfilCompleto (peso 25%)

Cuántos campos clave del perfil están completos.

### Campos evaluados (8 totales)

1. País (`profiles.country`)
2. Rango de edad (`profiles.age_range`)
3. Situación laboral (`profiles.employment_status`: asalariado / autónomo / desempleado / jubilado / estudiante)
4. Perfil fiscal (`fiscal_profiles.regime`: NHR PT, residente PT estándar, residente ES estándar, etc.)
5. Ingreso mensual declarado (`profiles.declared_income_net`)
6. Meta principal declarada (`goals` con al menos 1 row con `status = 'active'`)
7. Plazo de meta declarado (`goals.target_date` no null)
8. Reserva de emergencia identificada (`profiles.emergency_reserve_amount` no null, aunque sea 0)

### Pseudocódigo

```
campos_llenos = count(campos_no_null AND campos_no_vacios) de los 8
PerfilCompleto = 100 * (campos_llenos / 8)
```

---

## Componente 2 — ProfundidadHistorica (peso 25%)

Cuántos meses de datos transaccionales tiene el sistema.

### Inputs

- `meses_con_datos` = número de meses calendario únicos con al menos 5 transacciones registradas para el usuario

### Pseudocódigo

```
ProfundidadHistorica = min(100, 100 * (meses_con_datos / 12))
```

**Umbral**: 12 meses como target (cubre estacionalidad anual completa, captura subsidios PT en junio y noviembre).

---

## Componente 3 — DiversidadFuentes (peso 20%)

Cuántas fuentes diferentes alimentan el perfil.

### Fuentes evaluadas (4 totales)

1. Entrada manual via formulario (`transactions.source = 'manual'`)
2. Upload de CSV / PDF (`transactions.source = 'upload'`)
3. Email forwarding de recibos (`transactions.source = 'email'`) — futuro
4. OAuth banking PSD2 (`transactions.source = 'oauth_psd2'`) — futuro post Open Banking

### Pseudocódigo

```
fuentes_activas = count(distinct sources con al menos 1 transacción en últimos 90 días)
DiversidadFuentes = min(100, 25 * fuentes_activas)
```

**Nota MVP**: hoy solo (1) y (2) están disponibles. Máximo práctico actual = 50. Al implementar (3) y (4) el máximo sube a 100 sin cambiar fórmula.

---

## Componente 4 — Consistencia (peso 15%)

Cuánto el comportamiento del usuario coincide con su perfil declarado (presupuestos vs gasto real).

### Inputs

- Para cada categoría con presupuesto declarado en `budgets`: varianza entre presupuesto y gasto real promedio últimos 3 meses
- `n` = número de categorías con presupuesto

### Pseudocódigo

```
if n == 0:
    Consistencia = 50  // sin baseline, asume promedio
    return

sum_varianza_normalizada = 0
para cada categoría c:
    gasto_real_c = avg(spending in category c, last 3 months)
    presupuesto_c = budget declarado para c
    if presupuesto_c > 0:
        varianza_c = abs(gasto_real_c - presupuesto_c) / presupuesto_c
        varianza_c_capped = min(1.0, varianza_c)
        sum_varianza_normalizada += varianza_c_capped

varianza_promedio = sum_varianza_normalizada / n
Consistencia = 100 * (1 - varianza_promedio)
```

### Interpretación

- Usuario dice "gasto 200€ en restaurantes" y gasta exactamente 200€ → varianza = 0 → Consistencia = 100
- Usuario dice "200€" y gasta 300€ → varianza = 0.5 → score componente = 50
- Usuario dice "200€" y gasta 400€ → varianza = 1.0 (capped) → score componente = 0

---

## Componente 5 — Engagement (peso 15%)

Qué tan activo es el usuario con el Consigliere.

### Inputs

- `queries_por_semana` = promedio queries al chat del Consigliere últimas 4 semanas
- `queries_objetivo` = 3 por semana (configurable)

### Pseudocódigo

```
Engagement = min(100, 100 * (queries_por_semana / queries_objetivo))
```

---

# Notas de implementación

## Recalculación

| Índice | Frecuencia | Trigger |
|--------|------------|---------|
| IDF | On-demand con cache 5 min | Insert transacción, update goal, abrir dashboard |
| ICA | Diaria batch O cuando cambian datos perfil | Update profile, nueva fuente activada, milestone semanal |

## Almacenamiento

- Tabla `idf_history`: `id, user_id, score, level, components_json, computed_at`
- Tabla `ica_history`: `id, user_id, score, components_json, computed_at`
- Permite mostrar evolución temporal en UI y triggers del Consigliere ("Tu IDF subió 8 puntos esta semana").

## Versionado

Este documento es versión **1.0** (mayo 2026).

Cambios futuros que requieren bump de versión:
- Modificar pesos de la fórmula maestra
- Añadir o remover componentes
- Cambiar umbral de un nivel
- Cambiar fórmula de cualquier componente

Cambios que NO requieren bump:
- Aclaración de redacción
- Añadir ejemplo
- Documentar edge case que ya estaba implícito

---

# Validación rápida — perfiles de referencia

Para que Ag06 valide su implementación, estos son los perfiles esperados:

## Perfil A — "Usuario ideal"
- Meta: comprar piso €40,000 en 24 meses, declarada hace 6 meses
- Ahorrado: €12,000 en 6 meses (€2,000/mes)
- Required monthly futuro: (40000-12000)/18 = €1,555/mes
- Actual monthly: €2,000/mes
- Fugas: 0 baseline, 0 actual
- Ingreso: €3,500, Gastos: €1,500, Reserva: €9,000 (6 meses)
- Tasa ahorro: 57%
- IDF esperado: ~95 → Diamante

## Perfil B — "Usuario inicial"
- Meta: comprar piso €40,000 en 24 meses, declarada hace 1 mes
- Ahorrado: €500 en 1 mes
- Required monthly: (40000-500)/23 = €1,717/mes
- Actual monthly: €500/mes
- Fugas: usuario < 30 días → ControlFugas = 50
- Ingreso: €2,000, Gastos: €1,500, Reserva: €0
- Tasa ahorro: 25%
- IDF esperado: ~35 → Plata

## Perfil C — "Usuario en problemas"
- Meta: salir de deudas €15,000 en 36 meses, declarada hace 12 meses
- Pagado: €2,000 en 12 meses
- Required monthly: (15000-2000)/24 = €542/mes
- Actual monthly: €167/mes
- Fugas: €300/mes baseline, €350/mes actual (empeorando)
- Ingreso: €1,200, Gastos: €1,150, Reserva: €0
- Tasa ahorro: 14%
- IDF esperado: ~18 → Bronce
