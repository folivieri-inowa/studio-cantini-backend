// Script per eseguire manualmente le migrazioni del database
// Utilizzato nel job Kubernetes per eseguire le migrazioni prima dell'avvio dell'app

import Fastify from 'fastify';
import fastifyPostgres from '@fastify/postgres';
import { runMigrations } from './lib/migrations.js';
import dotenv from 'dotenv';

// Carica le variabili d'ambiente
dotenv.config();

// Inizializza Fastify
const fastify = Fastify({ logger: true });

// Configura la connessione al database
fastify.register(fastifyPostgres, {
  promise: true,
  connectionString: process.env.POSTGRES_URL,
});

// Funzione principale
async function main() {
  try {
    console.log('🔄 Avvio migrazione del database...');
    
    // Attendi che il plugin postgres sia registrato
    await fastify.ready();
    console.log('✅ Connessione al database stabilita');
    
    // Esegui le migrazioni
    await runMigrations(fastify);
    
    console.log('✅ Migrazione del database completata con successo!');
    
    // Chiudi la connessione e termina il processo
    await fastify.close();
    process.exit(0);
  } catch (error) {
    console.error('❌ Errore durante la migrazione:', error);
    
    // Chiudi la connessione e termina il processo con errore
    await fastify.close();
    process.exit(1);
  }
}

// Avvia lo script
main();
