/**
 * Worker Cleaning - Pulisce e normalizza testo estratto
 * Utilizza Ollama per cleaning intelligente del testo OCR
 */

import dotenv from 'dotenv';
dotenv.config();

import pg from 'pg';
import { DocumentRepository } from '../repositories/document.repository.js';
import { JobRepository } from '../repositories/job.repository.js';
import { PriorityQueueService } from '../services/priority-queue.service.js';

const { Pool } = pg;

// Configurazione
const WORKER_ID = `cleaning-worker-${process.pid}`;
const POLL_INTERVAL = 5000;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const TEXT_MODEL = process.env.OLLAMA_TEXT_MODEL || 'llama3.2:latest';

// Inizializza connessioni
const pool = new Pool({ connectionString: process.env.POSTGRES_URL });
const queueService = new PriorityQueueService(process.env.POSTGRES_URL);

/**
 * Pulisce testo usando Ollama
 */
async function cleanTextWithLLM(rawText) {
  try {
    const prompt = `Sei un assistente specializzato nella pulizia di testo estratto tramite OCR da documenti contabili italiani.

Testo grezzo da pulire:
${rawText}

Il tuo compito è:
1. Correggere errori OCR comuni (es. "0" invece di "O", caratteri malformati)
2. Rimuovere artefatti e rumore (es. caratteri casuali, simboli strani)
3. Normalizzare spaziatura e formattazione
4. Preservare TUTTE le informazioni importanti (numeri, date, importi, nomi, tabelle)
5. Mantenere la struttura originale del documento (paragrafi, intestazioni, tabelle)
6. NON aggiungere informazioni non presenti nel testo originale
7. NON rimuovere dati numerici o finanziari

Restituisci SOLO il testo pulito, senza commenti o spiegazioni.`;

    const response = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: TEXT_MODEL,
        prompt,
        stream: false,
        options: {
          temperature: 0.1, // Bassa temperature per output deterministico
          top_p: 0.9,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.statusText}`);
    }

    const data = await response.json();
    return data.response;
  } catch (error) {
    console.error('Errore cleaning testo con LLM:', error);
    // Fallback: restituisci testo originale se LLM fallisce
    return rawText;
  }
}

/**
 * Cleaning regex-based semplice (fallback)
 */
function basicTextCleaning(text) {
  let cleaned = text;

  // Rimuovi caratteri di controllo
  cleaned = cleaned.replace(/[\x00-\x1F\x7F]/g, '');

  // Normalizza spazi multipli
  cleaned = cleaned.replace(/  +/g, ' ');

  // Normalizza newline multiple
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  // Trim ogni riga
  cleaned = cleaned
    .split('\n')
    .map((line) => line.trim())
    .join('\n');

  return cleaned.trim();
}

/**
 * Estrae metadata dal testo pulito
 */
function extractMetadata(text) {
  const metadata = {};

  // Estrai date (formato italiano)
  const dateRegex = /\b(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})\b/g;
  const dates = [...text.matchAll(dateRegex)].map((m) => m[0]);
  if (dates.length > 0) {
    metadata.dates = dates;
  }

  // Estrai importi (€ o EUR)
  const amountRegex = /(?:€|EUR)\s*(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?)/g;
  const amounts = [...text.matchAll(amountRegex)].map((m) => m[1]);
  if (amounts.length > 0) {
    metadata.amounts = amounts;
  }

  // Estrai partite IVA
  const vatRegex = /\b(?:P\.?IVA|Partita IVA)[:\s]*(\d{11})\b/gi;
  const vatNumbers = [...text.matchAll(vatRegex)].map((m) => m[1]);
  if (vatNumbers.length > 0) {
    metadata.vatNumbers = vatNumbers;
  }

  // Estrai codici fiscali
  const cfRegex = /\b(?:C\.?F\.?|Codice Fiscale)[:\s]*([A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z])\b/gi;
  const fiscalCodes = [...text.matchAll(cfRegex)].map((m) => m[1]);
  if (fiscalCodes.length > 0) {
    metadata.fiscalCodes = fiscalCodes;
  }

  return metadata;
}

/**
 * Processa un singolo job cleaning
 */
async function processCleaningJob(job) {
  const client = await pool.connect();
  const documentRepo = new DocumentRepository(client);
  const jobRepo = new JobRepository(client);

  try {
    console.log(`🧹 [${WORKER_ID}] Processando job cleaning: ${job.id} per documento ${job.documentId}`);

    // Marca job come running
    await jobRepo.markAsRunning(job.id, WORKER_ID);

    // Recupera documento
    const document = await documentRepo.findById(job.documentId);
    if (!document) {
      throw new Error(`Documento ${job.documentId} non trovato`);
    }

    if (!document.extracted_text) {
      throw new Error('Nessun testo estratto da pulire');
    }

    // Aggiorna stato documento
    await documentRepo.updateProcessingStatus(document.id, 'cleaning_in_progress');

    // Cleaning base
    console.log(`🧹 Cleaning base del testo (${document.extracted_text.length} chars)...`);
    let cleanedText = basicTextCleaning(document.extracted_text);

    // Cleaning con LLM (se abilitato e testo non troppo lungo)
    if (process.env.ENABLE_LLM_CLEANING === 'true' && cleanedText.length < 8000) {
      console.log(`🤖 Cleaning avanzato con LLM...`);
      cleanedText = await cleanTextWithLLM(cleanedText);
    }

    // Estrai metadata
    console.log(`📊 Estrazione metadata...`);
    const metadata = extractMetadata(cleanedText);

    console.log(`✅ Testo pulito: ${cleanedText.length} caratteri`);
    console.log(`📊 Metadata estratti:`, Object.keys(metadata));

    // Salva testo pulito e metadata
    await documentRepo.updateExtractedText(
      document.id,
      cleanedText,
      metadata
    );

    // Aggiorna stato documento
    await documentRepo.updateProcessingStatus(document.id, 'cleaning_completed');

    // Marca job come completato
    await jobRepo.markAsCompleted(job.id, {
      originalLength: document.extracted_text.length,
      cleanedLength: cleanedText.length,
      metadataExtracted: Object.keys(metadata),
    });

    // Accoda job di embedding
    await queueService.enqueueJob('embedding', document.id, {
      priority: document.priority,
    });

    console.log(`✅ [${WORKER_ID}] Job cleaning completato: ${job.id}`);
  } catch (error) {
    console.error(`❌ [${WORKER_ID}] Errore processando job ${job.id}:`, error);

    // Marca job come failed
    await jobRepo.markAsFailed(job.id, error.message, error.stack);

    // Aggiorna stato documento
    const document = await documentRepo.findById(job.documentId);
    if (document) {
      await documentRepo.updateProcessingStatus(
        document.id,
        'failed',
        `Cleaning failed: ${error.message}`
      );
    }

    // Retry se possibile
    if (job.retry_count < job.max_retries) {
      console.log(`🔄 Riprova ${job.retry_count + 1}/${job.max_retries} per job ${job.id}`);
      await documentRepo.incrementRetryCount(job.documentId);
      await queueService.enqueueJob('cleaning', job.documentId, {
        priority: document?.priority || 'NORMAL',
      });
    }
  } finally {
    client.release();
  }
}

/**
 * Main worker loop
 */
async function startWorker() {
  console.log(`🚀 [${WORKER_ID}] Cleaning Worker avviato`);
  console.log(`📡 Ollama URL: ${OLLAMA_URL}`);
  console.log(`🤖 Text Model: ${TEXT_MODEL}`);
  console.log(`🧹 LLM Cleaning: ${process.env.ENABLE_LLM_CLEANING === 'true' ? 'ENABLED' : 'DISABLED'}`);

  // Inizializza priority queue
  await queueService.initialize();
  console.log('✅ Priority queue inizializzata');

  // Poll per nuovi job
  while (true) {
    try {
      const jobs = await queueService.getNextJobs('cleaning', 1);

      if (jobs.length > 0) {
        await processCleaningJob(jobs[0]);
      } else {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
      }
    } catch (error) {
      console.error(`❌ [${WORKER_ID}] Errore nel worker loop:`, error);
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
    }
  }
}

// Gestione shutdown graceful
process.on('SIGTERM', async () => {
  console.log(`🛑 [${WORKER_ID}] Ricevuto SIGTERM, shutdown graceful...`);
  await pool.end();
  await queueService.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log(`🛑 [${WORKER_ID}] Ricevuto SIGINT, shutdown graceful...`);
  await pool.end();
  await queueService.close();
  process.exit(0);
});

// Avvia worker
startWorker().catch((error) => {
  console.error('❌ Errore fatale nel worker:', error);
  process.exit(1);
});
