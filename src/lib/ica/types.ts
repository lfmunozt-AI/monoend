/**
 * @module ica/types
 * Tipos públicos del motor ICA — Índice de Consciencia y Acción
 * (post-pivot: "Lo que sé de ti").
 *
 * Fuente canónica de fórmulas: `FORMULAS_IDF_ICA.md` (pendiente en disco).
 * Mientras tanto, este módulo es la referencia.
 *
 * Escala 0–100 ponderada en 5 dimensiones:
 *   · perfilCompleto       20%  (datos identitarios y fiscales declarados)
 *   · profundidadHistorica 25%  (meses de transacciones acumulados)
 *   · diversidadFuentes    20%  (categorías y tipos de tx distintos)
 *   · consistencia         15%  (regularidad temporal de la actividad)
 *   · engagement           20%  (sesiones con el Consigliere)
 *
 * Niveles narrativos (string libre, sin enum estricto):
 *   0–20  "Apenas comenzando"
 *   21–40 "Construyendo visión"
 *   41–60 "Dominio en formación"
 *   61–80 "Visión clara"
 *   81–100 "Dominio total"
 */

/**
 * Cada componente es un score 0–100 (no ponderado). El peso se aplica al
 * combinar en el score final. Ver §ICA-Ponderación en FORMULAS_IDF_ICA.md.
 */
export interface ICAComponents {
  perfilCompleto: number;
  profundidadHistorica: number;
  diversidadFuentes: number;
  consistencia: number;
  engagement: number;
}

/**
 * Resultado de un cálculo ICA.
 *
 * @property score          0–100 ponderado y redondeado.
 * @property narrativeLevel Etiqueta narrativa (no enum). Ver §ICA-Niveles.
 * @property components     Desglose 0–100 por dimensión.
 * @property computedAt     ISO 8601 UTC del cálculo.
 */
export interface ICAResult {
  score: number;
  narrativeLevel: string;
  components: ICAComponents;
  computedAt: string;
}
