import Fastify from 'fastify';
import dotenv from 'dotenv';
import cors from '@fastify/cors'
import fastifyMultipart from '@fastify/multipart';
import fastifyPostgres from '@fastify/postgres';
// Routes
import {
  AuthRoutes,
  DatabaseRoutes,
  CategoryRoutes,
  DetailRoutes,
  FileManagerRoutes,
  // MLAnalysisRoutes,
  OwnerRoutes,
  ReportRoutes,
  // SetupRoutes,
  ScadenziarioRoutes,
  SubjectRoutes,
  TransactionRoutes,
  TransactionImportAssociatedRoutes,
  UploadRoutes,
  AnomalieRoutes,
  // GroupsRoutes, // Disabled - using consultative approach in report.js
} from './routes/index.js';
// Migrazione database
import { runMigrations } from './lib/migrations.js';
// Verifica schema database
import verifyDatabaseSchema from './lib/verifyDatabaseSchema.js';

// Load environment variables from .env file
dotenv.config();

// Require the framework and instantiate it
const fastify = Fastify({ logger: false });

// Health check endpoint
fastify.get('/health', async (request, reply) => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

fastify.register(fastifyPostgres, {
  promise: true, // Usa le promise invece dei callback
  connectionString: process.env.POSTGRES_URL,
})

// CORS
fastify.register(cors, {
  origin: '*',
  methods: ['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
});

// Multipart form data
fastify.register(fastifyMultipart);

// Declare a routes
fastify.register(AuthRoutes, { prefix: '/v1/auth' })
fastify.register(DatabaseRoutes, { prefix: '/v1/databases' })
fastify.register(OwnerRoutes, { prefix: '/v1/owner' })
fastify.register(CategoryRoutes, { prefix: '/v1/category' })
fastify.register(SubjectRoutes, { prefix: '/v1/subject' })
fastify.register(DetailRoutes, { prefix: '/v1/detail' })
fastify.register(TransactionRoutes, { prefix: '/v1/transaction' })
fastify.register(TransactionImportAssociatedRoutes, { prefix: '/v1/transaction' })
fastify.register(ReportRoutes, { prefix: '/v1/report' })
fastify.register(UploadRoutes, { prefix: '/v1/upload' })
fastify.register(FileManagerRoutes, { prefix: '/v1/file-manager' })
fastify.register(ScadenziarioRoutes, { prefix: '/v1/scadenziario' })
fastify.register(AnomalieRoutes, { prefix: '/v1/anomalie' })
// fastify.register(GroupsRoutes, { prefix: '/v1/groups' }) // Disabled - using consultative approach in report.js
// fastify.register(SetupRoutes, { prefix: '/v1/setup' })
// fastify.register(MLAnalysisRoutes, { prefix: '/v1/ml-analysis' })

fastify.get('/', async (request, reply) => {
  reply.send({ message: 'Hello World' });
})

// Middleware di gestione degli errori
fastify.setErrorHandler(function (error, request, reply) {
  fastify.log.error(error); // Logga l'errore
  reply.status(500).send({ error: 'Internal Server Error' });
});

/**
 * Run the server!
*/

const start = async () => {
  try {
    // Attendi che tutti i plugin siano registrati prima di eseguire le migrazioni
    await fastify.ready();
    
    // Esegui le migrazioni del database prima di avviare il server
    console.log('🔄 Esecuzione delle migrazioni del database...');
    await runMigrations(fastify);
    
    // Verifica ed eventualmente correggi lo schema del database
    console.log('🔍 Verifica dello schema del database...');
    await verifyDatabaseSchema(fastify);
    
    // Avvia il server dopo aver completato le migrazioni
    if (process.env.PROD) {
      console.log('Run in production');
      await fastify.listen({ port: process.env.PORT, host: '0.0.0.0' });
    } else {
      console.log('Run in development');
      await fastify.listen({ port: process.env.PORT });
    }
    console.log(`✅ Server listening on ${fastify.server.address().port}`);
  } catch (err) {
    console.error('❌ Errore durante l\'avvio del server:', err);
    process.exit(1);
  }
};

start();