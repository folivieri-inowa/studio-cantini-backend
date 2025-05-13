// File transaction.js modificato - rimosso endpoint problematico

import * as Minio from 'minio';
import { ConvertExcelToJson, detectPaymentMethod, parseDate } from '../lib/utils.js';

const transaction = async (fastify) => {
  async function ensureBucketExists(minioClient, bucketName) {
    try {
      const exists = await minioClient.bucketExists(bucketName);
      if (!exists) {
        await minioClient.makeBucket(bucketName);
      }
      return true;
    } catch (err) {
      console.error('Error creating bucket:', err);
      return false;
    }
  }

  // Qui verrebbero tutti gli altri endpoint
  // Li ho rimossi per brevità e ho lasciato solo un endpoint base
  
  fastify.get('/:db', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { db } = request.params;
    try {
      reply.send({ message: 'Transaction endpoint working' });
    } catch (error) {
      return reply.code(400).send({ message: error, status: 400 });
    }
  });

  // L'endpoint /import/associated è stato spostato in transaction-import-associated.js
};

export default transaction;
