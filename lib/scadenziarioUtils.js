// backend/lib/scadenziarioUtils.js

/**
 * Calcola la data di scadenza da data fattura + condizione di pagamento.
 * @param {Date|string} invoiceDate
 * @param {Object} paymentTerms - { type, days, end_of_month }
 * @returns {Date}
 */
export function calculateDueDate(invoiceDate, paymentTerms) {
  const base = new Date(invoiceDate);
  if (!paymentTerms || paymentTerms.type === 'immediato') return base;

  const result = new Date(base);
  result.setDate(result.getDate() + (paymentTerms.days || 0));

  if (paymentTerms.end_of_month) {
    // Porta all'ultimo giorno del mese risultante
    result.setMonth(result.getMonth() + 1, 0);
  }

  return result;
}

/**
 * Genera le date delle rate di un piano.
 * @param {Date|string} startDate - Data prima rata
 * @param {number} installments - Numero di rate
 * @param {string} frequency - 'mensile'|'bimestrale'|'trimestrale'|'semestrale'|'annuale'
 * @returns {Date[]}
 */
export function generateInstallmentDates(startDate, installments, frequency) {
  const monthsMap = {
    mensile: 1,
    bimestrale: 2,
    trimestrale: 3,
    semestrale: 6,
    annuale: 12,
  };
  const step = monthsMap[frequency] || 1;
  const dates = [];
  const base = new Date(startDate);

  for (let i = 0; i < installments; i++) {
    const d = new Date(base);
    d.setMonth(d.getMonth() + i * step);
    dates.push(d);
  }

  return dates;
}

/**
 * Calcola lo stato di una scadenza.
 * @param {Date|string} dueDate
 * @param {Date|string|null} paymentDate
 * @param {number} alertDays
 * @returns {'completed'|'overdue'|'upcoming'|'future'}
 */
export function calculateStatus(dueDate, paymentDate, alertDays = 15) {
  if (paymentDate) return 'completed';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate);
  due.setHours(0, 0, 0, 0);
  const diffDays = Math.ceil((due - today) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return 'overdue';
  if (diffDays <= alertDays) return 'upcoming';
  return 'future';
}
