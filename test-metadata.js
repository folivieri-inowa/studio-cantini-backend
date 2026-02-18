import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: 'postgres://root:StudioCantini2026!@localhost:5435/studio-cantini-local'
});

const OLLAMA_URL = 'http://localhost:11434';
const METADATA_MODEL = 'mistral-nemo:latest';

/**
 * Estrae metadata strutturati dal testo usando LLM con schema flessibile
 * Supporta: persone, dipendenti, immobili, aziende, autovetture, documenti finanziari, legali, etc.
 */
async function extractMetadataWithLLM(text) {
  const response = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: METADATA_MODEL,
      prompt: `Analizza il seguente testo estratto da un documento ed estrai i metadata in formato JSON strutturato e flessibile.

TESTO:
${text.substring(0, 4000)}

ESTRAI I SEGUENTI CAMPI con questo schema JSON esatto (rispondi SOLO con JSON valido, niente altro testo):

{
  "document_type": "tipo specifico: patente|passaporto|carta_identita|codice_fiscale|bolletta_enel|bolletta_gas|fattura|preventivo|contratto_affitto|rogito|polizza_auto|polizza_vita|multa|bollo_auto|certificato_medico|referto|busta_paga|contratto_lavoro|visura_camerale|altro",
  "document_category": "identita|finanziario|utilities|immobiliare|assicurativo|legale|trasporto|sanitario|lavoro|fiscale|altro",
  "confidence": {
    "document_type": 0.0-1.0,
    "overall": 0.0-1.0
  },
  "identification": {
    "document_number": "numero documento/protocollo/matricola o null",
    "issue_date": "YYYY-MM-DD data emissione o null",
    "expiry_date": "YYYY-MM-DD data scadenza o null",
    "issuing_authority": "ente/ufficio che ha emesso il documento o null"
  },
  "parties": {
    "holder": {
      "name": "nome intestatario/titolare o null",
      "identifier": "codice fiscale/partita iva/numero patente o null",
      "birth_date": "YYYY-MM-DD o null",
      "birth_place": "luogo nascita o null",
      "address": "indirizzo residenza/sede o null",
      "contact": "telefono/email o null"
    },
    "issuer": {
      "name": "nome ente/azienda emittente o null",
      "identifier": "p.iva/codice ente o null",
      "address": "indirizzo o null",
      "contact": "telefono/email o null"
    },
    "counterparty": {
      "name": "controparte (cliente, locatore, assicurato, etc) o null",
      "identifier": "codice identificativo o null",
      "address": "indirizzo o null",
      "contact": "telefono/email o null"
    }
  },
  "subject": {
    "title": "oggetto/titolo principale o null",
    "description": "descrizione sintetica o null",
    "category": "categoria specifica del documento o null"
  },
  "financial": {
    "amounts": [
      {
        "type": "totale|imponibile|iva|scadenza|penale|canone|premio|bollo",
        "value": numero o null,
        "currency": "EUR|USD|altro o EUR"
      }
    ],
    "payment": {
      "due_date": "YYYY-MM-DD scadenza pagamento o null",
      "method": "metodo pagamento o null",
      "reference": "codice bollettino/riferimento o null",
      "iban": "iban per bonifici o null"
    }
  },
  "content": {
    "summary": "riassunto estremamente breve max 150 caratteri",
    "key_facts": ["fatto1", "fatto2", "max 5 elementi chiave"],
    "dates": [
      {
        "type": "emissione|scadenza|inizio|fine|evento|decorrenza",
        "date": "YYYY-MM-DD",
        "description": "descrizione della data"
      }
    ],
    "locations": ["indirizzi, luoghi, comuni menzionati"]
  },
  "custom_fields": {
    "targa": "targa veicolo o null",
    "telaio": "numero telaio o null",
    "km": "chilometraggio o null",
    "indirizzo_immobile": "indirizzo completo immobile o null",
    "foglio": "dati catastali foglio o null",
    "particella": "dati catastali particella o null",
    "subalterno": "dati catastali subalterno o null",
    "numero_polizza": "numero polizza assicurativa o null",
    "tipo_polizza": "RC auto|casa|vita|infortuni o null",
    "numero_contratto": "numero contratto utenza o null",
    "tipo_utenza": "luce|gas|acqua|telefono|internet o null",
    "periodo_fatturazione": "periodo di riferimento o null",
    "consumi": "consumi rilevati o null",
    "posizione_lavorativa": "mansione/qualifica o null",
    "livello_ccnl": "livello contrattuale o null",
    "retribuzione_annua": "RAL o null",
    "motivazione_multa": "violazione commessa o null",
    "punti_patente": "punti decurtati o null",
    "nome_medico": "medico/dottore o null",
    "struttura_sanitaria": "ospedale/clinica o null",
    "diagnosi": "diagnosi/referto o null",
    "altro": "qualsiasi altro dato specifico non coperto"
  },
  "services": ["servizi menzionati nel documento"],
  "products": ["prodotti menzionati nel documento"],
  "keywords": ["max 10 parole chiave"],
  "language": "it|en|fr|de|es|altro"
}

REGOLE IMPORTANTI:
- Usa NULL (non stringa vuota) per campi non presenti
- Date sempre in formato ISO YYYY-MM-DD
- Importi sempre come numeri, non stringhe formattate
- document_type: identifica il tipo più specifico possibile
- document_category: scegli la categoria generale appropriata
- custom_fields: popola SOLO i campi rilevanti per il tipo di documento
- parties: holder=intestatario, issuer=chi emette, counterparty=altra parte
- financial.amounts: array per documenti con più importi (scadenze, rate, etc)
- content.dates: estrai TUTTE le date significative con il loro tipo
- content.locations: indirizzi completi, comuni, sedi menzionate
- confidence: 0.9=sicuro, 0.7=probabile, 0.5=incerto
- Per documenti identità: focus su holder, identification, issuing_authority
- Per documenti finanziari: focus su parties, financial
- Per documenti immobiliari: focus su custom_fields.indirizzo_immobile, catastali
- Per documenti veicoli: focus su custom_fields.targa, telaio, km
- Per documenti assicurativi: focus su custom_fields.numero_polizza, expiry_date
- Per documenti sanitari: focus su holder, content.key_facts, custom_fields.diagnosi`,
      stream: false,
      options: {
        temperature: 0.1,
        num_predict: 2500,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama metadata error: ${response.statusText}`);
  }

  const data = await response.json();

  // Estrai JSON dalla risposta
  try {
    const jsonMatch = data.response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return validateAndNormalizeMetadata(parsed);
    }
    return getDefaultMetadata();
  } catch (e) {
    console.error('Errore parsing metadata JSON:', e);
    console.error('Risposta raw:', data.response?.substring(0, 500));
    return getDefaultMetadata();
  }
}

/**
 * Valida e normalizza i metadata estratti - Schema flessibile
 */
function validateAndNormalizeMetadata(metadata) {
  const defaults = getDefaultMetadata();

  // Normalizza financial amounts
  let amounts = [];
  if (Array.isArray(metadata.financial?.amounts)) {
    amounts = metadata.financial.amounts.map(a => ({
      type: a.type || 'totale',
      value: parseFloat(a.value) || null,
      currency: a.currency || 'EUR',
    }));
  }

  // Estrai total amount se non presente in amounts
  const totalAmount = amounts.find(a => a.type === 'totale')?.value ||
                      amounts.find(a => a.type === 'imponibile')?.value ||
                      null;

  return {
    document_type: metadata.document_type || defaults.document_type,
    document_category: metadata.document_category || defaults.document_category,
    confidence: {
      document_type: metadata.confidence?.document_type ?? 0.5,
      overall: metadata.confidence?.overall ?? 0.5,
    },
    identification: {
      document_number: metadata.identification?.document_number || null,
      issue_date: normalizeDate(metadata.identification?.issue_date),
      expiry_date: normalizeDate(metadata.identification?.expiry_date),
      issuing_authority: metadata.identification?.issuing_authority || null,
    },
    parties: {
      holder: {
        name: metadata.parties?.holder?.name || null,
        identifier: metadata.parties?.holder?.identifier || null,
        birth_date: normalizeDate(metadata.parties?.holder?.birth_date),
        birth_place: metadata.parties?.holder?.birth_place || null,
        address: metadata.parties?.holder?.address || null,
        contact: metadata.parties?.holder?.contact || null,
      },
      issuer: {
        name: metadata.parties?.issuer?.name || null,
        identifier: metadata.parties?.issuer?.identifier || null,
        address: metadata.parties?.issuer?.address || null,
        contact: metadata.parties?.issuer?.contact || null,
      },
      counterparty: {
        name: metadata.parties?.counterparty?.name || null,
        identifier: metadata.parties?.counterparty?.identifier || null,
        address: metadata.parties?.counterparty?.address || null,
        contact: metadata.parties?.counterparty?.contact || null,
      },
    },
    subject: {
      title: metadata.subject?.title || null,
      description: metadata.subject?.description || null,
      category: metadata.subject?.category || null,
    },
    financial: {
      amounts: amounts,
      payment: {
        due_date: normalizeDate(metadata.financial?.payment?.due_date),
        method: metadata.financial?.payment?.method || null,
        reference: metadata.financial?.payment?.reference || null,
        iban: metadata.financial?.payment?.iban || null,
      },
    },
    content: {
      summary: metadata.content?.summary || '',
      key_facts: Array.isArray(metadata.content?.key_facts) ? metadata.content.key_facts.slice(0, 5) : [],
      dates: Array.isArray(metadata.content?.dates) ? metadata.content.dates.map(d => ({
        type: d.type || 'evento',
        date: normalizeDate(d.date),
        description: d.description || '',
      })) : [],
      locations: Array.isArray(metadata.content?.locations) ? metadata.content.locations : [],
    },
    custom_fields: metadata.custom_fields || {},
    services: Array.isArray(metadata.services) ? metadata.services : [],
    products: Array.isArray(metadata.products) ? metadata.products : [],
    keywords: Array.isArray(metadata.keywords) ? metadata.keywords.slice(0, 10) : [],
    language: metadata.language || 'it',
    // Campi legacy per retrocompatibilità
    doc_amount: totalAmount,
    doc_date: normalizeDate(metadata.identification?.issue_date) || normalizeDate(metadata.content?.dates?.[0]?.date),
    doc_due_date: normalizeDate(metadata.financial?.payment?.due_date) || normalizeDate(metadata.identification?.expiry_date),
    doc_sender: metadata.parties?.issuer?.name || null,
    doc_recipient: metadata.parties?.holder?.name || metadata.parties?.counterparty?.name || null,
  };
}

/**
 * Normalizza date in formato ISO
 */
function normalizeDate(dateValue) {
  if (!dateValue || dateValue === 'null') return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) return dateValue;

  const italianMonths = {
    'gennaio': '01', 'febbraio': '02', 'marzo': '03', 'aprile': '04',
    'maggio': '05', 'giugno': '06', 'luglio': '07', 'agosto': '08',
    'settembre': '09', 'ottobre': '10', 'novembre': '11', 'dicembre': '12'
  };

  const match = dateValue.toString().match(/(\d{1,2})[\s\/\-](\w+|\d{2})[\s\/\-]?(\d{4})?/i);
  if (match) {
    const day = match[1].padStart(2, '0');
    const monthStr = match[2].toLowerCase();
    const month = italianMonths[monthStr] || monthStr.padStart(2, '0');
    const year = match[3] || new Date().getFullYear();
    return `${year}-${month}-${day}`;
  }

  return null;
}

/**
 * Restituisce metadata di default vuoti - Schema flessibile
 */
function getDefaultMetadata() {
  return {
    document_type: 'altro',
    document_category: 'altro',
    confidence: { document_type: 0, overall: 0 },
    identification: {
      document_number: null,
      issue_date: null,
      expiry_date: null,
      issuing_authority: null,
    },
    parties: {
      holder: { name: null, identifier: null, birth_date: null, birth_place: null, address: null, contact: null },
      issuer: { name: null, identifier: null, address: null, contact: null },
      counterparty: { name: null, identifier: null, address: null, contact: null },
    },
    subject: { title: null, description: null, category: null },
    financial: {
      amounts: [],
      payment: { due_date: null, method: null, reference: null, iban: null },
    },
    content: {
      summary: '',
      key_facts: [],
      dates: [],
      locations: [],
    },
    custom_fields: {},
    services: [],
    products: [],
    keywords: [],
    language: 'it',
  };
}

// Test con testo del preventivo
const testText = `PREVENTIVO Software Gestionale

Cliente: Studio Cantini
Data: 15 Febbraio 2025

Progetto: Realizzazione Gestionale Integrato

SERVIZI INCLUSI:
- Analisi requisiti e progettazione
- Sviluppo modulo contabilità
- Sviluppo modulo archivio documentale
- Sviluppo modulo scadenziario
- Integrazione AI per classificazione

COSTI:
Analisi e progettazione: € 5.000,00
Sviluppo frontend: € 12.000,00
Sviluppo backend: € 15.000,00
Integrazione AI/ML: € 8.000,00
Testing e QA: € 3.000,00
Documentazione: € 2.000,00

TOTALE: € 45.000,00 + IVA 22%

Tempo stimato: 4 mesi
Scadenza offerta: 31 Marzo 2025

Note: Il preventivo include assistenza per 12 mesi.`;

console.log('🧪 Test estrazione metadata con SCHEMA FLESSIBILE\n');
console.log('Testo di input:');
console.log('='.repeat(50));
console.log(testText);
console.log('='.repeat(50));
console.log('\n🤖 Chiamata LLM per estrazione metadata...\n');

const metadata = await extractMetadataWithLLM(testText);

console.log('\n✅ Metadata estratti:');
console.log(JSON.stringify(metadata, null, 2));

// Salva nel DB se richiesto
const client = await pool.connect();
try {
  const docs = await client.query("SELECT id FROM archive_documents WHERE original_filename = 'preventivo-test.txt'");
  if (docs.rows.length > 0) {
    const docId = docs.rows[0].id;
    await client.query(
      'UPDATE archive_documents SET extracted_metadata = $1 WHERE id = $2',
      [JSON.stringify(metadata), docId]
    );
    console.log(`\n💾 Metadata salvati nel database per documento ${docId}`);
  }
} catch (e) {
  console.error('Errore salvataggio DB:', e.message);
} finally {
  client.release();
  await pool.end();
}

console.log('\n✨ Test completato!');
