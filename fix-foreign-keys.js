// Script per aggiungere la foreign key con il tipo corretto

import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

async function updateForeignKeys() {
  const pool = new Pool({
    connectionString: process.env.POSTGRES_URL
  });

  try {
    console.log('🔍 Aggiornamento delle foreign key senza type cast...');
    
    // Elimina i vincoli esistenti se presenti
    try {
      await pool.query(`ALTER TABLE IF EXISTS import_batches DROP CONSTRAINT IF EXISTS fk_import_batch_parent;`);
      await pool.query(`ALTER TABLE IF EXISTS transactions DROP CONSTRAINT IF EXISTS fk_transaction_parent;`);
      console.log('✅ Vincoli esistenti rimossi con successo.');
    } catch (err) {
      console.error('❌ Errore durante la rimozione dei vincoli esistenti:', err.message);
    }
    
    // Aggiungi i vincoli senza type cast
    try {
      await pool.query(`
        ALTER TABLE import_batches
        ADD CONSTRAINT fk_import_batch_parent
        FOREIGN KEY (parent_transaction_id)
        REFERENCES transactions(id)
        ON DELETE SET NULL;
      `);
      console.log('✅ Foreign key aggiunta con successo alla tabella import_batches!');
    } catch (err) {
      console.error('❌ Errore durante l\'aggiunta della foreign key a import_batches:', err.message);
    }
    
    try {
      await pool.query(`
        ALTER TABLE transactions
        ADD CONSTRAINT fk_transaction_parent
        FOREIGN KEY (parent_transaction_id)
        REFERENCES transactions(id)
        ON DELETE SET NULL;
      `);
      console.log('✅ Foreign key aggiunta con successo alla tabella transactions!');
    } catch (err) {
      console.error('❌ Errore durante l\'aggiunta della foreign key a transactions:', err.message);
    }
    
    console.log('🎉 Aggiornamento delle foreign key completato!');
  } catch (error) {
    console.error('❌ Errore durante l\'aggiornamento delle foreign key:', error);
  } finally {
    await pool.end();
  }
}

updateForeignKeys();
