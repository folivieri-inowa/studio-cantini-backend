# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Studio Cantini Backend - A Fastify-based API for an Italian accounting/financial management system with AI-powered document classification and intelligent digital archiving.

## Common Commands

```bash
# Development
npm run dev              # Start dev server with nodemon
npm start                # Start production server

# Database
npm run migrate          # Run database migrations
npm run check-migrations # Check migration status
npm run validate-migrations # Validate migration files

# Archive Workers (Intelligent Document Processing)
npm run worker:ocr       # OCR worker (Ollama LLaVA)
npm run worker:cleaning  # Text cleaning worker
npm run worker:embedding # Embedding generation worker
npm run workers:all      # Run all workers concurrently
npm run reconciliation   # PostgreSQL/Qdrant reconciliation job
```

## Architecture

### Core Stack
- **Framework**: Fastify (ES Modules)
- **Database**: PostgreSQL with custom migration system
- **Auth**: JWT via `@fastify/jwt`
- **File Uploads**: `@fastify/multipart` (max 100MB, 10 files)

### Route Organization
Routes are defined in `index.js` and mounted under `/v1/` prefix:
- `/v1/auth` - Authentication
- `/v1/transaction` - Financial transactions + smart classification
- `/v1/report` - Financial reports
- `/v1/archive` - Intelligent document archive (see modules/archive/)
- `/v1/anomalie` - Anomaly detection
- `/v1/classification` - AI classification pipeline

### AI/ML Components

**Transaction Classification Pipeline** (`lib/classifierService.js`):
4-stage fallback: Rule-based → Exact match → Semantic search → Manual review

**Intelligent Archive Module** (`modules/archive/`):
- OCR Worker: Extracts text using Ollama LLaVA
- Cleaning Worker: Text normalization using LLM
- Embedding Worker: Semantic chunking + Qdrant vector storage
- Hybrid Search: Full-text (PostgreSQL) + semantic (Qdrant) with RRF

### Database Migrations

Custom migration system in `lib/migrations.js`:
- Migration files in `/migrations/` (SQL format, named `YYYYMMDD_NNN_description.sql`)
- Uses `migrations` table to track executed migrations
- Supports consolidated schema for fresh installs
- Auto-runs on server startup

## Environment Variables

Required in `.env`:
```
POSTGRES_URL=postgres://user:pass@localhost/dbname
JWT_SECRET=your_secret
PORT=9000

# For Archive module (see modules/archive/README.md)
MINIO_ENDPOINT=...
MINIO_ACCESS_KEY=...
MINIO_SECRET_KEY=...
OLLAMA_URL=http://localhost:11434
QDRANT_URL=http://localhost:6333
```

## Key Dependencies

- Fastify ecosystem: cors, jwt, multipart, postgres
- AI/ML: @tensorflow/tfjs, @qdrant/js-client-rest
- Queue: pg-boss (for background jobs)
- Storage: minio (S3-compatible)
- File processing: exceljs, xlsx, csv-parse

## Important Notes

- No test framework is currently configured
- No ESLint/Prettier configuration exists
- Server runs migrations automatically on startup
- Workers are separate processes that must be started independently
- Archive module requires external services: PostgreSQL, Qdrant, MinIO, Ollama
