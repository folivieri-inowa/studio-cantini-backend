import Fastify from 'fastify';
import fastifyPostgres from '@fastify/postgres';
import dotenv from 'dotenv';

dotenv.config();

const fastify = Fastify({ logger: false });

fastify.register(fastifyPostgres, {
  promise: true,
  connectionString: process.env.POSTGRES_URL,
});

async function checkDatabasesTable() {
  try {
    await fastify.ready();
    
    // Verifica se la tabella databases esiste
    const tableExistsQuery = `
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'databases'
      ) as table_exists;
    `;
    
    const { rows } = await fastify.pg.query(tableExistsQuery);
    console.log('📋 Tabella databases esiste:', rows[0].table_exists);
    
    if (rows[0].table_exists) {
      // Mostra i dati
      const dataQuery = 'SELECT * FROM databases ORDER BY db_key';
      const { rows: data } = await fastify.pg.query(dataQuery);
      console.log(`📄 Dati nella tabella (${data.length} righe):`);
      data.forEach(row => {
        console.log(`   - ${row.db_key}: ${row.db_name} (attivo: ${row.is_active})`);
      });
    } else {
      console.log('❌ La tabella databases NON esiste');
    }
    
    await fastify.close();
  } catch (error) {
    console.error('❌ Errore:', error.message);
    await fastify.close();
    process.exit(1);
  }
}

checkDatabasesTable();
