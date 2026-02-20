/**
 * Archive Worker - Sistema di workers basato su pg-boss
 *
 * Questo worker usa pg-boss per job queue robusta con:
 * - Retry automatico con exponential backoff
 * - Dead letter queue per job falliti
 * - Graceful shutdown
 * - Health check
 */

import dotenv from 'dotenv';
dotenv.config();

import PgBoss from 'pg-boss';
import pg from 'pg';
import * as Minio from 'minio';
import FormData from 'form-data';
import pdfParse from 'pdf-parse';
import { QdrantClient } from '@qdrant/js-client-rest';
import { DocumentRepository } from '../repositories/document.repository.js';
import { ChunkRepository } from '../repositories/chunk.repository.js';

const { Pool } = pg;

// Configurazione
const WORKER_ID = process.env.WORKER_ID || `archive-worker-${process.pid}`;
const WORKER_TYPE = process.env.WORKER_TYPE || 'all'; // 'ocr', 'metadata', 'cleaning', 'embedding', 'all'
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const EMBEDDING_MODEL = process.env.OLLAMA_EMBEDDING_MODEL || 'bge-m3:latest';
const CLEANING_MODEL = process.env.OLLAMA_CLEANING_MODEL || 'mistral-nemo:latest';
const METADATA_MODEL = process.env.OLLAMA_METADATA_MODEL || 'mistral-nemo:latest';

// Docling OCR Configuration
const DOCLING_URL = process.env.DOCLING_URL || 'http://localhost:5001';
const USE_DOCLING_OCR = process.env.USE_DOCLING_OCR !== 'false'; // Default: true

// GOT-OCR 2.0 Configuration
const GOT_OCR_URL = process.env.GOT_OCR_URL || 'http://got-ocr:5002';
const USE_GOT_OCR = process.env.USE_GOT_OCR !== 'false';

// Qdrant Configuration
const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const QDRANT_COLLECTION = 'archive_document_chunks';
const EMBEDDING_SIZE = 1024; // bge-m3:latest produce 1024 dims
const EMBEDDING_DISTANCE = 'Cosine';

// Inizializza Qdrant client
const qdrantClient = new QdrantClient({ url: QDRANT_URL });

// Timeout e Retry Configuration per documenti grandi (fino a 10MB)
const DOC_PROCESSING_CONFIG = {
  // Timeout per Docling: 15 minuti per file grandi (10MB)
  doclingTimeoutMs: parseInt(process.env.DOCLING_TIMEOUT_MS) || 15 * 60 * 1000,
  // Timeout per Ollama: 10 minuti
  ollamaTimeoutMs: parseInt(process.env.OLLAMA_TIMEOUT_MS) || 10 * 60 * 1000,
  // Numero massimo di retry per documento
  maxRetries: parseInt(process.env.MAX_DOC_RETRIES) || 3,
  // Backoff: pausa iniziale 30s, raddoppia ad ogni retry (30s, 60s, 120s)
  baseRetryDelayMs: parseInt(process.env.BASE_RETRY_DELAY_MS) || 30 * 1000,
  // Dimensione file soglia per warning (5MB)
  largeFileThresholdBytes: 5 * 1024 * 1024,
};

// Connessioni
const pool = new Pool({ connectionString: process.env.POSTGRES_URL });

const minioClient = new Minio.Client({
  endPoint: process.env.MINIO_ENDPOINT || 'minio.studiocantini.wavetech.it',
  port: parseInt(process.env.MINIO_PORT) || 443,
  useSSL: process.env.MINIO_USE_SSL !== 'false',
  accessKey: process.env.MINIO_ACCESS_KEY || 'minioAdmin',
  secretKey: process.env.MINIO_SECRET_KEY || 'Inowa2024',
});

// Inizializza pg-boss con configurazione per documenti grandi
const boss = new PgBoss({
  connectionString: process.env.POSTGRES_URL,
  retryLimit: DOC_PROCESSING_CONFIG.maxRetries,
  retryDelay: DOC_PROCESSING_CONFIG.baseRetryDelayMs / 1000, // pg-boss usa secondi
  retryBackoff: true,
  expireInMinutes: 30,  // Max 30 minuti per job (file grandi)
  retentionDays: 1,
  deleteAfterDays: 7,
  archiveFailedAfterDays: 1,
});

// Health check state
let health = {
  status: 'starting',
  lastActivity: Date.now(),
  jobsProcessed: 0,
  jobsFailed: 0,
  errors: [],
};

/**
 * Gestisce errori con retry limitato e backoff
 * Ritorna true se il documento è stato marcato come failed (non più retry)
 * Ritorna false se bisogna fare retry (lancia errore)
 */
async function handleDocumentError(documentRepo, documentId, error, jobType) {
  const document = await documentRepo.findById(documentId);
  if (!document) {
    console.error(`[${jobType}] Documento ${documentId} non trovato`);
    return true;
  }

  const currentRetries = document.retry_count || 0;
  const maxRetries = DOC_PROCESSING_CONFIG.maxRetries;

  console.warn(`[${jobType}] Errore su documento ${documentId}: ${error.message}`);
  console.warn(`[${jobType}] Retry ${currentRetries}/${maxRetries}`);

  if (currentRetries >= maxRetries) {
    // Max retry raggiunto, marca come failed definitivamente
    await documentRepo.markAsFailed(
      documentId,
      `Fallito dopo ${maxRetries} tentativi: ${error.message}`
    );
    console.error(`[${jobType}] ❌ Documento ${documentId} marcato come FAILED dopo ${maxRetries} tentativi`);
    return true; // Non fare più retry
  }

  // Incrementa retry count
  await documentRepo.incrementRetryCount(documentId);

  // Calcola backoff (30s, 60s, 120s)
  const backoffMs = DOC_PROCESSING_CONFIG.baseRetryDelayMs * Math.pow(2, currentRetries);
  console.log(`[${jobType}] ⏳ Backoff: ${backoffMs / 1000}s prima del prossimo tentativo`);

  // Aggiorna stato con messaggio di errore
  await documentRepo.updateProcessingStatus(
    documentId,
    'pending',
    `Tentativo ${currentRetries + 1}/${maxRetries} fallito: ${error.message}. Retry in ${backoffMs / 1000}s...`
  );

  // Attendi il backoff prima di rilanciare (pg-boss rischedulerà il job)
  await new Promise(resolve => setTimeout(resolve, backoffMs));

  return false; // Riprova (rilancia errore)
}

/**
 * Analizza il tipo di PDF per scegliere il motore OCR più adatto
 * Ritorna: 'native' (PDF con testo selezionabile) o 'scanned' (PDF immagine)
 */
async function analyzePDFType(fileBuffer) {
  try {
    const pdfData = await pdfParse(fileBuffer);
    const textLength = pdfData.text?.trim().length || 0;
    const numPages = pdfData.numpages || 1;

    // Calcola caratteri per pagina
    const charsPerPage = textLength / numPages;

    // Soglia: meno di 50 caratteri per pagina = probabilmente scannerizzato
    // Questo è un valore euristico che copre la maggior parte dei casi
    const isScanned = charsPerPage < 50;

    console.log(`📊 Analisi PDF: ${textLength} caratteri su ${numPages} pagine (${charsPerPage.toFixed(0)} char/pagina) - Tipo: ${isScanned ? 'scannerizzato' : 'nativo'}`);

    return isScanned ? 'scanned' : 'native';
  } catch (error) {
    console.warn(`⚠️ Errore analisi PDF: ${error.message}, assumo scannerizzato`);
    return 'scanned'; // Se non riusciamo ad analizzare, assumiamo il caso peggiore
  }
}

/**
 * Estrae testo da PDF/immagine con selezione intelligente del motore OCR
 * PDF: Analisi preventiva per scegliere tra Docling (nativo) o MiniCPM-o (scannerizzato)
 * Immagini: MiniCPM-o direttamente
 */
async function extractTextWithOCR(fileBuffer, filename = 'document.pdf') {
  const isPDF = filename.toLowerCase().endsWith('.pdf');

  // Per immagini: usa direttamente GOT-OCR
  if (!isPDF) {
    console.log(`🖼️ File immagine rilevato, uso GOT-OCR...`);
    return extractTextWithGotOCR(fileBuffer, filename);
  }

  // Per PDF: analisi preventiva per scegliere il motore
  if (isPDF) {
    const pdfType = await analyzePDFType(fileBuffer);

    if (USE_DOCLING_OCR) {
      // Usa sempre Docling per tutti i PDF (nativi e scannerizzati)
      // Docling con do_ocr=true e Tesseract gestisce entrambi i casi
      const typeLabel = pdfType === 'native' ? 'nativo' : 'scannerizzato';
      console.log(`📄 PDF ${typeLabel} rilevato, uso Docling con OCR (Tesseract)...`);
      try {
        const text = await extractTextWithDocling(fileBuffer, filename);
        if (text && text.trim().length > 10) {
          console.log(`✅ Docling OCR: ${text.length} caratteri estratti`);
          return text;
        }
        // Se Docling restituisce poco testo, fallback a GOT-OCR
        console.warn(`⚠️ Docling ha estratto poco testo (${text?.length || 0} chars), fallback a GOT-OCR...`);
        return await extractTextWithGotOCR(fileBuffer, filename);
      } catch (error) {
        console.error(`❌ Docling fallito: ${error.message}, fallback a GOT-OCR...`);
        return await extractTextWithGotOCR(fileBuffer, filename);
      }
    } else {
      // Docling disabilitato: usa GOT-OCR direttamente
      console.log(`📄 Docling disabilitato, uso GOT-OCR...`);
      return await extractTextWithGotOCR(fileBuffer, filename);
    }
  }

  throw new Error(
    `Nessun motore OCR disponibile per: ${filename}. ` +
    `Docling non configurato o disabilitato.`
  );
}

/**
 * Estrae testo usando Docling OCR (PDF nativo)
 */
async function extractTextWithDocling(fileBuffer, filename = 'document.pdf') {
  // Costruisci la URL con query parameters
  const params = new URLSearchParams({
    do_ocr: 'true',
    do_table_structure: 'true',
    ocr_engine: 'tesseract',
    ocr_lang: 'ita'
  });

  // Determina mime type dal filename
  const ext = filename.split('.').pop()?.toLowerCase();
  const mimeTypes = {
    'pdf': 'application/pdf',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'tiff': 'image/tiff',
    'tif': 'image/tiff',
  };
  const mimeType = mimeTypes[ext] || 'application/octet-stream';

  // Crea form data manualmente con Buffer
  const boundary = '----FormBoundary' + Math.random().toString(36).substring(2);

  // Header del form
  const header = Buffer.from([
    `--${boundary}`,
    `Content-Disposition: form-data; name="files"; filename="${filename}"`,
    `Content-Type: ${mimeType}`,
    '',
    ''
  ].join('\r\n'));

  // Footer del form
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);

  // Combina header + file + footer
  const formData = Buffer.concat([header, fileBuffer, footer]);

  // Calcola timeout basato sulla dimensione del file (min 5 min, max 15 min)
  const fileSizeMB = fileBuffer.length / (1024 * 1024);
  const dynamicTimeout = Math.min(
    Math.max(DOC_PROCESSING_CONFIG.doclingTimeoutMs / 3, fileSizeMB * 60 * 1000), // ~1 min per MB
    DOC_PROCESSING_CONFIG.doclingTimeoutMs // max 15 min
  );

  console.log(`⏱️  Timeout Docling: ${Math.round(dynamicTimeout / 1000)}s per file ${fileSizeMB.toFixed(2)}MB`);

  const response = await fetch(`${DOCLING_URL}/v1/convert/file?${params.toString()}`, {
    method: 'POST',
    body: formData,
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    timeout: dynamicTimeout,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Docling API error: ${response.status} ${errorText}`);
  }

  const data = await response.json();

  // Log per debug
  console.log('📄 Docling response keys:', Object.keys(data));
  if (data.document) {
    console.log('📄 Docling document keys:', Object.keys(data.document));
  }

  // Docling ritorna un oggetto con document.md_content
  if (data.document && data.document.md_content) {
    return data.document.md_content;
  }

  // Fallback per altri formati
  if (data.document && data.document.text_content) {
    return data.document.text_content;
  }

  if (data.md_content) {
    return data.md_content;
  }

  if (data.text_content) {
    return data.text_content;
  }

  // Log completo per debug
  console.log('📄 Docling full response:', JSON.stringify(data, null, 2).substring(0, 1000));
  throw new Error('Docling: nessun contenuto estratto');
}

/**
 * Estrae testo da PDF/immagine usando GOT-OCR 2.0.
 * Invia il file al microservizio got-ocr via multipart/form-data.
 * Sostituisce llava:7b + pdftoppm come fallback per PDF scansionati.
 */
async function extractTextWithGotOCR(fileBuffer, filename = 'document.pdf') {
  const boundary = '----FormBoundary' + Math.random().toString(36).substring(2);

  const ext = filename.split('.').pop()?.toLowerCase();
  const mimeTypes = {
    'pdf': 'application/pdf',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'tiff': 'image/tiff',
    'tif': 'image/tiff',
  };
  const mimeType = mimeTypes[ext] || 'application/octet-stream';

  const header = Buffer.from([
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    `Content-Type: ${mimeType}`,
    '',
    ''
  ].join('\r\n'));

  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const formData = Buffer.concat([header, fileBuffer, footer]);

  console.log(`🔍 GOT-OCR: invio ${filename} (${fileBuffer.length} bytes)...`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DOC_PROCESSING_CONFIG.ollamaTimeoutMs);

  try {
    const response = await fetch(`${GOT_OCR_URL}/ocr`, {
      method: 'POST',
      body: formData,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GOT-OCR API error: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    const text = data.text?.trim() || '';

    if (!text) {
      throw new Error('GOT-OCR: nessun testo estratto');
    }

    console.log(`✅ GOT-OCR: ${text.length} caratteri estratti (${data.pages || 1} pagine)`);
    return text;

  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Timeout: GOT-OCR ha impiegato più di ${DOC_PROCESSING_CONFIG.ollamaTimeoutMs / 1000}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Genera embeddings usando Ollama
 */
async function generateEmbedding(text) {
  const response = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      prompt: text,
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama embedding error: ${response.statusText}`);
  }

  const data = await response.json();
  return data.embedding;
}

/**
 * Pulisce il testo usando LLM.
 * Per testi lunghi usa chunking da 8000 chars con overlap 200
 * per non perdere contenuto (fix: prima troncava a 4000 chars).
 */
async function cleanTextWithLLM(text) {
  const MAX_CHUNK = 8000;
  const OVERLAP = 200;

  // Se il testo è corto, processa direttamente
  if (text.length <= MAX_CHUNK) {
    return cleanTextChunk(text);
  }

  // Altrimenti processa in chunks e concatena
  console.log(`✂️  Cleaning testo lungo (${text.length} chars) in chunks da ${MAX_CHUNK}...`);
  const parts = [];
  let offset = 0;

  while (offset < text.length) {
    const end = Math.min(offset + MAX_CHUNK, text.length);
    const chunk = text.substring(offset, end);
    const cleaned = await cleanTextChunk(chunk);
    parts.push(cleaned);
    offset += MAX_CHUNK - OVERLAP;
    if (offset >= text.length - OVERLAP) break;
  }

  return parts.join(' ');
}

/**
 * Pulisce un singolo chunk di testo con LLM
 */
async function cleanTextChunk(text) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DOC_PROCESSING_CONFIG.ollamaTimeoutMs);

  try {
    const response = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CLEANING_MODEL,
        prompt: `Pulisci e formatta il seguente testo estratto da un documento. Correggi errori OCR, migliora la formattazione, preserva struttura e tabelle. Restituisci SOLO il testo pulito:\n\n${text}`,
        stream: false,
        options: {
          temperature: 0.1,
        },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Ollama cleaning error: ${response.statusText}`);
    }

    const data = await response.json();
    return data.response;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Timeout: cleaning ha impiegato più di ${DOC_PROCESSING_CONFIG.ollamaTimeoutMs / 1000}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Divide il testo in chunks semanticamente coerenti
 */
function chunkText(text, maxChunkSize = 800, overlap = 100) {
  const chunks = [];
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];

  let currentChunk = '';
  for (const sentence of sentences) {
    if (currentChunk.length + sentence.length > maxChunkSize) {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
      }
      // Overlap: inizia con l'ultima parte del chunk precedente
      currentChunk = currentChunk.slice(-overlap) + sentence;
    } else {
      currentChunk += sentence;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

/**
 * Download file da MinIO o storage locale
 */
async function downloadFile(bucket, objectPath) {
  // Prima prova HTTP diretto (per MinIO locale senza auth)
  try {
    const httpUrl = `http://${process.env.MINIO_ENDPOINT || 'localhost'}:${process.env.MINIO_PORT || '9000'}/${bucket}/${encodeURIComponent(objectPath)}`;
    console.log(`📥 Download via HTTP: ${httpUrl}`);
    const response = await fetch(httpUrl, { timeout: 30000 });
    if (response.ok) {
      const arrayBuffer = await response.arrayBuffer();
      console.log(`✅ Download HTTP riuscito: ${arrayBuffer.byteLength} bytes`);
      return Buffer.from(arrayBuffer);
    }
    console.warn(`⚠️ HTTP ${response.status}, provo MinIO client...`);
  } catch (httpError) {
    console.warn(`⚠️ HTTP download fallito: ${httpError.message}`);
  }

  // Prova MinIO client
  try {
    console.log(`📥 Download via MinIO client: ${bucket}/${objectPath}`);
    const stream = await minioClient.getObject(bucket, objectPath);
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    console.log(`✅ Download MinIO riuscito: ${chunks.reduce((a, b) => a + b.length, 0)} bytes`);
    return Buffer.concat(chunks);
  } catch (minioError) {
    console.warn(`⚠️ MinIO client fallito: ${minioError.message}`);

    // Fallback a storage locale
    const localStorageBase = process.env.LOCAL_STORAGE_PATH || '/app/uploads';
    const localPath = `${localStorageBase}/${bucket}/${objectPath}`;
    try {
      const fs = await import('fs');
      const data = fs.readFileSync(localPath);
      console.log(`✅ Download locale riuscito: ${data.length} bytes`);
      return data;
    } catch (fsError) {
      throw new Error(`File non trovato né su MinIO (HTTP/client) né in locale: ${bucket}/${objectPath}`);
    }
  }
}

/**
 * Valida che il testo estratto sia effettivamente testo leggibile
 * Ritorna { valid: boolean, reason: string }
 */
function validateExtractedText(text) {
  if (!text || text.trim().length === 0) {
    return { valid: false, reason: 'Testo vuoto' };
  }

  // Check per immagini base64 (markdown image syntax)
  if (text.startsWith('![Image](data:image/') || text.startsWith('data:image/')) {
    return { valid: false, reason: 'Il testo estratto è un immagine base64, non testo leggibile' };
  }

  // Check per base64 puro (lunghezza > 100 e pattern base64)
  const base64Pattern = /^[A-Za-z0-9+/=\s]{200,}$/;
  if (base64Pattern.test(text.trim()) && !text.includes(' ')) {
    return { valid: false, reason: 'Il testo sembra essere codice base64' };
  }

  // Check minimo di contenuto testuale (almeno 20 caratteri alfanumerici)
  const alphanumericCount = (text.match(/[a-zA-Z0-9]/g) || []).length;
  if (alphanumericCount < 20) {
    return { valid: false, reason: 'Testo troppo corto o senza contenuto alfanumerico significativo' };
  }

  return { valid: true, reason: 'OK' };
}

/**
 * Estrae metadata strutturati dal testo usando LLM con schema flessibile
 * Supporta: persone, dipendenti, immobili, aziende, autovetture, documenti finanziari, legali, etc.
 */
async function extractMetadataWithLLM(text) {
  // Validazione preliminare del testo
  const validation = validateExtractedText(text);
  if (!validation.valid) {
    console.warn(`⚠️ Validazione testo fallita: ${validation.reason}`);
    return {
      ...getDefaultMetadata(),
      confidence: { document_type: 0, overall: 0 },
      content: {
        summary: `⚠️ ${validation.reason}`,
        key_facts: [],
        dates: [],
        locations: [],
      },
      _validation_error: validation.reason,
    };
  }

  const response = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: METADATA_MODEL,
      prompt: `Analizza il seguente testo estratto da un documento ed estrai i metadata in formato JSON strutturato e flessibile.

⚠️ REGOLE CRITICHE - LEGGI ATTENTAMENTE:
1. Se il testo qui sotto NON contiene informazioni leggibili o è vuoto/corrotto, RESTITUISCI SOLO campi con valore null
2. NON INVENTARE mai dati - se un campo non è presente nel testo, usa null
3. Se non riesci a identificare il tipo di documento con certezza, usa "altro" con confidence 0
4. Il confidence score deve riflettere la tua reale certezza - usa 0 se non sei sicuro
5. Se il testo sembra essere un codice base64, un'immagine o contenuto non leggibile, imposta confidence a 0

TESTO DEL DOCUMENTO:
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
- USA SEMPRE NULL (non stringa vuota) per campi NON PRESENTI nel testo - NON INVENTARE
- Se non sei sicuro del tipo di documento, usa "altro" con confidence 0.0-0.3
- Date sempre in formato ISO YYYY-MM-DD - usa null se non trovi date
- Importi sempre come numeri, non stringhe formattate - usa null se non trovi importi
- document_type: identifica il tipo più specifico possibile, ma solo se sei sicuro
- document_category: scegli la categoria generale appropriata
- custom_fields: popola SOLO i campi rilevanti per il tipo di documento - NON riempire campi a caso
- parties: holder=intestatario, issuer=chi emette, counterparty=altra parte
- financial.amounts: array per documenti con più importi (scadenze, rate, etc) - USA ARRAY VUOTO se non ci sono importi
- content.dates: estrai SOLO le date effettivamente presenti nel testo
- content.locations: indirizzi completi, comuni, sedi menzionati - ARRAY VUOTO se non ce ne sono
- confidence: 0.9=sicuro (testo chiaro e completo), 0.7=probabile, 0.5=incerto, 0.0-0.3=non leggibile/inesistente
- Per documenti identità: focus su holder, identification, issuing_authority
- Per documenti finanziari: focus su parties, financial
- Per documenti immobiliari: focus su custom_fields.indirizzo_immobile, catastali
- Per documenti veicoli: focus su custom_fields.targa, telaio, km
- Per documenti assicurativi: focus su custom_fields.numero_polizza, expiry_date
- Per documenti sanitari: focus su holder, content.key_facts, custom_fields.diagnosi
- ⚠️ CRITICO: Se il testo non contiene informazioni utili, restituisci TUTTI i campi come null/[] con confidence 0`,
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
      // Validazione base: assicurati che ci siano i campi obbligatori
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
 * Supporta: persone, dipendenti, immobili, aziende, autovetture, documenti finanziari, legali, etc.
 */
function validateAndNormalizeMetadata(metadata) {
  const defaults = getDefaultMetadata();

  // Se c'è un errore di validazione del testo, usa i defaults con confidence 0
  if (metadata._validation_error) {
    console.warn(`⚠️ Metadata con errore di validazione: ${metadata._validation_error}`);
    return {
      ...defaults,
      confidence: { document_type: 0, overall: 0 },
      content: {
        ...defaults.content,
        summary: `⚠️ ${metadata._validation_error}`,
      },
      doc_amount: null,
      doc_date: null,
      doc_due_date: null,
      doc_sender: null,
      doc_recipient: null,
    };
  }

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

  // Se confidence è molto bassa, forza amounts a vuoto per evitare dati inventati
  const confidenceOverall = metadata.confidence?.overall ?? 0.5;
  if (confidenceOverall < 0.3) {
    amounts = [];
  }

  return {
    document_type: metadata.document_type || defaults.document_type,
    document_category: metadata.document_category || defaults.document_category,
    confidence: {
      document_type: metadata.confidence?.document_type ?? 0.5,
      overall: confidenceOverall,
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

  // Se già in formato ISO, restituisci
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) return dateValue;

  // Prova a parsare date italiane comuni
  const italianMonths = {
    'gennaio': '01', 'febbraio': '02', 'marzo': '03', 'aprile': '04',
    'maggio': '05', 'giugno': '06', 'luglio': '07', 'agosto': '08',
    'settembre': '09', 'ottobre': '10', 'novembre': '11', 'dicembre': '12'
  };

  // Pattern: "15 Febbraio 2025" o "15/02/2025"
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

/**
 * Handler job OCR
 */
async function handleOCRJob(job) {
  console.log(`📄 [${WORKER_ID}] OCR Job: ${job.id}, Document: ${job.data.documentId}`);

  const client = await pool.connect();
  const documentRepo = new DocumentRepository(client);

  try {
    const { documentId, db } = job.data;

    // Recupera documento
    const document = await documentRepo.findById(documentId);
    if (!document) {
      throw new Error(`Documento ${documentId} non trovato`);
    }

    // Aggiorna stato
    await documentRepo.updateProcessingStatus(document.id, 'ocr_in_progress');

    // Download file
    console.log(`📥 Downloading: ${document.storage_path}`);
    const fileBuffer = await downloadFile(document.storage_bucket, document.storage_path);

    // Estrai testo con Docling (PDF nativo) o fallback LLaVA
    const extractedText = await extractTextWithOCR(fileBuffer, document.original_filename);

    if (!extractedText || extractedText.trim().length === 0) {
      throw new Error('Nessun testo estratto');
    }

    console.log(`✅ Estratti ${extractedText.length} caratteri`);

    // Salva testo
    await documentRepo.updateExtractedText(document.id, extractedText);
    await documentRepo.updateProcessingStatus(document.id, 'ocr_completed');

    // Accoda job metadata extraction
    console.log(`📤 Accodamento job metadata per documento ${documentId}...`);
    const metadataJobId = await boss.send('archive-metadata', { documentId, db }, {
      priority: job.data._priority === 'URGENT' ? 100 : 50,
    });
    console.log(`📤 Job metadata accodato: ${metadataJobId}`);

    health.jobsProcessed++;
    console.log(`✅ OCR completato: ${job.id}`);

  } catch (error) {
    health.jobsFailed++;
    const errorDetails = error.stack || error.message || JSON.stringify(error);
    health.errors.push({ time: new Date(), error: errorDetails, job: job.id });
    console.error(`❌ OCR Error: ${error.message}`);

    // Gestione retry con backoff - se ritorna true, non fare più retry
    const shouldStop = await handleDocumentError(documentRepo, job.data.documentId, error, 'OCR');
    if (shouldStop) {
      return; // Non rilanciare errore - job completato (con fallimento)
    }

    // Altrimenti rilancia per retry
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Handler job Metadata Extraction
 */
async function handleMetadataJob(job) {
  console.log(`📊 [${WORKER_ID}] Metadata Job: ${job.id}, Document: ${job.data.documentId}`);

  const client = await pool.connect();
  const documentRepo = new DocumentRepository(client);

  try {
    const { documentId, db } = job.data;

    const document = await documentRepo.findById(documentId);
    if (!document || !document.extracted_text) {
      throw new Error('Documento o testo estratto non trovato');
    }

    await documentRepo.updateProcessingStatus(document.id, 'metadata_extraction');

    // Estrai metadata
    console.log(`📊 Estrazione metadata con ${METADATA_MODEL}...`);
    const metadata = await extractMetadataWithLLM(document.extracted_text);

    console.log('📊 Metadata estratti:', JSON.stringify(metadata, null, 2));

    // Salva metadata nel documento - mappa i nuovi campi dello schema flessibile
    const totalAmount = metadata.financial?.amounts?.find(a => a.type === 'totale')?.value ||
                        metadata.financial?.amounts?.find(a => a.type === 'imponibile')?.value ||
                        metadata.doc_amount || null;

    await documentRepo.update(document.id, {
      extracted_metadata: metadata,
      document_type: metadata.document_type || null,
      doc_date: metadata.identification?.issue_date || metadata.doc_date || null,
      doc_due_date: metadata.identification?.expiry_date || metadata.financial?.payment?.due_date || metadata.doc_due_date || null,
      doc_amount: totalAmount,
      doc_sender: metadata.parties?.issuer?.name || metadata.doc_sender || null,
      doc_recipient: metadata.parties?.holder?.name || metadata.parties?.counterparty?.name || metadata.doc_recipient || null,
      // confidence_score rimosso: il valore è già in extracted_metadata->confidence->overall
    });

    await documentRepo.updateProcessingStatus(document.id, 'metadata_completed');

    // Accoda job cleaning
    console.log(`📤 Accodamento job cleaning per documento ${documentId}...`);
    const cleaningJobId = await boss.send('archive-cleaning', { documentId, db }, {
      priority: job.data._priority === 'URGENT' ? 100 : 50,
    });
    console.log(`📤 Job cleaning accodato: ${cleaningJobId}`);

    health.jobsProcessed++;
    console.log(`✅ Metadata extraction completato: ${job.id}`);

  } catch (error) {
    health.jobsFailed++;
    health.errors.push({ time: new Date(), error: error.message, job: job.id });
    console.error(`❌ Metadata Error: ${error.message}`);
    // Non bloccare il flusso se i metadata falliscono
    try {
      await documentRepo.updateProcessingStatus(job.data.documentId, 'ocr_completed');
      await boss.send('archive-cleaning', { documentId: job.data.documentId, db: job.data.db }, {
        priority: job.data._priority === 'URGENT' ? 100 : 50,
      });
    } catch (e) {
      console.error('Errore recovery metadata:', e);
    }
  } finally {
    client.release();
  }
}

/**
 * Handler job Cleaning
 */
async function handleCleaningJob(job) {
  console.log(`🧹 [${WORKER_ID}] Cleaning Job: ${job.id}, Document: ${job.data.documentId}`);

  const client = await pool.connect();
  const documentRepo = new DocumentRepository(client);

  try {
    const { documentId, db } = job.data;

    const document = await documentRepo.findById(documentId);
    if (!document || !document.extracted_text) {
      throw new Error('Documento o testo estratto non trovato');
    }

    await documentRepo.updateProcessingStatus(document.id, 'cleaning_in_progress');

    // Pulisci testo
    console.log(`🧹 Cleaning testo...`);
    const cleanedText = await cleanTextWithLLM(document.extracted_text);

    await documentRepo.updateCleanedText(document.id, cleanedText);
    await documentRepo.updateProcessingStatus(document.id, 'cleaning_completed');

    // Accoda job embedding
    console.log(`📤 Accodamento job embedding per documento ${documentId}...`);
    const embeddingJobId = await boss.send('archive-embedding', { documentId, db }, {
      priority: job.data._priority === 'URGENT' ? 100 : 50,
    });
    console.log(`📤 Job embedding accodato: ${embeddingJobId}`);

    health.jobsProcessed++;
    console.log(`✅ Cleaning completato: ${job.id}`);

  } catch (error) {
    health.jobsFailed++;
    health.errors.push({ time: new Date(), error: error.message, job: job.id });
    console.error(`❌ Cleaning Error: ${error.message}`);

    // Gestione retry con backoff
    const shouldStop = await handleDocumentError(documentRepo, job.data.documentId, error, 'CLEANING');
    if (shouldStop) {
      return;
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Handler job Embedding
 */
/**
 * Inizializza la collection Qdrant all'avvio del worker.
 * Se la collection non esiste la crea con size=1024 (bge-m3).
 * Se esiste con dimensioni diverse la ricrea e resetta synced_to_qdrant.
 *
 * @returns {{ recreated: boolean }}
 */
async function initQdrantCollection() {
  try {
    const collections = await qdrantClient.getCollections();
    const existing = collections.collections.find(c => c.name === QDRANT_COLLECTION);

    if (existing) {
      const info = await qdrantClient.getCollection(QDRANT_COLLECTION);
      const currentSize = info.config?.params?.vectors?.size;

      if (currentSize === EMBEDDING_SIZE) {
        console.log(`✅ Qdrant collection "${QDRANT_COLLECTION}" OK (size=${EMBEDDING_SIZE})`);
        return { recreated: false };
      }

      console.warn(`⚠️ Qdrant collection "${QDRANT_COLLECTION}" ha size=${currentSize}, atteso ${EMBEDDING_SIZE}. Ricreazione...`);
      await qdrantClient.deleteCollection(QDRANT_COLLECTION);
    }

    await qdrantClient.createCollection(QDRANT_COLLECTION, {
      vectors: {
        size: EMBEDDING_SIZE,
        distance: EMBEDDING_DISTANCE,
      },
      optimizers_config: { default_segment_number: 2 },
      replication_factor: 1,
    });

    console.log(`✅ Qdrant collection "${QDRANT_COLLECTION}" creata (size=${EMBEDDING_SIZE}, distance=${EMBEDDING_DISTANCE})`);

    if (existing) {
      // Collection ricreata: resetta synced_to_qdrant per tutti i chunks esistenti
      const client = await pool.connect();
      try {
        await client.query(`
          UPDATE archive_chunks
          SET synced_to_qdrant = false, qdrant_id = NULL
          WHERE synced_to_qdrant = true
        `);
        console.log('♻️  synced_to_qdrant resettato per tutti i chunks esistenti');
      } finally {
        client.release();
      }
      return { recreated: true };
    }

    return { recreated: false };
  } catch (err) {
    console.error('❌ Errore init Qdrant collection:', err.message);
    // Non blocca l'avvio del worker — la search semantica semplicemente non funzionerà
    return { recreated: false };
  }
}

/**
 * Carica i chunk con i loro embedding su Qdrant in batch da 100.
 * Aggiorna synced_to_qdrant=true e qdrant_id su archive_chunks.
 *
 * @param {string} documentId
 * @param {Array} chunksWithEmbeddings - Array di { id, chunk_order, chunk_text, embedding }
 * @param {Object} meta - { db, folderPath, documentType }
 */
async function upsertChunksToQdrant(documentId, chunksWithEmbeddings, meta) {
  const BATCH_SIZE = 100;

  if (!chunksWithEmbeddings || chunksWithEmbeddings.length === 0) {
    console.warn(`⚠️ Nessun chunk da sincronizzare per doc ${documentId}`);
    return;
  }

  console.log(`📤 Qdrant upsert: ${chunksWithEmbeddings.length} chunks per doc ${documentId}`);

  const client = await pool.connect();
  try {
    for (let i = 0; i < chunksWithEmbeddings.length; i += BATCH_SIZE) {
      const batch = chunksWithEmbeddings.slice(i, i + BATCH_SIZE);

      const points = batch.map(chunk => ({
        id: chunk.id,  // UUID del chunk — Qdrant accetta UUID come ID
        vector: chunk.embedding,
        payload: {
          document_id: documentId,
          chunk_id: chunk.id,
          db: meta.db || null,
          folder_path: meta.folderPath || null,
          document_type: meta.documentType || null,
          chunk_order: chunk.chunk_order,
          text_preview: chunk.chunk_text ? chunk.chunk_text.substring(0, 200) : null,
        },
      }));

      await qdrantClient.upsert(QDRANT_COLLECTION, { wait: true, points });

      // Aggiorna synced_to_qdrant per questo batch
      const batchIds = batch.map(c => c.id);
      await client.query(
        `UPDATE archive_chunks
         SET synced_to_qdrant = true,
             qdrant_id = id,
             updated_at = NOW()
         WHERE id = ANY($1)`,
        [batchIds]
      );

      console.log(`  ✅ Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} punti caricati su Qdrant`);
    }

    console.log(`✅ Qdrant sync completato: ${chunksWithEmbeddings.length} chunks per doc ${documentId}`);
  } finally {
    client.release();
  }
}

async function handleEmbeddingJob(job) {
  console.log(`🔢 [${WORKER_ID}] Embedding Job: ${job.id}, Document: ${job.data.documentId}`);

  const client = await pool.connect();
  const documentRepo = new DocumentRepository(client);
  const chunkRepo = new ChunkRepository(client);

  try {
    const { documentId, db } = job.data;

    const document = await documentRepo.findById(documentId);
    if (!document || !document.cleaned_text) {
      throw new Error('Documento o testo pulito non trovato');
    }

    await documentRepo.updateProcessingStatus(document.id, 'embedding_in_progress');

    // Elimina chunk esistenti (idempotenza per retry)
    await chunkRepo.deleteByDocumentId(documentId);

    // Chunking
    console.log(`✂️  Chunking...`);
    const chunks = chunkText(document.cleaned_text);
    console.log(`📊 Creati ${chunks.length} chunks`);

    // Genera embeddings, salva su Postgres e raccoglie i dati per Qdrant
    const savedChunks = [];
    for (let i = 0; i < chunks.length; i++) {
      const text = chunks[i];
      console.log(`🔢 Embedding chunk ${i + 1}/${chunks.length}...`);

      const embedding = await generateEmbedding(text);

      const saved = await chunkRepo.createChunk({
        document_id: documentId,
        db,
        chunk_index: i,
        chunk_text: text,
        embedding,
        page_start: 1,
        page_end: 1,
      });

      // Mantieni il vettore in memoria per il successivo upsert su Qdrant
      savedChunks.push({
        id: saved.id,
        chunk_order: i,
        chunk_text: text,
        embedding,
      });
    }

    await documentRepo.updateProcessingStatus(document.id, 'completed');

    // Carica i chunk su Qdrant passando direttamente i vettori (non rilegge da Postgres)
    await upsertChunksToQdrant(documentId, savedChunks, {
      db,
      folderPath: document.folder_path || null,
      documentType: document.document_type || null,
    });

    health.jobsProcessed++;
    console.log(`✅ Pipeline completata! Documento ${documentId} elaborato con successo.`);
    console.log(`✅ Embedding completato: ${job.id}`);

  } catch (error) {
    health.jobsFailed++;
    health.errors.push({ time: new Date(), error: error.message, job: job.id });
    console.error(`❌ Embedding Error: ${error.message}`);

    // Gestione retry con backoff
    const shouldStop = await handleDocumentError(documentRepo, job.data.documentId, error, 'EMBEDDING');
    if (shouldStop) {
      return;
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Health check endpoint
 */
async function healthCheck() {
  const now = Date.now();
  const inactiveTime = now - health.lastActivity;

  // Considera unhealthy se inattivo per più di 5 minuti
  if (inactiveTime > 5 * 60 * 1000 && health.status === 'running') {
    health.status = 'stalled';
  }

  return {
    workerId: WORKER_ID,
    workerType: WORKER_TYPE,
    status: health.status,
    uptime: process.uptime(),
    jobsProcessed: health.jobsProcessed,
    jobsFailed: health.jobsFailed,
    lastActivity: new Date(health.lastActivity).toISOString(),
    inactiveSeconds: Math.floor(inactiveTime / 1000),
    memory: process.memoryUsage(),
    recentErrors: health.errors.slice(-5),
  };
}

/**
 * Avvia il worker
 */
async function startWorker() {
  console.log(`🚀 [${WORKER_ID}] Avvio Archive Worker (type: ${WORKER_TYPE})`);

  // Verifica connessione Ollama con retry
  const maxRetries = 5;
  const retryDelay = 5000; // 5 secondi
  let ollamaConnected = false;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(`${OLLAMA_URL}/api/tags`, { timeout: 5000 });
      if (response.ok) {
        const data = await response.json();
        console.log('✅ Connessione Ollama verificata');
        console.log(`📋 Modelli disponibili: ${data.models?.length || 0}`);
        ollamaConnected = true;
        break;
      }
    } catch (error) {
      console.warn(`⚠️ Tentativo ${i + 1}/${maxRetries} - Ollama non raggiungibile: ${error.message}`);
      if (i < maxRetries - 1) {
        console.log(`⏳ Retry in ${retryDelay / 1000}s...`);
        await new Promise(r => setTimeout(r, retryDelay));
      }
    }
  }

  if (!ollamaConnected) {
    console.error('❌ CRITICAL: Ollama non raggiungibile dopo tutti i tentativi');
    console.error(`   URL: ${OLLAMA_URL}`);
    console.error('   Verifica che Ollama sia avviato sull\'host con:');
    console.error('   ollama serve');
    process.exit(1);
  }

  // Verifica Docling (se abilitato)
  if (USE_DOCLING_OCR) {
    try {
      const doclingResponse = await fetch(`${DOCLING_URL}/health`, { timeout: 5000 });
      if (doclingResponse.ok) {
        console.log('✅ Connessione Docling verificata');
      } else {
        console.warn('⚠️ Docling non risponde correttamente (status:', doclingResponse.status, ')');
      }
    } catch (error) {
      console.warn('⚠️ Docling non raggiungibile:', error.message);
      console.log('   I job OCR falliranno se Docling non è disponibile');
    }
  }

  // Avvia pg-boss
  await boss.start();
  console.log('✅ pg-boss connesso');

  // Inizializza Qdrant collection (crea se non esiste, ricrea se dimensioni errate)
  const { recreated } = await initQdrantCollection();
  if (recreated) {
    console.log('♻️  Qdrant collection ricreata — i documenti esistenti verranno ri-embeddati');
    // Re-schedule embedding per documenti completati con chunks non sincronizzati
    const client = await pool.connect();
    try {
      const { rows: docsToReEmbed } = await client.query(`
        SELECT DISTINCT d.id, d.db
        FROM archive_documents d
        JOIN archive_chunks c ON c.document_id = d.id
        WHERE d.processing_status = 'completed'
          AND c.synced_to_qdrant = false
        ORDER BY d.created_at DESC
      `);
      console.log(`♻️  ${docsToReEmbed.length} documenti da ri-embeddare`);
      for (const doc of docsToReEmbed) {
        await boss.send('archive-embedding', { documentId: doc.id, db: doc.db, reEmbedding: true }, {
          priority: -1,
          singletonKey: `re-embed-${doc.id}`,
        });
      }
    } finally {
      client.release();
    }
  }

  // Crea le code necessarie per inviare job
  await boss.createQueue('archive-ocr');
  await boss.createQueue('archive-metadata');
  await boss.createQueue('archive-cleaning');
  await boss.createQueue('archive-embedding');
  console.log('✅ Code create');

  // Registra handlers in base al tipo di worker
  const workerTypes = WORKER_TYPE === 'all' ? ['ocr', 'metadata', 'cleaning', 'embedding'] : [WORKER_TYPE];

  if (workerTypes.includes('ocr')) {
    await boss.work('archive-ocr', { batchSize: 1, pollingInterval: 2000 }, async (jobs) => {
      health.lastActivity = Date.now();
      for (const job of jobs) {
        await handleOCRJob(job);
      }
    });
    console.log('✅ Handler OCR registrato');
  }

  if (workerTypes.includes('metadata')) {
    await boss.work('archive-metadata', { batchSize: 1, pollingInterval: 2000 }, async (jobs) => {
      health.lastActivity = Date.now();
      for (const job of jobs) {
        await handleMetadataJob(job);
      }
    });
    console.log('✅ Handler Metadata registrato');
  }

  if (workerTypes.includes('cleaning')) {
    await boss.work('archive-cleaning', { batchSize: 1, pollingInterval: 2000 }, async (jobs) => {
      health.lastActivity = Date.now();
      for (const job of jobs) {
        await handleCleaningJob(job);
      }
    });
    console.log('✅ Handler Cleaning registrato');
  }

  if (workerTypes.includes('embedding')) {
    await boss.work('archive-embedding', { batchSize: 1, pollingInterval: 2000 }, async (jobs) => {
      health.lastActivity = Date.now();
      for (const job of jobs) {
        await handleEmbeddingJob(job);
      }
    });
    console.log('✅ Handler Embedding registrato');
  }

  health.status = 'running';
  console.log(`✅ [${WORKER_ID}] Worker attivo e in ascolto`);

  // Health check periodico
  setInterval(async () => {
    const status = await healthCheck();
    console.log(`💚 Health Check: ${status.status}, Jobs: ${status.jobsProcessed}/${status.jobsFailed}`);
  }, 60000);
}

/**
 * Graceful shutdown
 */
async function shutdown(signal) {
  console.log(`\n🛑 [${WORKER_ID}] Ricevuto ${signal}, shutdown graceful...`);
  health.status = 'stopping';

  // Stop pg-boss (aspetta che i job in corso finiscano)
  await boss.stop({ graceful: true, timeout: 30000 });
  console.log('✅ pg-boss fermato');

  // Chiudi pool PostgreSQL
  await pool.end();
  console.log('✅ Pool PostgreSQL chiuso');

  console.log(`👋 [${WORKER_ID}] Arrivederci`);
  process.exit(0);
}

// Gestione segnali
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Gestione errori non catturati
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  health.errors.push({ time: new Date(), error: error.message });
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection:', reason);
  health.errors.push({ time: new Date(), error: String(reason) });
});

// Avvia
startWorker().catch((error) => {
  console.error('❌ Errore fatale:', error);
  process.exit(1);
});
