/**
 * Script one-shot: trigger re-embedding per documenti esistenti
 *
 * Da eseguire manualmente dopo il deploy della FASE 1 per popolare
 * Qdrant con i chunk dei documenti già processati.
 *
 * Uso:
 *   cd backend
 *   node scripts/trigger-reembedding.js
 *
 * Il script:
 * 1. Trova tutti i documenti in stato 'completed' con chunks non sincronizzati
 * 2. Schedula un job 'archive-embedding' con priorità bassa per ognuno
 * 3. Usa singletonKey per evitare duplicati se eseguito più volte
 */

import dotenv from 'dotenv';
dotenv.config();

import pg from 'pg';
import PgBoss from 'pg-boss';

const { Pool } = pg;

async function main() {
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) {
    console.error('❌ POSTGRES_URL non definita');
    process.exit(1);
  }

  console.log('🔄 Avvio script trigger-reembedding...');

  const pool = new Pool({ connectionString });
  const boss = new PgBoss({ connectionString, retryLimit: 3, retryBackoff: true });

  try {
    await boss.start();
    console.log('✅ pg-boss connesso');

    // Crea la queue se non esiste
    await boss.createQueue('archive-embedding');

    // Trova documenti completati con chunks non sincronizzati su Qdrant
    const { rows: docs } = await pool.query(`
      SELECT DISTINCT d.id, d.db, d.original_filename
      FROM archive_documents d
      LEFT JOIN archive_chunks c ON c.document_id = d.id
      WHERE d.processing_status = 'completed'
        AND d.deleted_at IS NULL
        AND (
          c.id IS NULL  -- nessun chunk
          OR c.synced_to_qdrant = false  -- chunks non sincronizzati
        )
      ORDER BY d.created_at DESC
    `);

    if (docs.length === 0) {
      console.log('✅ Nessun documento da ri-embeddare (tutti già sincronizzati su Qdrant)');
      return;
    }

    console.log(`📋 ${docs.length} documenti da ri-embeddare:`);
    docs.forEach(d => console.log(`   - ${d.original_filename} (${d.id})`));
    console.log('');

    // Schedula re-embedding per ogni documento
    let scheduled = 0;
    for (const doc of docs) {
      const jobId = await boss.send(
        'archive-embedding',
        { documentId: doc.id, db: doc.db, reEmbedding: true },
        {
          priority: -1,  // Priorità bassa per non bloccare upload nuovi
          retryLimit: 2,
          singletonKey: `re-embed-${doc.id}`,  // Evita duplicati
        }
      );

      if (jobId) {
        scheduled++;
        console.log(`  ✅ Schedulato re-embedding per ${doc.original_filename}`);
      } else {
        console.log(`  ⚠️  Job già esistente per ${doc.original_filename} (singletonKey)`);
      }
    }

    console.log('');
    console.log(`✅ Schedulati ${scheduled}/${docs.length} job di re-embedding`);
    console.log('');
    console.log('📊 Monitora il progresso:');
    console.log('  psql $POSTGRES_URL -c "SELECT COUNT(*) total, SUM(CASE WHEN synced_to_qdrant THEN 1 ELSE 0 END) synced FROM archive_chunks"');
    console.log('  curl http://localhost:6333/collections/archive_document_chunks/points/count');

  } finally {
    await boss.stop();
    await pool.end();
    console.log('');
    console.log('🏁 Script completato');
  }
}

main().catch(err => {
  console.error('❌ Errore:', err);
  process.exit(1);
});
