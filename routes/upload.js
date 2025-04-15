import * as Minio from "minio";
import { sanitizeFileName } from '../lib/utils.js';

const upload = async (fastify) => {
  fastify.post('/', async (request, reply) => {
    const data = await request.file()

    const { filename, mimetype, file } = data;

    try {
      const minioClient = new Minio.Client({
        endPoint: 'minio.studiocantini.inowa.it',
        port: 443,
        useSSL: true,
        accessKey: 'minioAdmin',
        secretKey: 'Inowa2024'
      });

      const bucketName = 'file-manager';
      const objectName = 'temp/'+sanitizeFileName(filename);

      // Controllo se il bucket esiste, altrimenti lo creo
      const bucketExists = await minioClient.bucketExists(bucketName);
      if (!bucketExists) {
        await minioClient.makeBucket(bucketName, 'us-east-1');
      }

      // Carico il file su MinIO
      await minioClient.putObject(bucketName, objectName, file, {
        'Content-Type': mimetype
      });

      // Costruisco l'URL del file
      const fileUrl = `https://minio.studiocantini.inowa.it/${bucketName}/${objectName}`;

      // reply.send({ message: 'Immagine caricata con successo.', file: uploadedImage, link: fileLink });
      reply.send({ message: 'Immagine caricata con successo.', url: fileUrl });
    } catch (err) {
      console.log(err)
      reply.code(500).send({ message: 'Errore durante il caricamento dell\'immagine.' });
    }
  });
}

export default upload;
