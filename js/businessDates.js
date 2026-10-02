// businessDates.js
// Reglas de negocio para la "fecha compromiso" de despacho y para medir atrasos.
//
// REGLA VIGENTE ('corridas'): la fecha compromiso es la creación + 48 horas de
// reloj (incluye noches y fines de semana, sin corte de las 15:00) y los
// atrasos se miden en horas de reloj.
//
// REGLA EN STANDBY ('habiles'), por si gerencia vuelve a pedirla: 48 horas
// HÁBILES.
// - Día hábil: lunes a viernes (sin feriados por ahora).
// - Ventana laboral: 09:00 a 18:00 (9 horas/día).
// - Corte de recepción: 15:00. Si la NV se crea antes de las 15:00 en un día
//   hábil, el conteo de 48 horas hábiles arranca desde ese instante (o desde
//   las 09:00 si se creó antes de la apertura). Si se crea a las 15:00 o
//   después, o en un día no hábil, el conteo arranca al día hábil siguiente
//   a las 09:00.
// Para volver a ella basta cambiar HOURS_RULE a 'habiles': la fecha compromiso,
// los atrasos y los rótulos de "horas" de las pantallas cambian juntos.

export const HOURS_RULE = 'corridas'; // 'corridas' | 'habiles'

export const WORK_START = 9;
export const WORK_END = 18;
export const CUTOFF_HOUR = 15;
export const COMMITMENT_HOURS = 48;

/** Horas que equivalen a "un día" y rótulo de la unidad, según la regla vigente. */
export const HOURS_PER_DAY = HOURS_RULE === 'habiles' ? WORK_END - WORK_START : 24;
export const HOURS_LABEL = HOURS_RULE === 'habiles' ? 'hábiles' : 'corridas';

// La planilla tiene NV desde 2022: una fecha de coordinación anterior a 2020
// es un error de digitación (ej. un "9" suelto que Excel guarda como
// 09-01-1900), no una fecha real.
export const FECHA_MINIMA_COORDINACION = new Date(2020, 0, 1);

/** Devuelve la fecha de coordinación si es válida, o null si está vacía o es un valor imposible. */
export function coordinacionValida(fecha) {
  return fecha && !isNaN(fecha.getTime()) && fecha >= FECHA_MINIMA_COORDINACION ? fecha : null;
}

export function isBusinessDay(date) {
  const day = date.getDay(); // 0 = domingo, 6 = sábado
  return day !== 0 && day !== 6;
}

/** Devuelve la fecha del siguiente día hábil a las `workStart` horas. */
export function nextBusinessDayStart(fromDate, workStart = WORK_START) {
  const d = new Date(fromDate);
  d.setDate(d.getDate() + 1);
  d.setHours(workStart, 0, 0, 0);
  while (!isBusinessDay(d)) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

/** Horas transcurridas entre `from` y `to` según la regla vigente (HOURS_RULE). */
export function hoursElapsed(from, to) {
  if (HOURS_RULE === 'habiles') return businessHoursElapsed(from, to);
  if (!from || !to || to <= from) return 0;
  return (to - from) / 3600000;
}

/**
 * EN STANDBY (regla 'habiles'). Horas hábiles transcurridas entre `from` y
 * `to` (horario 09:00-18:00, lunes a viernes). A diferencia de una simple
 * resta de fechas, no cuenta noches ni fines de semana como "atraso".
 */
export function businessHoursElapsed(from, to, workStart = WORK_START, workEnd = WORK_END) {
  if (!from || !to || to <= from) return 0;
  let total = 0;
  const cursor = new Date(from);

  while (cursor < to) {
    if (isBusinessDay(cursor)) {
      const dayStart = new Date(cursor);
      dayStart.setHours(workStart, 0, 0, 0);
      const dayEnd = new Date(cursor);
      dayEnd.setHours(workEnd, 0, 0, 0);
      const segStart = cursor > dayStart ? cursor : dayStart;
      const segEnd = to < dayEnd ? to : dayEnd;
      if (segEnd > segStart) total += (segEnd - segStart) / 3600000;
    }
    cursor.setDate(cursor.getDate() + 1);
    cursor.setHours(0, 0, 0, 0);
  }

  return total;
}

/**
 * Fecha/hora compromiso a partir de la fecha/hora de creación, según la regla
 * vigente (HOURS_RULE): 48 horas corridas, o la regla hábil en standby.
 * @param {Date} creation Fecha y hora de creación de la NV.
 * @returns {Date|null}
 */
export function computeCommitmentDate(creation, opts = {}) {
  return HOURS_RULE === 'habiles' ? computeCommitmentDateHabiles(creation, opts) : computeCommitmentDateCorridas(creation, opts);
}

/** Regla vigente: creación + 48 horas de reloj (noches y fines de semana cuentan). */
export function computeCommitmentDateCorridas(creation, opts = {}) {
  if (!creation || isNaN(creation.getTime())) return null;
  return new Date(creation.getTime() + (opts.hoursNeeded ?? COMMITMENT_HOURS) * 3600000);
}

/**
 * EN STANDBY (regla 'habiles'): 48 horas hábiles con corte de recepción.
 * @param {Date} creation Fecha y hora de creación de la NV.
 * @param {object} opts Parámetros opcionales (workStart, workEnd, cutoffHour, hoursNeeded).
 * @returns {Date|null}
 */
export function computeCommitmentDateHabiles(creation, opts = {}) {
  const workStart = opts.workStart ?? WORK_START;
  const workEnd = opts.workEnd ?? WORK_END;
  const cutoffHour = opts.cutoffHour ?? CUTOFF_HOUR;
  const hoursNeeded = opts.hoursNeeded ?? COMMITMENT_HOURS;

  if (!creation || isNaN(creation.getTime())) return null;

  const creationHourDecimal = creation.getHours() + creation.getMinutes() / 60;
  let cursor;

  if (!isBusinessDay(creation) || creationHourDecimal >= cutoffHour) {
    // Entra fuera de horario de corte (o en día no hábil): arranca al
    // siguiente día hábil a la apertura.
    cursor = nextBusinessDayStart(creation, workStart);
  } else {
    cursor = new Date(creation);
    if (creationHourDecimal < workStart) {
      // Se creó antes de abrir: arranca a la apertura del mismo día.
      cursor.setHours(workStart, 0, 0, 0);
    }
  }

  let remaining = hoursNeeded;
  // Tope de seguridad para evitar loops infinitos ante datos corruptos.
  let guard = 0;

  while (remaining > 1e-6 && guard < 1000) {
    guard++;
    const dayEnd = new Date(cursor);
    dayEnd.setHours(workEnd, 0, 0, 0);
    const availableHoursToday = (dayEnd.getTime() - cursor.getTime()) / 3600000;

    if (availableHoursToday <= 0) {
      cursor = nextBusinessDayStart(cursor, workStart);
      continue;
    }

    if (remaining <= availableHoursToday) {
      cursor = new Date(cursor.getTime() + remaining * 3600000);
      remaining = 0;
    } else {
      remaining -= availableHoursToday;
      cursor = nextBusinessDayStart(cursor, workStart);
    }
  }

  return cursor;
}

/** true si `date` cae dentro del rango [start, end] (inclusive), por día calendario. */
export function isWithinDay(date, refDate) {
  if (!date || !refDate) return false;
  return (
    date.getFullYear() === refDate.getFullYear() &&
    date.getMonth() === refDate.getMonth() &&
    date.getDate() === refDate.getDate()
  );
}

/** Devuelve el lunes (00:00) de la semana calendario de `date`. */
export function startOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0 = domingo
  const diff = day === 0 ? -6 : 1 - day; // retrocede hasta el lunes
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function endOfWeek(date) {
  const start = startOfWeek(date);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return end;
}

/** Número de semana ISO 8601 (1–53): semanas de lunes a domingo, la semana 1
 * es la que contiene el primer jueves del año. */
export function isoWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7; // lunes=1 ... domingo=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

/** Lista de números de semana ISO que un rango [start, end] toca (uno por
 * cada semana calendario que el rango cruza, sin duplicados). */
export function weekNumbersInRange(start, end) {
  const nums = [];
  let cursor = startOfWeek(start);
  const last = endOfWeek(end);
  while (cursor <= last) {
    nums.push(isoWeekNumber(cursor));
    cursor = new Date(cursor.getTime() + 7 * 86400000);
  }
  return nums;
}

export function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function endOfDay(date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

/** Fecha de ayer (hoy aún no está cerrado, así que no cuenta como "completo"). */
export function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d;
}

/**
 * Rango de los últimos `n` días hábiles, terminando en `endDate` (por
 * defecto ayer). Es una ventana móvil, no una semana de calendario.
 */
export function lastBusinessDaysRange(n, endDate = yesterday()) {
  const cursor = new Date(endDate);
  let count = 0;
  let start = new Date(endDate);
  while (count < n) {
    if (isBusinessDay(cursor)) {
      start = new Date(cursor);
      count++;
    }
    if (count < n) cursor.setDate(cursor.getDate() - 1);
  }
  return { start: startOfDay(start), end: endOfDay(endDate) };
}

/** Rango del mes calendario anterior al de `refDate` (por defecto hoy). Fijo, no navegable. */
export function previousMonthRange(refDate = new Date()) {
  const d = new Date(refDate.getFullYear(), refDate.getMonth() - 1, 1);
  return { start: startOfMonth(d), end: endOfMonth(d) };
}

export function startOfMonth(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function endOfMonth(date) {
  const d = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  d.setHours(23, 59, 59, 999);
  return d;
}
