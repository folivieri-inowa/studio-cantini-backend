// Tariffe bollo per fascia kW (€/kW) — fonte ACI, aggiornato 2024
const TARIFFA_BASE_KW = 2.58; // €/kW fino a 100 kW
const TARIFFA_OLTRE_KW = 3.87; // €/kW oltre 100 kW

const TARIFFE_REGIONALI = {
  'Lombardia': { base: 2.58, oltre: 3.87 },
  'Piemonte':  { base: 2.58, oltre: 3.87 },
  'Toscana':   { base: 2.58, oltre: 3.87 },
};

// Superbollo: 20€/kW per ogni kW oltre 185 kW (D.L. 98/2011)
const SOGLIA_SUPERBOLLO_KW = 185;
const SUPERBOLLO_PER_KW = 20;

export function calculateBollo(kw, region = null) {
  if (!kw || kw <= 0) return { bollo: 0, superbollo: 0 };

  const tariffe = (region && TARIFFE_REGIONALI[region]) || { base: TARIFFA_BASE_KW, oltre: TARIFFA_OLTRE_KW };

  let bollo;
  if (kw <= 100) {
    bollo = kw * tariffe.base;
  } else {
    bollo = (100 * tariffe.base) + ((kw - 100) * tariffe.oltre);
  }

  const superbollo = kw > SOGLIA_SUPERBOLLO_KW
    ? (kw - SOGLIA_SUPERBOLLO_KW) * SUPERBOLLO_PER_KW
    : 0;

  return {
    bollo: Math.round(bollo * 100) / 100,
    superbollo: Math.round(superbollo * 100) / 100,
  };
}
