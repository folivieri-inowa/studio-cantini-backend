#!/usr/bin/env node

// Script per verificare e aggiungere direttamente la colonna parent_transaction_id

import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

async function checkAndFixDatabase() {
  const pool = new Pool({
    connectionString: process.env.POSTGRES_URL
  });

  try {
    console.log('🔍 Verificando la struttura delle tabelle...');
    
    // Verifica se le colonne esistono
    const checkImportBatchesQuery = `
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'import_batches' AND column_name = 'parent_transaction_id';
    `;
    
    const checkTransactionsQuery = `
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'transactions' AND column_name = 'parent_transaction_id';
    `;
    
    const importBatchesResult = await pool.query(checkImportBatchesQuery);
    const transactionsResult = await pool.query(checkTransactionsQuery);
    
    console.log('Risultato verifica import_batches:', importBatchesResult.rows);
    console.log('Risultato verifica transactions:', transactionsResult.rows);
    
    // Aggiungi le colonne se non esistono
    if (importBatchesResult.rowCount === 0) {
      console.log('⚠️ Colonna parent_transaction_id mancante nella tabella import_batches. Aggiunta in corso...');
      await pool.query(`ALTER TABLE import_batches ADD COLUMN parent_transaction_id INTEGER;`);
      console.log('✅ Colonna aggiunta con successo!');
    } else {
      console.log('✅ Colonna parent_transaction_id già presente nella tabella import_batches.');
    }
    
    if (transactionsResult.rowCount === 0) {
      console.log('⚠️ Colonna parent_transaction_id mancante nella tabella transactions. Aggiunta in corso...');
      await pool.query(`ALTER TABLE transactions ADD COLUMN parent_transaction_id INTEGER;`);
      console.log('✅ Colonna aggiunta con successo!');
    } else {
      console.log('✅ Colonna parent_transaction_id già presente nella tabella transactions.');
    }
    
    // Verifica la presenza dei constraint di foreign key
    const checkConstraintsQuery = `
      SELECT constraint_name
      FROM information_schema.table_constraints
      WHERE constraint_name IN ('fk_import_batch_parent', 'fk_transaction_parent');
    `;
    
    const constraintsResult = await pool.query(checkConstraintsQuery);
    console.log('Vincoli esistenti:', constraintsResult.rows);
    
    // Aggiungi i constraint se necessario
    if (!constraintsResult.rows.some(row => row.constraint_name === 'fk_import_batch_parent')) {
      console.log('⚠️ Foreign key fk_import_batch_parent mancante. Aggiunta in corso...');
      try {
        await pool.query(`
          ALTER TABLE import_batches
          ADD CONSTRAINT fk_import_batch_parent
          FOREIGN KEY (parent_transaction_id)
          REFERENCES transactions(id)
          ON DELETE CASCADE;
        `);
        console.log('✅ Foreign key aggiunta con successo!');
      } catch (err) {
        console.error('❌ Errore durante l\'aggiunta della foreign key:', err.message);
      }
    }
    
    if (!constraintsResult.rows.some(row => row.constraint_name === 'fk_transaction_parent')) {
      console.log('⚠️ Foreign key fk_transaction_parent mancante. Aggiunta in corso...');
      try {
        await pool.query(`
          ALTER TABLE transactions
          ADD CONSTRAINT fk_transaction_parent
          FOREIGN KEY (parent_transaction_id)
          REFERENCES transactions(id)
          ON DELETE CASCADE;
        `);
        console.log('✅ Foreign key aggiunta con successo!');
      } catch (err) {
        console.error('❌ Errore durante l\'aggiunta della foreign key:', err.message);
      }
    }
    
    console.log('🎉 Verifica e correzione del database completata!');
  } catch (error) {
    console.error('❌ Errore durante la verifica/correzione del database:', error);
  } finally {
    await pool.end();
  }
}

checkAndFixDatabase();
