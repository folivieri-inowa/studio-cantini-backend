# Archivio Digitale Intelligente - Backend Module

## Panoramica

Il modulo **Archivio Digitale Intelligente** implementa un sistema completo di gestione documenti con funzionalità avanzate di OCR, ricerca semantica e deduplicazione. Il modulo è completamente integrato con il backend Studio Cantini e utilizza un'architettura multi-agent per il processamento dei documenti.

## Architettura

```
backend/modules/archive/
├── services/           # Servizi core
│   ├── hybrid-search.service.js       # Ricerca ibrida (full-text + semantic)
│   ├── deduplication.service.js       # Deduplicazione esatta e fuzzy
│   ├── priority-queue.service.js      # Coda con priorità (pg-boss)
│   ├── semantic-chunking.service.js   # Chunking semantico documenti
│   └── reconciliation.service.js      # Sync PostgreSQL ↔ Qdrant
├── repositories/       # Data access layer
│   ├── document.repository.js         # CRUD documenti
│   ├── chunk.repository.js            # CRUD chunks
│   └── job.repository.js              # CRUD jobs processamento
├── routes/            # API endpoints
│   └── archive.routes.js              # Routes modulo archivio
├── workers/           # Worker asincroni
│   ├── archive-worker.js              # Worker unificato (OCR/Cleaning/Embedding)
│   ├── ocr.worker.js                  # Estrazione testo (legacy)
│   ├── cleaning.worker.js             # Pulizia testo (legacy)
│   └── embedding.worker.js            # Chunking + embedding (legacy)
└── jobs/              # Scheduled jobs
    └── reconciliation.cron.js         # Reconciliation notturna
```

## Stack Tecnologico

### Database & Storage
- **PostgreSQL**: Metadata documenti, chunks, jobs
- **Qdrant**: Vector store per embedding
- **MinIO**: Object storage per file

### AI & ML
- **Docling (IBM)**: OCR PDF-native con supporto tabelle
  - Container Docker CPU-optimized
  - Tesseract OCR engine con supporto italiano
  - Output Markdown con struttura tabellare
- **Ollama**: Modelli AI locali (fallback/enhancement)
  - `llava:latest`: Vision model per OCR immagini
  - `mistral-nemo:latest`: Text model per estrazione metadata
  - `nomic-embed-text`: Embedding model (768 dim)

### Queue & Workers
- **pg-boss**: Priority queue per job asincroni
- **Node.js Worker Unificato**: Gestisce OCR, Metadata, Cleaning, Embedding in un unico container
- **Docker Compose**: Setup containerizzato completo

## Setup

### 1. Variabili d'Ambiente

Aggiungi al file `backend/.env`:

```bash
# MinIO (usa localhost:9002 per container locale, o endpoint remoto per produzione)
MINIO_ENDPOINT=localhost
MINIO_PORT=9002
MINIO_USE_SSL=false
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin123
MINIO_ARCHIVE_BUCKET=archive

# Ollama (deve girare sull'host)
OLLAMA_URL=http://localhost:11434
OLLAMA_VISION_MODEL=llava:latest
OLLAMA_METADATA_MODEL=mistral-nemo:latest
OLLAMA_EMBEDDING_MODEL=nomic-embed-text
ENABLE_LLM_CLEANING=true

# Docling OCR
DOCLING_URL=http://localhost:5001
USE_DOCLING_OCR=true  # true = usa Docling, false = usa solo LLaVA

# Qdrant
QDRANT_URL=http://localhost:6333
QDRANT_COLLECTION=archive_documents

# Worker Configuration
WORKER_TYPE=all  # all = tutti i tipi, oppure: ocr, metadata, cleaning, embedding
WORKER_ID=local-worker-1

# Reconciliation
RECONCILIATION_DRY_RUN=false
RECONCILIATION_AUTO_REPAIR=true
```

### 2. Installazione Dipendenze

```bash
cd backend
npm install
```

Nuove dipendenze aggiunte:
- `pg-boss` (priority queue)
- `concurrently` (run workers in parallel)

### 3. Migrazioni Database

Esegui le migrazioni per creare le tabelle:

```bash
npm run migrate
```

Tabelle create:
- `archive_documents` - Documenti e metadata
- `archive_chunks` - Chunks semantici con embedding
- `archive_processing_jobs` - Jobs OCR/cleaning/embedding

### 4. Setup Ollama

Installa e avvia Ollama localmente, poi scarica i modelli necessari:

```bash
# Vision model per OCR
ollama pull llava:latest

# Text model per cleaning
ollama pull llama3.2:latest

# Embedding model
ollama pull nomic-embed-text
```

### 5. Setup Infrastruttura Docker (Consigliato)

Il modo più semplice è usare il Docker Compose unificato nella root del progetto:

```bash
cd studio_cantini
docker compose up -d
```

Questo avvia tutti i servizi necessari:
- PostgreSQL (porta 5435)
- MinIO (porta 9002)
- Qdrant (porta 6333)
- Docling OCR (porta 5001)
- Worker unificato (tutti i job types)

Verifica che tutti i servizi siano attivi:
```bash
docker compose ps
curl http://localhost:5001/health  # Docling
curl http://localhost:6333/        # Qdrant
```

**Nota**: Ollama deve girare sull'host (non nel container):
```bash
ollama serve  # Sul tuo Mac
```

### 6. Setup Manuale (Alternativa)

Se preferisci non usare Docker Compose, puoi avviare i servizi singolarmente:

**Docling OCR:**
```bash
cd backend
docker compose -f docker-compose.docling.yml up -d
```

**Qdrant:**

Avvia Qdrant con Docker:

```bash
docker run -p 6333:6333 -p 6334:6334 \
  -v $(pwd)/qdrant_storage:/qdrant/storage:z \
  qdrant/qdrant
```

La collection viene creata automaticamente dal worker embedding al primo avvio.

## Utilizzo

### Avvio Server Backend

```bash
npm run dev
```

Il modulo archivio sarà disponibile su `/v1/archive/*`

### Avvio Workers

**Con Docker (Consigliato):**
Il worker è incluso nel Docker Compose e si avvia automaticamente:
```bash
docker compose up -d worker
```

**In locale (per sviluppo):**
```bash
# Worker unificato (tutti i job types)
npm run worker:all

# Oppure workers singoli:
npm run worker:ocr       # Solo OCR
npm run worker:metadata  # Solo Metadata
npm run worker:cleaning  # Solo Cleaning
npm run worker:embedding # Solo Embedding

# Tutti i workers in parallelo (con currently)
npm run workers:all
```

### Job Reconciliation

Esegui manualmente la reconciliation PostgreSQL ↔ Qdrant:

```bash
npm run reconciliation
```

Per scheduling automatico, aggiungi a crontab:
```bash
# Ogni notte alle 2:00 AM
0 2 * * * cd /path/to/backend && npm run reconciliation
```

## API Endpoints

### POST /v1/archive/upload
Upload nuovo documento nell'archivio.

**Request:**
```bash
curl -X POST http://localhost:3000/v1/archive/upload \
  -H "Content-Type: multipart/form-data" \
  -F "file=@fattura.pdf" \
  -F "db=studio_example" \
  -F "documentType=fattura" \
  -F "priority=HIGH"
```

**Response:**
```json
{
  "success": true,
  "message": "Documento caricato con successo",
  "document": {
    "id": "uuid",
    "filename": "fattura.pdf",
    "status": "pending",
    "priority": "HIGH"
  }
}
```

### GET /v1/archive/documents
Lista documenti con filtri.

**Query Params:**
- `db` (required): Database
- `status`: pending|completed|failed
- `priority`: URGENT|HIGH|NORMAL|LOW|BATCH
- `documentType`: fattura|contratto|bilancio|...
- `limit`: default 50
- `offset`: default 0

### GET /v1/archive/documents/:id
Dettaglio singolo documento.

**Response:**
```json
{
  "success": true,
  "document": {
    "id": "uuid",
    "original_filename": "fattura.pdf",
    "processing_status": "completed",
    "extracted_text": "...",
    "chunksCount": 15,
    "chunks": [...],
    "jobs": [...]
  }
}
```

### POST /v1/archive/search
Ricerca ibrida (full-text + semantic).

**Request:**
```json
{
  "db": "studio_example",
  "query": "fatture fornitore XYZ gennaio 2024",
  "filters": {
    "documentType": "fattura",
    "dateFrom": "2024-01-01",
    "dateTo": "2024-01-31"
  },
  "limit": 20
}
```

**Response:**
```json
{
  "success": true,
  "query": "fatture fornitore XYZ gennaio 2024",
  "results": [
    {
      "document_id": "uuid",
      "filename": "fattura_xyz_01.pdf",
      "rank": 0.95,
      "fulltext_rank": 0.89,
      "semantic_score": 0.92,
      "highlight": "...Fornitore XYZ - Fattura n. 123..."
    }
  ],
  "metrics": {
    "totalResults": 5,
    "fulltextResults": 3,
    "semanticResults": 4
  }
}
```

### DELETE /v1/archive/documents/:id
Soft delete documento.

### GET /v1/archive/stats
Statistiche archivio.

**Query Params:**
- `db` (required): Database

**Response:**
```json
{
  "success": true,
  "stats": {
    "documents": {
      "pending": 5,
      "completed": 142,
      "failed": 2,
      "total": 149
    },
    "jobs": [...]
  }
}
```

## Pipeline Processamento

Quando un documento viene caricato, attraversa una pipeline asincrona:

```
1. UPLOAD
   ├─ Calcolo hash SHA-256
   ├─ Controllo duplicati esatti
   ├─ Upload su MinIO
   ├─ Creazione record PostgreSQL
   └─ Enqueue su priority queue

2. OCR WORKER
   ├─ Download da MinIO
   ├─ Estrazione testo (Docling OCR, fallback LLaVA)
   │  ├─ PDF → Docling (markdown nativo con tabelle)
   │  └─ Immagini → LLaVA (vision model)
   ├─ Salvataggio testo estratto
   └─ Enqueue job metadata extraction

3. METADATA WORKER
   ├─ Estrazione metadata strutturati (LLM)
   │  ├─ Dati documento (numero, data, fornitore)
   │  ├─ Importi e valute
   │  ├─ Partite IVA e codici fiscali
   │  └─ Categorizzazione
   ├─ Validazione formato
   └─ Enqueue job embedding

4. EMBEDDING WORKER
   ├─ Chunking semantico
   ├─ Generazione embedding (Ollama)
   ├─ Salvataggio chunks su PostgreSQL
   ├─ Upload embedding su Qdrant
   └─ Documento completato!
```

## Servizi Core

### Hybrid Search Service
Implementa ricerca ibrida con **Reciprocal Rank Fusion (RRF)**:
- Full-text search su PostgreSQL (ts_rank)
- Semantic search su Qdrant (cosine similarity)
- Fusione risultati con RRF algorithm

### Deduplication Service
- **Esatta**: SHA-256 hash del contenuto
- **Fuzzy**: Similarità embedding (threshold 0.85)

### Priority Queue Service
Gestisce priorità dei job con 5 livelli:
- URGENT (SLA < 5 min)
- HIGH (SLA < 1 ora)
- NORMAL (SLA < 24 ore)
- LOW (SLA < 7 giorni)
- BATCH (best effort)

Include **starvation prevention** per job LOW che aspettano troppo.

### Semantic Chunking Service
Chunking intelligente basato su tipo documento:
- **Fatture**: Separa header da body
- **Tabelle**: Preserva struttura tabellare
- **Generici**: Paragraph-aware splitting

### Reconciliation Service
Verifica e ripara inconsistenze PostgreSQL ↔ Qdrant:
- Health check con metriche
- Drift detection (missing, orphaned, mismatched)
- Auto-repair con dry-run mode

## Monitoring & Troubleshooting

### Verificare Worker Status

```bash
# Check processi worker
ps aux | grep worker

# Logs worker OCR
tail -f logs/ocr-worker.log

# Logs worker cleaning
tail -f logs/cleaning-worker.log

# Logs worker embedding
tail -f logs/embedding-worker.log
```

### Verificare Queue Status

Query PostgreSQL per vedere jobs in coda:

```sql
SELECT job_type, job_status, priority, COUNT(*) 
FROM archive_processing_jobs 
GROUP BY job_type, job_status, priority;
```

### Verificare Qdrant

```bash
# Collection info
curl http://localhost:6333/collections/archive_documents

# Point count
curl http://localhost:6333/collections/archive_documents | jq '.result.points_count'
```

### Common Issues

**1. Worker non processa job**
- Verificare tutti i servizi attivi: `docker compose ps`
- Verificare Docling: `curl http://localhost:5001/health`
- Verificare Ollama sull'host: `curl http://localhost:11434/api/tags`
- Logs worker: `docker compose logs -f worker`

**Docling issues**
- Verificare container: `docker compose ps | grep docling`
- Logs: `docker compose logs docling`
- Riavvio: `docker compose restart docling`

**Ollama non raggiungibile dal worker**
Il worker in Docker deve collegarsi a Ollama sull'host. Verifica:
- Ollama in ascolto su 0.0.0.0: `OLLAMA_HOST=0.0.0.0 ollama serve`
- Variabile `extra_hosts` nel docker-compose.yml configurata correttamente

**2. Qdrant sync issues**
- Eseguire reconciliation: `npm run reconciliation`
- Verificare connessione Qdrant: `curl http://localhost:6333/`

**3. Job stuck in "running"**
- Query per trovare job stuck:
```sql
SELECT * FROM archive_processing_jobs 
WHERE job_status = 'running' 
  AND started_at < NOW() - INTERVAL '30 minutes';
```
- Riavviare worker o resettare job manualmente

## Performance

### Ottimizzazioni Implementate

1. **Batch Insert Chunks**: Salva tutti i chunks di un documento in una singola query
2. **Parallel Embedding Generation**: (opzionale) genera embedding in parallelo
3. **Qdrant Batch Upsert**: Upload embedding in batch
4. **PostgreSQL Indexes**: Indexes ottimizzati per query frequenti
5. **Connection Pooling**: Pool PostgreSQL per worker

### Scalabilità

**Worker Scaling:**
```bash
# Avvia multipli worker OCR
for i in {1..3}; do npm run worker:ocr & done

# Avvia multipli worker embedding
for i in {1..5}; do npm run worker:embedding & done
```

**Qdrant Scaling:**
- Usa replication_factor > 1 per HA
- Considera sharding per collection molto grandi (> 10M points)

## Testing

```bash
# Test upload documento
curl -X POST http://localhost:3000/v1/archive/upload \
  -F "file=@test.pdf" \
  -F "db=test" \
  -F "priority=HIGH"

# Test ricerca
curl -X POST http://localhost:3000/v1/archive/search \
  -H "Content-Type: application/json" \
  -d '{"db":"test","query":"fattura fornitore"}'

# Test reconciliation (dry-run)
RECONCILIATION_DRY_RUN=true npm run reconciliation
```

## Roadmap

- [x] Integrazione Docling OCR (PDF-native)
- [ ] Test di integrazione automatizzati
- [ ] Dashboard monitoring real-time
- [ ] Support per PDF multipagina (chunking per pagina)
- [ ] Classificazione automatica documenti
- [ ] Estrazione entità named (NER) avanzata
- [ ] API per annotazione/correzione manuale

## Riferimenti

- Documentazione completa: `docs/ARCHIVIO_DIGITALE_INTELLIGENTE.md`
- Design system UI: `docs/UI_DESIGN_SYSTEM.md`
- Architettura multi-agent: Sezione 15 documento principale
