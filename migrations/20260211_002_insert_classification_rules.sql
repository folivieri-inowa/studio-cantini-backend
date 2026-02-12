-- Migration: Inserimento regole di classificazione automatica
-- Data: 2026-02-11
-- Descrizione: Regole deterministiche per pattern comuni identificati

-- ==========================================
-- REGOLE PER DB1
-- ==========================================

-- Regola 1: Commissioni bancarie (piccole, alta confidenza)
INSERT INTO classification_rules (
  db, rule_name, priority, enabled,
  description_patterns, amount_min, amount_max,
  category_id, subject_id, detail_id,
  confidence, reasoning, created_by
)
SELECT 
  'db1',
  'Commissioni bancarie standard',
  100,
  true,
  ARRAY['COMMISSIONI', 'COMMISSION', 'SPESE SU', 'SPESE BANCARIE'],
  -10.00,
  -0.10,
  c.id,
  s.id,
  NULL,
  98,
  'Commissione bancaria: importo tipico < 10€ + keyword specifica',
  'system'
FROM categories c
JOIN subjects s ON s.name = 'Spese bancarie'
WHERE c.name = 'Banche'
LIMIT 1
ON CONFLICT DO NOTHING;

-- Regola 2: Canoni bancari mensili
INSERT INTO classification_rules (
  db, rule_name, priority, enabled,
  description_patterns, amount_min, amount_max,
  category_id, subject_id, detail_id,
  confidence, reasoning, created_by
)
SELECT 
  'db1',
  'Canone mensile home banking',
  100,
  true,
  ARRAY['CANONE.*MULTICANALIT', 'CANONE.*HOME BANKING', 'CANONE SERVIZIO'],
  -5.00,
  -0.50,
  c.id,
  s.id,
  NULL,
  98,
  'Canone mensile servizi bancari (pattern + importo fisso)',
  'system'
FROM categories c
JOIN subjects s ON s.name = 'Spese bancarie'
WHERE c.name = 'Banche'
LIMIT 1
ON CONFLICT DO NOTHING;

-- Regola 3: Prelievi ATM
INSERT INTO classification_rules (
  db, rule_name, priority, enabled,
  description_patterns, amount_min, amount_max,
  category_id, subject_id,  detail_id,
  confidence, reasoning, created_by
)
SELECT 
  'db1',
  'Prelievi contanti ATM',
  95,
  true,
  ARRAY['PRELEV.*CONT', 'PRELIEVO ATM', 'PREL.*ATM', 'BANCOMAT.*CARTA'],
  -10000.00,
  -50.00,
  c.id,
  s.id,
  NULL,
  97,
  'Prelievo contanti da ATM o Bancomat',
  'system'
FROM categories c
JOIN subjects s ON s.name = 'Prelievi'
WHERE c.name = 'Famiglia'
LIMIT 1
ON CONFLICT DO NOTHING;

-- Regola 4: Carburante (pattern specifici)
INSERT INTO classification_rules (
  db, rule_name, priority, enabled,
  description_patterns, amount_min, amount_max,
  category_id, subject_id, detail_id,
  confidence, reasoning, created_by
)
SELECT 
  'db1',
  'Carburante stazioni servizio',
  95,
  true,
  ARRAY['IPER STATION', 'CARBURANT', 'BENZINA', 'GASOLIO', 'ENI', 'AGIP', 'Q8', 'TAMOIL'],
  -200.00,
  -5.00,
  c.id,
  s.id,
  NULL,
  96,
  'Rifornimento carburante presso stazioni di servizio',
  'system'
FROM categories c
JOIN subjects s ON s.name = 'Carburante'
WHERE c.name = 'Autovetture'
LIMIT 1
ON CONFLICT DO NOTHING;

-- Regola 5: PayPal (transazioni online)
INSERT INTO classification_rules (
  db, rule_name, priority, enabled,
  description_patterns, amount_min, amount_max,
  category_id, subject_id, detail_id,
  confidence, reasoning, created_by
)
SELECT 
  'db1',
  'Transazioni PayPal',
  90,
  true,
  ARRAY['PAYPAL', 'PP\\..*EUROPE'],
  NULL,
  NULL,
  c.id,
  s.id,
  NULL,
  92,
  'Pagamento online tramite PayPal',
  'system'
FROM categories c
JOIN subjects s ON s.name = 'Varie'
WHERE c.name = 'Famiglia'
LIMIT 1
ON CONFLICT DO NOTHING;

-- Regola 6: Vodafone (telefonia)
INSERT INTO classification_rules (
  db, rule_name, priority, enabled,
  description_patterns, amount_min, amount_max,
  category_id, subject_id, detail_id,
  confidence, reasoning, created_by
)
SELECT 
  'db1',
  'Abbonamenti Vodafone',
  95,
  true,
  ARRAY['VODAFONE', 'VF IT'],
  -100.00,
  -5.00,
  c.id,
  s.id,
  NULL,
  97,
  'Abbonamento telefonia mobile/fissa Vodafone',
  'system'
FROM categories c
JOIN subjects s ON s.name = 'Varie'
WHERE c.name = 'Famiglia'
LIMIT 1
ON CONFLICT DO NOTHING;

-- Regola 7: Trenitalia (trasporti)
INSERT INTO classification_rules (
  db, rule_name, priority, enabled,
  description_patterns, amount_min, amount_max,
  category_id, subject_id, detail_id,
  confidence, reasoning, created_by
)
SELECT 
  'db1',
  'Biglietti Trenitalia',
  95,
  true,
  ARRAY['TRENITALIA', 'LE FRECCE', 'ITALO TRENO'],
  -500.00,
  -5.00,
  c.id,
  s.id,
  NULL,
  96,
  'Acquisto biglietti ferroviari',
  'system'
FROM categories c
JOIN subjects s ON s.name = 'Annamaria'
WHERE c.name = 'Famiglia'
LIMIT 1
ON CONFLICT DO NOTHING;

-- Regola 8: Affitto mensile (importo ricorrente specifico)
INSERT INTO classification_rules (
  db, rule_name, priority, enabled,
  description_patterns, amount_min, amount_max,
  category_id, subject_id, detail_id,
  confidence, reasoning, created_by
)
SELECT 
  'db1',
  'Affitto Villa Serenelli',
  100,
  true,
  ARRAY['RIZZO MATTEO'],
  1100.00,
  1200.00,
  c.id,
  s.id,
  d.id,
  99,
  'Bonifico affitto mensile Villa Serenelli - importo e beneficiario fissi',
  'system'
FROM categories c
JOIN subjects s ON s.name = 'Affitto'
JOIN details d ON d.name = 'Affitto'
WHERE c.name = 'Villa Serenelli'
  AND d.subject_id = s.id
LIMIT 1
ON CONFLICT DO NOTHING;

-- Regola 9: Affitto Calmasino (importo ricorrente)
INSERT INTO classification_rules (
  db, rule_name, priority, enabled,
  description_patterns, amount_min, amount_max,
  category_id, subject_id, detail_id,
  confidence, reasoning, created_by
)
SELECT 
  'db1',
  'Affitto Appartamento Calmasino',
  100,
  true,
  ARRAY['POGGIO CLARA', 'ZECCHINI ANDREA'],
  800.00,
  900.00,
  c.id,
  s.id,
  d.id,
  99,
  'Bonifico affitto mensile Calmasino - importo e beneficiario fissi',
  'system'
FROM categories c
JOIN subjects s ON s.name = 'Affitto'
JOIN details d ON d.name = 'Affitto'
WHERE c.name = 'Appartamento Calmasino'
  AND d.subject_id = s.id
LIMIT 1
ON CONFLICT DO NOTHING;

-- Regola 10: Ricariche carta prepagata (pattern specifico)
INSERT INTO classification_rules (
  db, rule_name, priority, enabled,
  description_patterns, amount_min, amount_max,
  category_id, subject_id, detail_id,
  confidence, reasoning, created_by
)
SELECT 
  'db1',
  'Ricarica carta prepagata Anuja',
  95,
  true,
  ARRAY['RIC.*CARTA PREP', 'RICARICA PREPAGATA.*4726 7574'],
  -2500.00,
  -400.00,
  c.id,
  s.id,
  NULL,
  98,
  'Ricarica mensile carta prepagata dipendente',
  'system'
FROM categories c
JOIN subjects s ON s.name = 'Anuja Ronald Wijendra - 4726 7574 6586 4945'
WHERE c.name = 'Carte'
LIMIT 1
ON CONFLICT DO NOTHING;

-- Regola 11: Addebiti NEXI (carta specifica)
INSERT INTO classification_rules (
  db, rule_name, priority, enabled,
  description_patterns, amount_min, amount_max,
  category_id, subject_id, detail_id,
  confidence, reasoning, created_by
)
SELECT 
  'db1',
  'Addebiti carta NEXI Guido',
  90,
  true,
  ARRAY['ADDEBITO NEXI', 'NEXI PAYMENTS', 'NEXI.*50070'],
  NULL,
  -10.00,
  c.id,
  s.id,
  NULL,
  94,
  'Addebito mensile spese carta di credito NEXI',
  'system'
FROM categories c
JOIN subjects s ON s.name = 'Guido Cantini (Da verificare) - NEXI 50070'
WHERE c.name = 'Carte'
LIMIT 1
ON CONFLICT DO NOTHING;

-- Regola 12: Pagamenti POS generici
INSERT INTO classification_rules (
  db, rule_name, priority, enabled,
  description_patterns, amount_min, amount_max,
  category_id, subject_id, detail_id,
  confidence, reasoning, created_by
)
SELECT 
  'db1',
  'Pagamenti POS generici',
  50,
  true,
  ARRAY['PAGAM\\..*POS', 'PAGAMENTO.*CARTA', 'PAGOBANCOMAT'],
  NULL,
  -1.00,
  c.id,
  s.id,
  NULL,
  70,
  'Pagamento POS generico - necessita ulteriore classificazione',
  'system'
FROM categories c
JOIN subjects s ON s.name = 'Varie'
WHERE c.name = 'Famiglia'
LIMIT 1
ON CONFLICT DO NOTHING;

-- Regola 13: Bollette/CBILL
INSERT INTO classification_rules (
  db, rule_name, priority, enabled,
  description_patterns, amount_min, amount_max,
  category_id, subject_id, detail_id,
  confidence, reasoning, created_by
)
SELECT 
  'db1',
  'Pagamento bollette CBILL',
  90,
  true,
  ARRAY['PAGAMENTO CBILL', 'PAGOBOLLETT', 'CBILL'],
  -500.00,
  -10.00,
  c.id,
  s.id,
  NULL,
  92,
  'Pagamento bollette tramite servizio CBILL',
  'system'
FROM categories c
JOIN subjects s ON s.name = 'Annamaria'
WHERE c.name = 'Famiglia'
LIMIT 1
ON CONFLICT DO NOTHING;

-- Regola 14: Spese ristoranti specifici (Osteria Le Piere)
INSERT INTO classification_rules (
  db, rule_name, priority, enabled,
  description_patterns, amount_min, amount_max,
  category_id, subject_id, detail_id,
  confidence, reasoning, created_by
)
SELECT 
  'db1',
  'Ristorante Osteria Le Piere',
  95,
  true,
  ARRAY['OSTERIA LE PIERE'],
  -100.00,
  -5.00,
  c.id,
  s.id,
  NULL,
  96,
  'Spese presso ristorante abituale',
  'system'
FROM categories c
JOIN subjects s ON s.name = 'Varie'
WHERE c.name = 'Famiglia'
LIMIT 1
ON CONFLICT DO NOTHING;

-- Regola 15: White Monkey (staff ricorrente)
INSERT INTO classification_rules (
  db, rule_name, priority, enabled,
  description_patterns, amount_min, amount_max,
  category_id, subject_id, detail_id,
  confidence, reasoning, created_by
)
SELECT 
  'db1',
  'White Monkey staff expenses',
  95,
  true,
  ARRAY['WHITE MONKEY'],
  -100.00,
  NULL,
  c.id,
  s.id,
  NULL,
  96,
  'Spese staff ricorrenti WhiteMonkey',
  'system'
FROM categories c
JOIN subjects s ON s.name = 'Varie'
WHERE c.name = 'Staff'
LIMIT 1
ON CONFLICT DO NOTHING;

-- ==========================================
-- STATISTICHE FINALI
-- ==========================================

-- Conta regole inserite
SELECT 
  db,
  COUNT(*) as total_rules,
  COUNT(*) FILTER (WHERE enabled = true) as active_rules,
  AVG(confidence)::numeric(5,2) as avg_confidence,
  MIN(priority) as min_priority,
  MAX(priority) as max_priority
FROM classification_rules
GROUP BY db;

COMMENT ON TABLE classification_rules IS 'Regole deterministiche per auto-classificazione transazioni (Stage 1 della pipeline)';
