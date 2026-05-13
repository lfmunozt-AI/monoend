/**
 * @module ica
 * Algoritmo ICA — Índice de Consciencia y Acción Financiera.
 * Escala 0–100: 0-30 Ceguera Financiera · 31-70 Visión Táctica · 71-100 Soberanía Total.
 */

export interface Transaccion {
  id: string;
  tipo: 'ingreso' | 'gasto';
  monto: number;
  categoria: string;
  fecha: string; // ISO 8601
}

export interface Meta {
  id: string;
  nombre: string;
  montoObjetivo: number;
  montoActual: number;
  completada?: boolean;
}

export interface Perfil {
  metas: Meta[];
  extractosSubidos: number;
  proyeccionesGeneradas: number;
  hitosAlcanzados: number;
}

export interface FiscalProfile {
  pais: 'portugal' | 'spain';
  salarioBruto: number;
  tipoEmpleo: string;
}

/** Puntos base por tipo de evento de engagement */
const PUNTOS_EVENTO: Record<string, number> = {
  transaccion_registrada: 5,
  meta_definida: 10,
  extracto_subido: 15,
  proyeccion_generada: 20,
  hito_alcanzado: 25,
};

/** Caps por categoría — limitan el abuso y fuerzan diversificación */
const CAPS = {
  transacciones: 50,  // max 10 tx * 5 pts
  metas: 30,          // max 3 metas * 10 pts
  extractos: 45,      // max 3 extractos * 15 pts
  proyecciones: 40,   // max 2 proyecciones * 20 pts
  hitos: 50,          // max 2 hitos * 25 pts
} as const;

const MAX_PUNTOS =
  CAPS.transacciones + CAPS.metas + CAPS.extractos + CAPS.proyecciones + CAPS.hitos; // 215

/**
 * Devuelve los puntos asociados a un evento de usuario.
 * Retorna 0 para eventos no reconocidos.
 * @param evento - Identificador del evento ('transaccion_registrada', etc.)
 * @returns Puntos del evento
 */
export function calcularPuntosEvento(evento: string): number {
  return PUNTOS_EVENTO[evento] ?? 0;
}

/**
 * Calcula el nivel ICA del usuario a partir de su actividad actual.
 * @param _userId - ID del usuario (reservado para trazabilidad/logging futuro)
 * @param transacciones - Lista de transacciones registradas
 * @param perfil - Perfil con metas y métricas de engagement
 * @param _fiscalProfile - Perfil fiscal (reservado para ajustes futuros por país)
 * @returns Score ICA normalizado 0–100
 */
export function calcularICA(
  _userId: string,
  transacciones: Transaccion[],
  perfil: Perfil,
  _fiscalProfile: FiscalProfile,
): number {
  const pTx = Math.min(
    transacciones.length * PUNTOS_EVENTO.transaccion_registrada,
    CAPS.transacciones,
  );
  const pMetas = Math.min(
    (perfil.metas?.length ?? 0) * PUNTOS_EVENTO.meta_definida,
    CAPS.metas,
  );
  const pExtractos = Math.min(
    (perfil.extractosSubidos ?? 0) * PUNTOS_EVENTO.extracto_subido,
    CAPS.extractos,
  );
  const pProyecciones = Math.min(
    (perfil.proyeccionesGeneradas ?? 0) * PUNTOS_EVENTO.proyeccion_generada,
    CAPS.proyecciones,
  );
  const pHitos = Math.min(
    (perfil.hitosAlcanzados ?? 0) * PUNTOS_EVENTO.hito_alcanzado,
    CAPS.hitos,
  );

  const puntosBrutos = pTx + pMetas + pExtractos + pProyecciones + pHitos;
  const score = Math.round((puntosBrutos / MAX_PUNTOS) * 100);
  return Math.min(Math.max(score, 0), 100);
}

/**
 * Determina el nivel cualitativo del score ICA.
 * @param score - Score ICA 0–100
 * @returns Nivel: 'ceguera' | 'vision' | 'soberania'
 */
export function getICALevel(score: number): 'ceguera' | 'vision' | 'soberania' {
  if (score <= 30) return 'ceguera';
  if (score <= 70) return 'vision';
  return 'soberania';
}

/**
 * Devuelve el color del semáforo ICA para renderizado en UI.
 * @param score - Score ICA 0–100
 * @returns Color hex según nivel (rojo · naranja · dorado)
 */
export function getICAColor(score: number): '#E85C5C' | '#E8A93C' | '#C9A84C' {
  if (score <= 30) return '#E85C5C'; // ceguera
  if (score <= 70) return '#E8A93C'; // visión
  return '#C9A84C';                  // soberanía
}
