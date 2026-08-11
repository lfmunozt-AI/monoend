# Corrección AG08 — 13ª tanda: V16 (doble conteo con palabra intermedia) + V15 (atribución única) + test estructural de atribución

**Fecha:** 11 de agosto de 2026
**Rama:** `agent/08` reseteada a `origin/develop` @ `5af972c` + esta tanda
**Objetivo:** cerrar V16 y V15 por completo — últimos errores matemáticos conocidos antes del go-live del 17 de agosto.

---

## 1 · BLOQUEANTE A — V16: doble conteo con palabra intermedia

### Causa

`GASTO_AGREGADO_DETALLE_RE` exigía que la keyword y la cifra fueran prácticamente **adyacentes** (solo toleraba `:`/`=` y espacios). Con palabras intermedias no matcheaba nada: el agregado no se reclamaba, su rango no se excluía, y el parser de listas se quedaba la cifra como un ítem más — que además se **sumaba** al resto del desglose. Adicionalmente, `gastamos` no estaba en `GASTO_CTX` en ninguna de sus formas.

### Fix

- **`CONECTOR_DECLARATIVO`** (nuevo): enumera **explícitamente** lo que puede ir entre la keyword y la cifra — cópulas (`fueron/son/es/eran/será`), verbos de agregación (`suman/ascienden a/alcanzan/rondan`), marcadores de periodo (`al mes/mensuales/por mes`) y de aproximación (`aproximadamente/más o menos/unos/cerca de`), en ES/PT/EN. Se aplica en las **dos** posiciones (antes y después de la cifra) y el rango consumido se registra **completo**.
  - **Deliberadamente NO es un comodín `.{0,N}`**: un comodín se tragaría un nombre de partida real (`"gastos: internet 300…"` leería 300 como agregado) y rompería V13/V15. Cada alternativa es una palabra funcional que jamás es el nombre de una partida.
- **`GASTO_CTX`** ampliado con `gastamos|gastaron|gastabamos|spent`.
- **Guarda V16 — segunda mitad (verificación de suma)**: si la suma del desglose excede el agregado declarado (más allá de la tolerancia de redondeo), se loguea. **Solo detecta, no corrige**: quién gana entre agregado y desglose es competencia de `reconciliarGastos` (§6, materialidad + CONFLICT), que ya recibe ambos valores intactos y decide con reglas explícitas. Corregir aquí sería elegir en silencio — justo lo que §0 prohíbe. Verificado que dispara en el caso legítimo (`gasto 2200: 1200 arriendo 1050 comida` → suma 2250 > 2200, exceso 50) y que la reconciliación lo convierte en CONFLICT, no en un valor silencioso.

### Salida literal — los 3 mensajes del bloqueante A

```
mis gastos fueron 1200: internet 300, agua 400, gas 500
  gastos_mensuales: 1200 | items: 3 | status: COMPLETE
  items: ["internet=300","agua=400","gas=500"]
  merged: gastos=1200  conflict=undefined      ← antes: 2400, 4 ítems ("fueron"=1200)

gastamos 950 al mes: mercado 500, gasolina 250, farmacia 200
  gastos_mensuales: 950 | items: 3 | status: COMPLETE
  items: ["mercado=500","gasolina=250","farmacia=200"]
  merged: gastos=950   conflict=undefined      ← antes: 1900, 4 ítems ("gastamos"=950)

gasté 1800: renta 900, comida 500, luz 400          (regresión tanda 2)
  gastos_mensuales: 1800 | items: 3 | status: COMPLETE
  items: ["renta=900","comida=500","luz=400"]
  merged: gastos=1800  conflict=undefined
```

Más 4 formas propias, no presentes en ningún test anterior, en los tres idiomas: `"mis gastos mensuales son 800: …"` → 800/3 ítems · `"gastos aproximadamente 600: …"` → 600/3 ítems · `"as despesas foram 900: …"` (PT) → 900/3 ítems · `"my expenses were 700: …"` (EN) → 700/3 ítems.

---

## 2 · BLOQUEANTE B — V15: atribución correcta

### Hallazgo de medición (declarado, no silenciado)

De los tres casos del encargo, **dos ya pasaban** en `develop` — los arreglaron las tandas 1 y 2, y así lo verifiqué antes de tocar nada:

- `'gasto 1500 en total: casa 700, comida 300'` → ya daba `casa=700`, `comida=300`, agregado 1500. El encargo lo describía como "casa=1500 y el 700 huérfano"; eso ya no ocurría.
- `'gano 2300 y quiero una casa'` → `meta` ya era `undefined` (el 2300 nunca se cruzaba).

**El que sí fallaba** era el cuarto: `'sueldo 3000, quiero un piso de 200000'` → `meta: undefined`, con el 200000 quedando **huérfano**. Causa: `META_CTX` cubría `"quiero COMPRAR/LLEGAR/AHORRAR"` pero no `"quiero + OBJETO"` directo; y el bloque de crédito tampoco lo recogía porque exige monto **y** plazo (aquí no hay plazo). Es exactamente la diferencia entre V14 y V15: la conservación garantizaba que el número no desapareciera, no que llegara a su campo correcto.

### Fix

`META_CTX` ampliado con `quiero(?:mos)?\s+(?:un|una|el|la|unos|unas)?\s*(?:casa|piso|apartamento|vivienda|carro|coche|auto|vehiculo|moto)`. La exclusión por rango (`rangosParaMeta`) ya vigente sigue impidiendo que un número reclamado por `gano/sueldo/ingreso` se convierta en el monto de la meta.

### Salida literal — los 4 casos del bloqueante B

```
gasto 1500 en total: casa 700, comida 300
  gastos_mensuales: 1500 | items: ["casa=700","comida=300"] | status: AMBIGUOUS
  merged: gastos=undefined   ← 1000 vs 1500 = 33% > 5% → reinicio de captura (§6, materialidad aprobada)

gasto 1500 en total: casa 700, comida 300, luz 500
  gastos_mensuales: 1500 | items: ["casa=700","comida=300","luz=500"] | status: COMPLETE
  merged: gastos=1500  conflict=undefined     ← suma exacta 1500 → CONSISTENT ✅

gano 2300 y quiero una casa
  ingreso: 2300 | meta: undefined             ← el 2300 NUNCA es el monto de la meta ✅

sueldo 3000, quiero un piso de 200000
  ingreso: 3000 | meta: {"monto":200000}      ← antes: meta undefined, 200000 huérfano ✅
```

### Efecto colateral verificado (no es regresión)

Al ampliar `META_CTX`, mensajes con contexto de crédito **y** "quiero un OBJETO" ahora pueblan `credito` y `meta` con el mismo monto/plazo. Verifiqué que ese solapamiento **es pre-existente y por diseño**, no algo que introduje: con la keyword `"meta"`/`"objetivo"` ya soportada antes de esta tanda, `"mi meta es una casa de 200000 a 240 meses"` ya poblaba ambos igual. `rangosParaMeta` excluye deliberadamente el rango del crédito por esta razón ("la meta ES el crédito", documentado en tanda 1), y `mergeScenario` ya deriva meta↔crédito (BUG 3). El test estructural trata ese alias como **un solo destino**, no como doble conteo.

---

## 3 · INVARIANTE DE CIERRE — test estructural de atribución única

`INVARIANTE DE CIERRE (V14+V15+V16)` recorre un corpus de **22 mensajes** de las tandas 1, 2 y 3, con **dos armas**:

**Arma 1 — atribución única:** para cada cifra del mensaje, cuenta cuántos destinos la reclaman (campo, ítem, o huérfano). Debe ser exactamente uno: ni cero (V14, desapareció) ni dos (V16, se contó dos veces). El alias legítimo `credito.monto` ↔ `meta.monto` cuenta como un destino.

**Arma 2 — ninguna palabra funcional como nombre de ítem.** Y esto importa declararlo con precisión:

> **El arma 1, por sí sola, NO habría cazado el bloqueante A de esta tanda.** Lo verifiqué explícitamente contra el delta buggy de `develop`: con `items = [fueron=1200, internet=300, agua=400, gas=500]`, cada cifra tenía **exactamente un destino** — la cuenta cuadraba perfectamente — y aun así el total salía duplicado, porque el destino era el *equivocado*. Un test de atribución única que solo cuente destinos daría luz verde a ese bug.

Por eso el arma 2 comprueba que ningún ítem lleve por nombre una palabra funcional del patrón declarativo (`gasto/gastos/gasté/gastamos/fueron/son/al/mes/total/aproximadamente…`), que es la firma exacta de esa clase. Verificado por mutación: caza `"fueron"=1200`, `"gastamos"=950` y `"gasté"=1800`, sin falsos positivos sobre nombres legítimos (`internet`, `casa`, `Diezmo_Vital`, `en arriendo`).

### Resultado del test de atribución única (los 22 mensajes, corpus completo)

```
✅ gano 2000 y gasto en arriendo 800, comida 300, luz 100
✅ gano 1500, quiero una casa de 200000 a 240 meses, casa 700, comida 300, luz 90
✅ gano 1500, quiero financiar una casa de 200000 a 240 meses, casa 700, comida 300, luz 90
✅ gano 700 y pago arriendo 650, comida 200, luz 50
✅ mi sueldo es 2500 y el arriendo 800, comida 300, luz 90
✅ gasto 2 500 €
✅ gano 2300 y gasto aproximadamente 2000 entre vivienda, comida, servicios, ocio
✅ gasto 2200: 1200 arriendo 1050 comida
✅ Gano 2636 euros al mes y mis gastos son 2200.
✅ Mis gastos: arriendo 1200, comida 1050
✅ gasté 1800: renta 900, comida 500, luz 400
✅ gasto 1500 en total: casa 700, comida 300
✅ gano 2300 y quiero una casa
✅ el banco me ofrece un 9%
✅ mis gastos fueron 1200: internet 300, agua 400, gas 500
✅ gastamos 950 al mes: mercado 500, gasolina 250, farmacia 200
✅ mis gastos mensuales son 800: luz 200, agua 250, internet 350
✅ gastos aproximadamente 600: transporte 200, ocio 150, ropa 250
✅ as despesas foram 900: renda 400, comida 300, luz 200
✅ my expenses were 700: rent 400, food 200, power 100
✅ gasto 1500 en total: casa 700, comida 300, luz 500
✅ sueldo 3000, quiero un piso de 200000
```

---

## 4 · Declaración de impacto

| Función / constante | Archivo | Qué cambió | Por qué |
|---|---|---|---|
| `CONECTOR_DECLARATIVO` (nueva) | `scenario.ts` | — | Ventana de captura del agregado con palabras intermedias (V16-A) |
| `GASTO_AGREGADO_DETALLE_RE` | `scenario.ts` | De literal a `new RegExp` compuesto con el conector en ambas posiciones; +`gastamos/gastaron/gastabamos/spent` | V16-A |
| `GASTO_CTX` | `scenario.ts` | +`gastamos/gastaron/gastabamos/spent` | V16-A (formas de plural sin cobertura) |
| `META_CTX` | `scenario.ts` | +`quiero(mos) [un/una/…] OBJETO` | V15-B (`sueldo 3000, quiero un piso de 200000`) |
| `aplicarGuardaV16` | `scenario.ts` | +verificación de suma (detecta y loguea; no corrige) | Defensa en profundidad V16 |
| 12 tests nuevos | `scenario.test.ts` | 7 de V16-A, 4 de V15-B, 1 estructural de cierre | Cobertura permanente |

**Eliminadas:** ninguna. **Tests reescritos para afirmar lo contrario (V11):** ninguno — los 153 tests previos siguen intactos y verdes.

---

## 5 · Validación

```
npx tsc --noEmit         → limpio
npm test                 → 14/14 OK
npm run test:guardrail   → 262/262 OK
npm run test:calculator  → 252/252 OK   [15+33+24+165+15 — 165 = 153 previos + 12 nuevos]
npm run test:regression  → 84/84 turnos OK · 47 escenarios
npm run build             → TypeScript compila; falla en el prerender de una página de auth
                             (/register en esta corrida, /login en las anteriores — mismo fallo,
                             credenciales Supabase ausentes en el sandbox; el worker elige la
                             página según el orden de paralelismo). Preexistente, no es regresión.
npm run test:e2e          → SKIPPED (sin credenciales)
npm run smoke:db          → SKIPPED (sin credenciales)
```

## 6 · Confirmación de invariantes

**G1c — pasa en AMBOS sentidos** (ejecutado contra el código de esta tanda):

```
sentido 1 (agregado→detalle): {"agregado":2200,"detalle":2250,"diff":50,"diffPct":2.272727272727273}
sentido 2 (detalle→agregado): {"agregado":2200,"detalle":2250,"diff":50,"diffPct":2.272727272727273}
IDÉNTICOS: true
```

**Materialidad — las tres fronteras siguen exactas:**

```
diff 0.5 €      → CONSISTENT
diff 1 € exacto → CONSISTENT     (frontera inferior intacta)
diff 1.5 €      → CONFLICT
diff 5% exacto  → CONFLICT       (elegible, frontera superior intacta)
diff 5.045%     → REINICIO       (>5%, fallo de comprensión)
```

**V13** (fronteras posicionales por rango): intactas — `rangosReclamados`/`rangosParaMeta` sin cambios estructurales; los patrones nuevos registran su rango completo por el mismo mecanismo. **V14** (conservación): verificada en los 22 mensajes del corpus (arma 1, cero destinos = fallo). **V16** (ningún número dos veces): verificada por las dos armas. **V2/V3/V4/V6/V7** (ciclo de conflicto): sin cambios en `reconciliarGastos`. **Tandas 1 y 2**: 153 tests previos verdes, incluidos los obligatorios V13-1..6, V14-1..7, los casos 1-8 del contrato y testdev7.

## 7 · Estado de la rama

Pendiente de commit y push tras este informe. La rama se reseteó a `origin/develop` (@ `5af972c`), que ya incluye las tandas 1, 2 y sus dos correcciones.
