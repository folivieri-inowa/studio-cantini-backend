// Script per verificare lo stato delle migrazioni del database
// Mostra quali migrazioni sono state applicate e quali sono in sospeso

import Fastify from 'fastify';
import fastifyPostgres from '@fastify/postgres';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Carica le variabili d'ambiente
dotenv.config();

// Inizializza Fastify
const fastify = Fastify({ logger: false });

// Configura la connessione al database
fastify.register(fastifyPostgres, {
  promise: true,
  connectionString: process.env.POSTGRES_URL,
});

// Funzione principale
async function checkMigrations() {
  try {
    console.log('🔍 Controllo dello stato delle migrazioni...\n');
    
    // Attendi che il plugin postgres sia registrato
    await fastify.ready();
    console.log('✅ Connessione al database stabilita\n');
    
    // Verifica se esiste la tabella delle migrazioni
    const tableExistsQuery = `
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'migrations'
      ) as table_exists;
    `;
    
    const { rows: tableExists } = await fastify.pg.query(tableExistsQuery);
    
    if (!tableExists[0].table_exists) {
      console.log('❌ La tabella "migrations" non esiste nel database');
      console.log('💡 Questo significa che non sono mai state eseguite migrazioni');
      console.log('🔧 Eseguire "yarn migrate" per applicare tutte le migrazioni\n');
      return;
    }
    
    // Leggi la directory delle migrazioni
    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter(file => file.endsWith('.sql'))
      .sort();
    
    console.log(`📂 Migrazioni disponibili nella directory: ${files.length}\n`);
    
    // Recupera le migrazioni già eseguite
    const { rows } = await fastify.pg.query(`
      SELECT migration_name, executed_at 
      FROM migrations 
      ORDER BY executed_at ASC
    `);
    
    const executedMigrations = new Map(
      rows.map(row => [row.migration_name, row.executed_at])
    );
    
    console.log(`✅ Migrazioni eseguite: ${executedMigrations.size}/${files.length}\n`);
    
    // Mostra stato dettagliato di ogni migrazione
    console.log('📋 Stato dettagliato delle migrazioni:');
    console.log('='.repeat(70));
    
    let pendingCount = 0;
    
    for (const file of files) {
      const isExecuted = executedMigrations.has(file);
      
      if (isExecuted) {
        const executedAt = executedMigrations.get(file);
        const formattedDate = new Date(executedAt).toLocaleString('it-IT');
        console.log(`✅ ${file.padEnd(40)} | Eseguita il ${formattedDate}`);
      } else {
        console.log(`❌ ${file.padEnd(40)} | ⏳ IN SOSPESO`);
        pendingCount++;
      }
    }
    
    console.log('='.repeat(70));
    
    if (pendingCount > 0) {
      console.log(`\n⚠️  ATTENZIONE: ${pendingCount} migrazioni in sospeso!`);
      console.log('🔧 Eseguire "yarn migrate" per applicare le migrazioni mancanti');
      console.log('🔄 Oppure riavviare il server con "yarn dev" per applicarle automaticamente\n');
    } else {
      console.log('\n🎉 Tutte le migrazioni sono aggiornate!\n');
    }
    
    // Mostra informazioni aggiuntive
    console.log('ℹ️  Informazioni aggiuntive:');
    console.log(`   • Database: ${process.env.POSTGRES_URL?.split('@')[1]?.split('/')[1] || 'Non specificato'}`);
    console.log(`   • Prima migrazione: ${rows[0] ? new Date(rows[0].executed_at).toLocaleString('it-IT') : 'N/A'}`);
    console.log(`   • Ultima migrazione: ${rows[rows.length - 1] ? new Date(rows[rows.length - 1].executed_at).toLocaleString('it-IT') : 'N/A'}`);
    
  } catch (error) {
    console.error('❌ Errore durante la verifica delle migrazioni:', error);
    
    if (error.code === 'ECONNREFUSED') {
      console.log('💡 Suggerimento: Verificare che il database PostgreSQL sia in esecuzione');
    } else if (error.code === '42P01') {
      console.log('💡 Suggerimento: Eseguire prima "yarn migrate" per creare le tabelle necessarie');
    }
    
    process.exit(1);
  } finally {
    // Chiudi la connessione
    await fastify.close();
  }
}

// Avvia lo script
checkMigrations().then(() => {
  process.exit(0);
});
