/**
 * Routes per il modulo Archivio Digitale Intelligente
 * Gestisce upload, ricerca, e gestione documenti
 */

import crypto from 'crypto';
import * as Minio from 'minio';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { DocumentRepository } from '../repositories/document.repository.js';
import { ChunkRepository } from '../repositories/chunk.repository.js';
import { JobRepository } from '../repositories/job.repository.js';
import { DeduplicationService } from '../services/deduplication.service.js';
import { PriorityQueueService } from '../services/priority-queue.service.js';
import { HybridSearchService } from '../services/hybrid-search.service.js';
import { sanitizeFileName } from '../../../lib/utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const archiveRoutes = async (fastify) => {
  // Configurazione storage locale (fallback se MinIO non è disponibile)
  const USE_LOCAL_STORAGE = process.env.USE_LOCAL_STORAGE === 'true' || true; // Default: usa storage locale
  const LOCAL_STORAGE_PATH = path.join(__dirname, '../../../storage/archive');
  
  // Inizializza MinIO client (opzionale se USE_LOCAL_STORAGE è true)
  const minioClient = !USE_LOCAL_STORAGE ? new Minio.Client({
    endPoint: process.env.MINIO_ENDPOINT || 'minio.studiocantini.wavetech.it',
    port: parseInt(process.env.MINIO_PORT) || 443,
    useSSL: process.env.MINIO_USE_SSL !== 'false',
    accessKey: process.env.MINIO_ACCESS_KEY || 'minioAdmin',
    secretKey: process.env.MINIO_SECRET_KEY || 'Inowa2024',
  }) : null;

  const bucketName = process.env.MINIO_ARCHIVE_BUCKET || 'archive';

  let bucketReady = false;
  let bucketInitPromise = null;
  
  // Assicura che la directory locale esista
  if (USE_LOCAL_STORAGE) {
    try {
      await fs.mkdir(LOCAL_STORAGE_PATH, { recursive: true });
      console.log(`📁 Storage locale archivio: ${LOCAL_STORAGE_PATH}`);
    } catch (err) {
      console.error('❌ Errore creazione directory storage:', err);
    }
  }

  const withTimeout = (promise, timeoutMs, message) =>
    Promise.race([
      promise,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);

  const ensureArchiveBucketReady = async () => {
    if (bucketReady) return true;

    if (!bucketInitPromise) {
      bucketInitPromise = (async () => {
        const bucketExists = await withTimeout(
          minioClient.bucketExists(bucketName),
          5000,
          `Timeout verifica bucket MinIO: ${bucketName}`
        );

        if (!bucketExists) {
          await withTimeout(
            minioClient.makeBucket(bucketName, 'us-east-1'),
            5000,
            `Timeout creazione bucket MinIO: ${bucketName}`
          );
        }

        bucketReady = true;
      })().catch((error) => {
        bucketInitPromise = null;
        throw error;
      });
    }

    try {
      await bucketInitPromise;
      return true;
    } catch (error) {
      fastify.log.warn(`Archive storage non disponibile: ${error.message}`);
      return false;
    }
  };

  /**
   * POST /archive/upload
   * Upload di un nuovo documento nell'archivio
   */
  fastify.post('/upload', async (request, reply) => {
    try {
      // Use request.parts() to handle both file and form fields
      const parts = request.parts();
      
      let fileData = null;
      const fields = {};
      
      // Iterate through all parts (fields and file)
      for await (const part of parts) {
        if (part.type === 'file') {
          // This is the file
          fileData = part;
        } else {
          // This is a form field
          fields[part.fieldname] = part.value;
        }
      }
      
      console.log('=== UPLOAD DEBUG ===');
      console.log('File received:', !!fileData);
      console.log('Fields received:', Object.keys(fields));
      console.log('Field values:', fields);
      
      if (!fileData) {
        return reply.code(400).send({ error: 'Nessun file fornito' });
      }

      const { filename, mimetype, file } = fileData;
      const { db, documentType, documentSubtype, title, description, documentDate, fiscalYear, priority, folderPath, folderPathArray, parentFolder } = fields;

      // Debug logging
      console.log('Upload request - parsed fields:', {
        db,
        title,
        folderPath,
        folderPathArray,
        parentFolder,
      });

      // Validazione db
      if (!db) {
        return reply.code(400).send({ error: 'Campo "db" obbligatorio' });
      }

      // Inizializza repositories
      const documentRepo = new DocumentRepository(fastify.pg);
      const jobRepo = new JobRepository(fastify.pg);
      const deduplicationService = new DeduplicationService({ 
        pgPool: fastify.pg,
        logger: fastify.log || console,
      });
      // PriorityQueue service richiede pg-boss che non è installato
      // const queueService = new PriorityQueueService(process.env.POSTGRES_URL);

      // Leggi il contenuto del file e calcola hash
      const chunks = [];
      for await (const chunk of file) {
        chunks.push(chunk);
      }
      const fileBuffer = Buffer.concat(chunks);
      const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
      const fileSize = fileBuffer.length;

      // 1. Controllo deduplicazione esatta
      const existingDoc = await deduplicationService.findExactDuplicate(fileHash, db);
      if (existingDoc) {
        return reply.code(409).send({
          error: 'Documento duplicato',
          message: 'Un documento identico è già presente nell\'archivio',
          existingDocument: {
            id: existingDoc.id,
            filename: existingDoc.original_filename,
            createdAt: existingDoc.created_at,
          },
        });
      }

      // 2. Upload su storage (MinIO o locale)
      const sanitizedFilename = sanitizeFileName(filename);
      const timestamp = Date.now();
      const objectName = `${db}/${timestamp}_${sanitizedFilename}`;
      
      let storagePath;
      let fileUrl;
      
      if (USE_LOCAL_STORAGE) {
        // Salva su filesystem locale
        const fullPath = path.join(LOCAL_STORAGE_PATH, objectName);
        const dirPath = path.dirname(fullPath);
        
        // Crea directory se non esiste
        await fs.mkdir(dirPath, { recursive: true });
        
        // Scrivi il file
        await fs.writeFile(fullPath, fileBuffer);
        
        storagePath = objectName;
        fileUrl = `/api/archive/files/${objectName}`; // URL relativo per accesso via API
        
        console.log(`✅ File salvato localmente: ${fullPath}`);
      } else {
        // Upload su MinIO
        const storageReady = await ensureArchiveBucketReady();
        if (!storageReady) {
          return reply.code(503).send({
            error: 'Storage archivio non disponibile',
            message: 'MinIO non raggiungibile. Riprova più tardi.',
          });
        }

        await minioClient.putObject(bucketName, objectName, fileBuffer, {
          'Content-Type': mimetype,
        });

        storagePath = objectName;
        fileUrl = `https://${minioClient.endPoint}/${bucketName}/${objectName}`;
        
        console.log(`✅ File caricato su MinIO: ${fileUrl}`);
      }

      // Estrai informazioni sulla cartella dal folderPath se fornito
      let folderPathValue = folderPath || '';
      let parsedFolderPathArray = [];
      let parsedParentFolder = null;

      if (folderPathValue) {
        // Rimuovi slash iniziali/finali e dividi
        folderPathValue = folderPathValue.replace(/^\/+|\/+$/g, '');
        if (folderPathValue) {
          parsedFolderPathArray = folderPathValue.split('/');
          parsedParentFolder = parsedFolderPathArray[parsedFolderPathArray.length - 1];
        }
      }

      // Se il frontend invia già folderPathArray come stringa JSON, parsalo
      if (folderPathArray && typeof folderPathArray === 'string') {
        try {
          parsedFolderPathArray = JSON.parse(folderPathArray);
        } catch (e) {
          // Se non è JSON, usa il valore derivato da folderPath
        }
      }
      
      // Se il frontend invia parentFolder, usalo
      if (parentFolder) {
        parsedParentFolder = parentFolder;
      }

      // 3. Crea record documento nel database
      let document;
      try {
        document = await documentRepo.create({
          db,
          originalFilename: filename,
          fileSize,
          mimeType: mimetype,
          fileHash,
          storagePath,
          storageBucket: bucketName,
          folderPath: folderPathValue,
          folderPathArray: parsedFolderPathArray,
          parentFolder: parsedParentFolder,
          documentType: documentType || null,
          documentSubtype: documentSubtype || null,
          title: title || filename, // Usa filename come fallback per title
          description: description || null,
          documentDate: documentDate || null,
          fiscalYear: fiscalYear ? parseInt(fiscalYear) : null,
          priority: priority || 'NORMAL',
          createdBy: request.user?.username, // Assumendo autenticazione JWT
        });
      } catch (dbError) {
        // Gestisci errore di chiave duplicata
        if (dbError.code === '23505' && dbError.constraint === 'archive_documents_file_hash_key') {
          return reply.code(409).send({
            error: 'Documento duplicato',
            message: 'Un documento identico è già presente nell\'archivio (hash duplicato)',
          });
        }
        throw dbError; // Rilancia altri errori
      }

      // 4. Avvia pipeline di processamento tramite priority queue (opzionale)
      // TODO: Implementare quando pg-boss sarà configurato
      // await queueService.enqueue('document-processing', {
      //   documentId: document.id,
      //   priority: document.priority,
      //   metadata: { ... }
      // });

      // 5. Controllo deduplicazione fuzzy in background (opzionale - richiede embeddings)
      // TODO: Abilitare quando Qdrant/Ollama saranno configurati
      // deduplicationService.findFuzzyDuplicates(document.id, {
      //   similarityThreshold: 0.85,
      // }).then(async (fuzzyDuplicates) => {
      //   if (fuzzyDuplicates.length > 0) {
      //     console.log(`⚠️ Trovati ${fuzzyDuplicates.length} possibili duplicati fuzzy`);
      //     await documentRepo.markAsDuplicate(document.id, fuzzyDuplicates[0].id);
      //   }
      // }).catch((err) => {
      //   console.error('Errore controllo duplicati fuzzy:', err);
      // });

      return reply.code(201).send({
        success: true,
        message: 'Documento caricato con successo',
        document: {
          id: document.id,
          filename: document.original_filename,
          fileSize: document.file_size,
          mimeType: document.mime_type,
          documentType: document.document_type,
          priority: document.priority,
          status: document.processing_status,
          url: fileUrl,
          createdAt: document.created_at,
        },
      });
    } catch (error) {
      console.error('Errore upload documento:', error);
      return reply.code(500).send({
        error: 'Errore durante il caricamento del documento',
        message: error.message,
      });
    }
  });

  /**
   * GET /archive/documents
   * Lista documenti con filtri
   */
  fastify.get('/documents', async (request, reply) => {
    try {
      const { db, status, priority, documentType, limit = 50, offset = 0 } = request.query;

      if (!db) {
        return reply.code(400).send({ error: 'Parametro "db" obbligatorio' });
      }

      const documentRepo = new DocumentRepository(fastify.pg);

      const documents = await documentRepo.findByDatabase(db, {
        status,
        priority,
        documentType,
        limit: parseInt(limit),
        offset: parseInt(offset),
      });

      const total = await documentRepo.countByDatabase(db, {
        status,
        documentType,
      });

      return reply.send({
        success: true,
        data: documents,
        pagination: {
          total,
          limit: parseInt(limit),
          offset: parseInt(offset),
        },
      });
    } catch (error) {
      console.error('Errore recupero documenti:', error);
      return reply.code(500).send({
        error: 'Errore durante il recupero dei documenti',
        message: error.message,
      });
    }
  });

  /**
   * GET /archive/documents/:id
   * Dettaglio singolo documento
   */
  fastify.get('/documents/:id', async (request, reply) => {
    try {
      const { id } = request.params;

      const documentRepo = new DocumentRepository(fastify.pg);
      const chunkRepo = new ChunkRepository(fastify.pg);
      const jobRepo = new JobRepository(fastify.pg);

      const document = await documentRepo.findById(id);
      if (!document) {
        return reply.code(404).send({ error: 'Documento non trovato' });
      }

      // Recupera chunks e jobs associati
      const chunks = await chunkRepo.findByDocumentId(id);
      const jobs = await jobRepo.findByDocumentId(id);

      return reply.send({
        success: true,
        document: {
          ...document,
          chunksCount: chunks.length,
          chunks: chunks.slice(0, 5), // Solo primi 5 chunks per preview
          jobs: jobs.slice(0, 10), // Ultimi 10 jobs
        },
      });
    } catch (error) {
      console.error('Errore recupero documento:', error);
      return reply.code(500).send({
        error: 'Errore durante il recupero del documento',
        message: error.message,
      });
    }
  });

  /**
   * POST /archive/search
   * Ricerca ibrida (full-text + semantic)
   */
  fastify.post('/search', async (request, reply) => {
    try {
      const { db, query, filters = {}, limit = 20, offset = 0 } = request.body;

      if (!db || !query) {
        return reply.code(400).send({ error: 'Parametri "db" e "query" obbligatori' });
      }

      const hybridSearchService = new HybridSearchService(
        fastify.pg,
        process.env.QDRANT_URL || 'http://localhost:6333'
      );

      const results = await hybridSearchService.search(db, query, {
        filters,
        limit,
        offset,
        rrfK: 60, // Parametro RRF
      });

      return reply.send({
        success: true,
        query,
        results: results.results,
        metrics: results.metrics,
        pagination: {
          limit,
          offset,
          total: results.results.length,
        },
      });
    } catch (error) {
      console.error('Errore ricerca:', error);
      return reply.code(500).send({
        error: 'Errore durante la ricerca',
        message: error.message,
      });
    }
  });

  /**
   * DELETE /archive/documents/:id
   * Soft delete documento
   */
  fastify.delete('/documents/:id', async (request, reply) => {
    try {
      const { id } = request.params;

      const documentRepo = new DocumentRepository(fastify.pg);
      const document = await documentRepo.findById(id);

      if (!document) {
        return reply.code(404).send({ error: 'Documento non trovato' });
      }

      await documentRepo.softDelete(id, request.user?.username);

      return reply.send({
        success: true,
        message: 'Documento eliminato con successo',
      });
    } catch (error) {
      console.error('Errore eliminazione documento:', error);
      return reply.code(500).send({
        error: 'Errore durante l\'eliminazione del documento',
        message: error.message,
      });
    }
  });

  /**
   * GET /archive/folders
   * Lista cartelle e file in un percorso specifico (Finder-like navigation)
   */
  fastify.get('/folders', async (request, reply) => {
    try {
      const { db, path = '' } = request.query;

      if (!db) {
        return reply.code(400).send({ error: 'Parametro "db" obbligatorio' });
      }

      const client = await fastify.pg.connect();

      try {
        // Ottieni sottocartelle dirette
        const foldersQuery = `
          SELECT * FROM archive_folders
          WHERE db = $1 AND parent_path = $2
          ORDER BY folder_name
        `;
        const foldersResult = await client.query(foldersQuery, [db, path]);

        // Ottieni file nel percorso corrente
        const filesQuery = `
          SELECT 
            id,
            original_filename,
            file_size,
            mime_type,
            storage_path,
            folder_path,
            parent_folder,
            tags,
            document_type,
            document_subtype,
            processing_status,
            created_at,
            updated_at
          FROM archive_documents
          WHERE db = $1 
            AND folder_path = $2
            AND deleted_at IS NULL
          ORDER BY original_filename
        `;
        const filesResult = await client.query(filesQuery, [db, path]);
        
        // Aggiungi URL ai file
        const filesWithUrls = filesResult.rows.map(file => ({
          ...file,
          url: USE_LOCAL_STORAGE 
            ? `/api/archive/files/${file.storage_path}` 
            : `https://${minioClient?.endPoint}/${bucketName}/${file.storage_path}`,
        }));

        return reply.send({
          success: true,
          currentPath: path,
          folders: foldersResult.rows,
          files: filesWithUrls,
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Errore recupero cartelle:', error);
      return reply.code(500).send({
        error: 'Errore durante il recupero delle cartelle',
        message: error.message,
      });
    }
  });

  /**
   * GET /archive/breadcrumb
   * Ottiene il percorso breadcrumb per navigazione
   */
  fastify.get('/breadcrumb', async (request, reply) => {
    try {
      const { path = '' } = request.query;

      if (!path) {
        return reply.send({
          success: true,
          breadcrumb: [{ name: 'Root', path: '' }],
        });
      }

      const parts = path.split('/').filter(Boolean);
      const breadcrumb = [{ name: 'Root', path: '' }];

      let currentPath = '';
      for (const part of parts) {
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        breadcrumb.push({
          name: part,
          path: currentPath,
        });
      }

      return reply.send({
        success: true,
        breadcrumb,
      });
    } catch (error) {
      console.error('Errore generazione breadcrumb:', error);
      return reply.code(500).send({
        error: 'Errore durante la generazione del breadcrumb',
        message: error.message,
      });
    }
  });

  /**
   * GET /archive/stats
   * Statistiche archivio
   */
  fastify.get('/stats', async (request, reply) => {
    try {
      const { db } = request.query;

      if (!db) {
        return reply.code(400).send({ error: 'Parametro "db" obbligatorio' });
      }

      const documentRepo = new DocumentRepository(fastify.pg);
      const jobRepo = new JobRepository(fastify.pg);

      // Conta documenti per stato
      const statusCounts = await Promise.all([
        documentRepo.countByDatabase(db, { status: 'pending' }),
        documentRepo.countByDatabase(db, { status: 'completed' }),
        documentRepo.countByDatabase(db, { status: 'failed' }),
      ]);

      const jobStats = await jobRepo.getJobStats({ fromDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) });

      return reply.send({
        success: true,
        stats: {
          documents: {
            pending: statusCounts[0],
            completed: statusCounts[1],
            failed: statusCounts[2],
            total: statusCounts[0] + statusCounts[1] + statusCounts[2],
          },
          jobs: jobStats,
        },
      });
    } catch (error) {
      console.error('Errore recupero statistiche:', error);
      return reply.code(500).send({
        error: 'Errore durante il recupero delle statistiche',
        message: error.message,
      });
    }
  });
  
  /**
   * GET /archive/files/:db/:timestamp_:filename
   * Serve i file salvati localmente (quando USE_LOCAL_STORAGE = true)
   */
  if (USE_LOCAL_STORAGE) {
    fastify.get('/files/*', async (request, reply) => {
      try {
        const filePath = request.params['*']; // Es: "studio_cantini/123456_file.pdf"
        const fullPath = path.join(LOCAL_STORAGE_PATH, filePath);
        
        // Verifica che il file esista
        try {
          await fs.access(fullPath);
        } catch (err) {
          return reply.code(404).send({
            error: 'File non trovato',
            message: 'Il file richiesto non esiste',
          });
        }
        
        // Determina il mime type dal nome file
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = {
          '.pdf': 'application/pdf',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.png': 'image/png',
          '.gif': 'image/gif',
          '.doc': 'application/msword',
          '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          '.xls': 'application/vnd.ms-excel',
          '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          '.txt': 'text/plain',
          '.zip': 'application/zip',
        };
        
        const mimeType = mimeTypes[ext] || 'application/octet-stream';
        
        // Invia il file
        reply.header('Content-Type', mimeType);
        reply.header('Content-Disposition', `inline; filename="${path.basename(filePath)}"`);
        
        const fileStream = await fs.readFile(fullPath);
        return reply.send(fileStream);
        
      } catch (error) {
        console.error('Errore serving file:', error);
        return reply.code(500).send({
          error: 'Errore durante il recupero del file',
          message: error.message,
        });
      }
    });
  }
};

export default archiveRoutes;
