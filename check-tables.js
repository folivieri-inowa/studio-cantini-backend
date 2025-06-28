// Script per verificare quali tabelle esistono nel database
import Fastify from 'fastify';
import fastifyPostgres from '@fastify/postgres';
import dotenv from 'dotenv';

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
async function main() {
  try {
    // Attendi che il plugin postgres sia registrato
    await fastify.ready();
    console.log('✅ Connessione al database stabilita');
    
    // Verifica quali tabelle esistono
    const { rows } = await fastify.pg.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `);
    
    console.log('📊 Tabelle esistenti nel database:');
    rows.forEach(row => {
      console.log(`- ${row.table_name}`);
    });
    
    // Chiudi la connessione e termina il processo
    await fastify.close();
    process.exit(0);
  } catch (error) {
    console.error('❌ Errore:', error);
    
    // Chiudi la connessione e termina il processo con errore
    await fastify.close();
    process.exit(1);
  }
}

// Avvia lo script
main();
