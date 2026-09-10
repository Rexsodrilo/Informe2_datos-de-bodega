// businessDates.js
// Reglas de negocio para "fecha compromiso" de despacho.
//
// - Día hábil: lunes a viernes (sin feriados por ahora).
// - Ventana laboral: 09:00 a 18:00 (9 horas/día).
// - Corte de recepción: 15:00. Si la NV se crea antes de las 15:00 en un día
//   hábil, el conteo de 48 horas hábiles arranca desde ese instante (o desde
//   las 09:00 si se creó antes de la apertura). Si se crea a las 15:00 o
//   después, o en un día no hábil, el conteo arranca al día hábil siguiente
//   a las 09:00.

export const WORK_START = 9;
export const WORK_END = 18;
export const CUTOFF_HOUR = 15;
export const COMMITMENT_HOURS = 48;

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

/**
 * Calcula la fecha/hora compromiso a partir de la fecha/hora de creación.
 * @param {Date} creation Fecha y hora de creación de la NV.
 * @param {object} opts Parámetros opcionales (workStart, workEnd, cutoffHour, hoursNeeded).
 * @returns {Date|null}
 */
export function computeCommitmentDate(creation, opts = {}) {
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
