/**
 * Script di Backfill per Classification Feedback
 * 
 * Popola la tabella classification_feedback con tutte le transazioni
 * già classificate nella tabella transactions, permettendo all'analytics
 * AI di vedere tutti i dati storici (7000+ record invece di solo 257).
 * 
 * Utilizzo:
 *   node backfill-classification-feedback.js
 */

import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

// Configurazione database (usa la stessa connection string del backend)
if (!process.env.POSTGRES_URL) {
  console.error('❌ Errore: POSTGRES_URL non configurato nel file .env');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
});

async function backfillClassificationFeedback() {
  const client = await pool.connect();
  
  try {
    console.log('🚀 Avvio backfill classification_feedback...\n');
    
    // 1. Verifica stato iniziale
    console.log('📊 Stato PRIMA del backfill:');
    const statsBefore = await client.query(`
      SELECT 
        (SELECT COUNT(*) FROM transactions WHERE categoryid IS NOT NULL AND subjectid IS NOT NULL) as classified_transactions,
        (SELECT COUNT(*) FROM classification_feedback) as feedback_records,
        (SELECT COUNT(DISTINCT transaction_id) FROM classification_feedback) as unique_feedback_transactions
    `);
    
    console.log(`   Transazioni classificate: ${statsBefore.rows[0].classified_transactions}`);
    console.log(`   Record in feedback: ${statsBefore.rows[0].feedback_records}`);
    console.log(`   Transazioni uniche in feedback: ${statsBefore.rows[0].unique_feedback_transactions}`);
    console.log(`   ⚠️  Mancanti: ${statsBefore.rows[0].classified_transactions - statsBefore.rows[0].unique_feedback_transactions}\n`);
    
    // 2. Esegui il backfill
    console.log('⏳ Inserimento dati storici in classification_feedback...');
    const insertResult = await client.query(`
      INSERT INTO classification_feedback (
        db,
        transaction_id,
        original_description,
        amount,
        transaction_date,
        suggested_category_id,
        suggested_subject_id,
        suggested_detail_id,
        suggestion_confidence,
        suggestion_method,
        corrected_category_id,
        corrected_subject_id,
        corrected_detail_id,
        created_at,
        created_by
      )
      SELECT 
        t.db,
        t.id as transaction_id,
        t.description as original_description,
        t.amount,
        t.date as transaction_date,
        t.categoryid as suggested_category_id,
        t.subjectid as suggested_subject_id,
        t.detailid as suggested_detail_id,
        100 as suggestion_confidence,
        'historical' as suggestion_method,
        t.categoryid as corrected_category_id,
        t.subjectid as corrected_subject_id,
        t.detailid as corrected_detail_id,
        COALESCE(t.updated_at, t.created_at, NOW()) as created_at,
        'migration_backfill' as created_by
      FROM transactions t
      WHERE 
        t.categoryid IS NOT NULL 
        AND t.subjectid IS NOT NULL
        AND t.status = 'completed'
        AND NOT EXISTS (
          SELECT 1 
          FROM classification_feedback cf 
          WHERE cf.transaction_id = t.id
        )
      ORDER BY t.date DESC
    `);
    
    console.log(`✅ Inseriti ${insertResult.rowCount} record storici\n`);
    
    // 3. Verifica stato finale
    console.log('📊 Stato DOPO il backfill:');
    const statsAfter = await client.query(`
      SELECT 
        (SELECT COUNT(*) FROM transactions WHERE categoryid IS NOT NULL AND subjectid IS NOT NULL) as classified_transactions,
        (SELECT COUNT(*) FROM classification_feedback) as feedback_records,
        (SELECT COUNT(DISTINCT transaction_id) FROM classification_feedback) as unique_feedback_transactions
    `);
    
    console.log(`   Transazioni classificate: ${statsAfter.rows[0].classified_transactions}`);
    console.log(`   Record in feedback: ${statsAfter.rows[0].feedback_records}`);
    console.log(`   Transazioni uniche in feedback: ${statsAfter.rows[0].unique_feedback_transactions}`);
    
    const coverage = (statsAfter.rows[0].unique_feedback_transactions / statsAfter.rows[0].classified_transactions * 100).toFixed(2);
    console.log(`   ✅ Copertura: ${coverage}%\n`);
    
    // 4. Verifica duplicati
    console.log('🔍 Verifica duplicati:');
    const duplicates = await client.query(`
      SELECT 
        transaction_id,
        COUNT(*) as count
      FROM classification_feedback
      GROUP BY transaction_id
      HAVING COUNT(*) > 1
    `);
    
    if (duplicates.rows.length === 0) {
      console.log('   ✅ Nessun duplicato trovato\n');
    } else {
      console.log(`   ⚠️  Trovati ${duplicates.rows.length} duplicati!\n`);
    }
    
    // 5. Distribuzione per database
    console.log('📊 Distribuzione per database:');
    const dbDist = await client.query(`
      SELECT 
        db,
        COUNT(*) as feedback_records,
        COUNT(DISTINCT transaction_id) as unique_transactions
      FROM classification_feedback
      GROUP BY db
      ORDER BY db
    `);
    
    dbDist.rows.forEach(row => {
      console.log(`   ${row.db}: ${row.feedback_records} record (${row.unique_transactions} transazioni uniche)`);
    });
    console.log();
    
    // 6. Distribuzione per metodo
    console.log('📊 Distribuzione per metodo:');
    const methodDist = await client.query(`
      SELECT 
        suggestion_method,
        COUNT(*) as count,
        ROUND(AVG(suggestion_confidence), 2) as avg_confidence
      FROM classification_feedback
      GROUP BY suggestion_method
      ORDER BY count DESC
    `);
    
    methodDist.rows.forEach(row => {
      console.log(`   ${row.suggestion_method}: ${row.count} record (confidence media: ${row.avg_confidence}%)`);
    });
    console.log();
    
    console.log('✅ Backfill completato con successo!');
    console.log('💡 Ora lo strumento di analisi AI può vedere tutti i dati storici.');
    
  } catch (error) {
    console.error('❌ Errore durante il backfill:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

// Esegui lo script
backfillClassificationFeedback()
  .then(() => {
    console.log('\n🎉 Script completato!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n💥 Script fallito:', error);
    process.exit(1);
  });
