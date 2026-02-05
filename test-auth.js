// Script per testare il sistema di autenticazione
import Fastify from 'fastify';
import fastifyPostgres from '@fastify/postgres';
import dotenv from 'dotenv';
import { AuthRoutes } from './routes/index.js';

dotenv.config();

const fastify = Fastify({ logger: true });

fastify.register(fastifyPostgres, {
  promise: true,
  connectionString: process.env.POSTGRES_URL,
});

fastify.register(AuthRoutes, { prefix: '/v1/auth' });

async function testAuth() {
  try {
    await fastify.ready();
    
    console.log('✅ Server configurato correttamente');
    console.log('🔐 JWT_SECRET:', process.env.JWT_SECRET ? 'Configurato' : '❌ MANCANTE');
    console.log('🗄️  POSTGRES_URL:', process.env.POSTGRES_URL ? 'Configurato' : '❌ MANCANTE');
    
    // Test connessione database
    const { rows } = await fastify.pg.query('SELECT COUNT(*) FROM users');
    console.log('👥 Utenti nel database:', rows[0].count);
    
    console.log('\n✅ Tutti i controlli superati!');
    console.log('Puoi testare il login con:');
    console.log('POST http://localhost:9000/v1/auth/login');
    console.log('Body: { "email": "user@example.com", "password": "password" }');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Errore:', error.message);
    process.exit(1);
  }
}

testAuth();
