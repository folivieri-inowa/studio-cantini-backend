#!/usr/bin/env node

// filepath: /Users/francescoolivieri/Desktop/Sviluppo inowa/studio_cantini/backend/reset-and-migrate.js
// Script per resettare il database e applicare solo la migrazione consolidata

import Fastify from 'fastify';
import fastifyPostgres from '@fastify/postgres';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Carica le variabili d'ambiente
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Inizializza Fastify
const fastify = Fastify({ logger: false });

// Configura la connessione al database
fastify.register(fastifyPostgres, {
  promise: true,
  connectionString: process.env.POSTGRES_URL,
});

/**
 * Elimina tutte le tabelle dal database
 */
async function dropAllTables() {
  console.log('🗑️ Eliminazione di tutte le tabelle esistenti...');
  const client = await fastify.pg.connect();

  try {
    // Disattiva temporaneamente il controllo dei vincoli di foreign key
    await client.query('SET session_replication_role = replica');

    // Ottieni l'elenco di tutte le tabelle nel database public
    const { rows } = await client.query(`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public';
    `);

    if (rows.length === 0) {
      console.log('ℹ️ Nessuna tabella da eliminare.');
      return;
    }

    // Elimina tutte le tabelle trovate
    for (const row of rows) {
      const tableName = row.tablename;
      console.log(`🗑️ Eliminazione della tabella: ${tableName}`);
      await client.query(`DROP TABLE IF EXISTS "${tableName}" CASCADE`);
    }

    console.log('✅ Tutte le tabelle sono state eliminate con successo.');
    
    // Riattiva il controllo dei vincoli di foreign key
    await client.query('SET session_replication_role = DEFAULT');
  } catch (error) {
    console.error('❌ Errore durante l\'eliminazione delle tabelle:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Applica la migrazione consolidata
 */
async function applyConsolidatedMigration() {
  console.log('🔄 Applicazione della migrazione consolidata...');
  const client = await fastify.pg.connect();

  try {
    // Leggi il file di migrazione consolidata
    const fs = await import('fs');
    const migrationPath = join(__dirname, 'migrations', '20250700_001_consolidated_schema.sql');
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');

    // Esegui la migrazione in una transazione
    await client.query('BEGIN');
    
    // Esegui lo script SQL
    await client.query(migrationSql);
    
    // Registra la migrazione nella tabella migrations
    await client.query(`
      INSERT INTO migrations (migration_name, executed_at) 
      VALUES ('20250700_001_consolidated_schema.sql', NOW())
      ON CONFLICT (migration_name) DO NOTHING
    `);
    
    await client.query('COMMIT');
    
    console.log('✅ Migrazione consolidata applicata con successo.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Errore durante l\'applicazione della migrazione consolidata:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Verifica lo stato del database dopo la migrazione
 */
async function verifyDatabaseState() {
  console.log('🔍 Verifica dello stato del database...');
  const client = await fastify.pg.connect();

  try {
    // Verifica le tabelle create
    const tableQueries = [
      { name: 'categories', query: 'SELECT COUNT(*) FROM categories' },
      { name: 'owners', query: 'SELECT COUNT(*) FROM owners' },
      { name: 'subjects', query: 'SELECT COUNT(*) FROM subjects' },
      { name: 'details', query: 'SELECT COUNT(*) FROM details' },
      { name: 'transactions', query: 'SELECT COUNT(*) FROM transactions' },
      { name: 'documents', query: 'SELECT COUNT(*) FROM documents' },
      { name: 'import_batches', query: 'SELECT COUNT(*) FROM import_batches' },
      { name: 'users', query: 'SELECT COUNT(*) FROM users' },
      { name: 'migrations', query: 'SELECT COUNT(*) FROM migrations' }
    ];

    console.log('📊 Tabelle create e numero di record:');
    
    for (const table of tableQueries) {
      try {
        const result = await client.query(table.query);
        console.log(`   - ${table.name}: ${result.rows[0].count} record`);
      } catch (err) {
        console.log(`   - ❌ ${table.name}: Errore o tabella non esistente`);
      }
    }

    // Verifica l'utente creato
    try {
      const userResult = await client.query("SELECT email FROM users WHERE email = 'f.olivieri@inowa.it'");
      if (userResult.rows.length > 0) {
        console.log('👤 Utente di test creato correttamente.');
      } else {
        console.log('❌ Utente di test non trovato.');
      }
    } catch (err) {
      console.log('❌ Errore durante la verifica dell\'utente di test:', err.message);
    }

  } catch (error) {
    console.error('❌ Errore durante la verifica del database:', error);
  } finally {
    client.release();
  }
}

/**
 * Funzione principale
 */
async function main() {
  try {
    console.log('🚀 Avvio del processo di reset e migrazione del database...');
    
    // Attendi che il plugin postgres sia registrato
    await fastify.ready();
    console.log('✅ Connessione al database stabilita');
    
    // Chiedi conferma prima di procedere
    const readline = (await import('readline')).createInterface({
      input: process.stdin,
      output: process.stdout
    });

    readline.question('⚠️ ATTENZIONE: Stai per eliminare tutte le tabelle dal database. Sei sicuro di voler procedere? (s/n): ', async (answer) => {
      readline.close();
      
      if (answer.toLowerCase() !== 's') {
        console.log('❌ Operazione annullata.');
        await fastify.close();
        process.exit(0);
        return;
      }
      
      try {
        // Elimina tutte le tabelle
        await dropAllTables();
        
        // Applica la migrazione consolidata
        await applyConsolidatedMigration();
        
        // Verifica lo stato finale del database
        await verifyDatabaseState();
        
        console.log('🎉 Processo completato con successo!');
      } catch (error) {
        console.error('💥 Errore durante il processo:', error);
      } finally {
        await fastify.close();
        process.exit(0);
      }
    });
    
  } catch (error) {
    console.error('❌ Errore iniziale:', error);
    await fastify.close();
    process.exit(1);
  }
}

// Avvia lo script
main().catch(error => {
  console.error('💥 Errore non gestito:', error);
  process.exit(1);
});
