import { createMinioClient, ensureBucketExists, getMinioBaseUrl } from '../lib/minio-config.js';
import { sanitizeFileName } from '../lib/utils.js';

const upload = async (fastify) => {
  fastify.post('/', async (request, reply) => {
    const data = await request.file()

    const { filename, mimetype, file } = data;

    try {
      const minioClient = createMinioClient();

      const bucketName = 'file-manager';
      const objectName = 'temp/'+sanitizeFileName(filename);

      // Controllo se il bucket esiste, altrimenti lo creo
      await ensureBucketExists(minioClient, bucketName);

      // Carico il file su MinIO
      await minioClient.putObject(bucketName, objectName, file, {
        'Content-Type': mimetype
      });

      // Costruisco l'URL del file
      const baseUrl = getMinioBaseUrl();
      const fileUrl = `${baseUrl}/${bucketName}/${objectName}`;

      // reply.send({ message: 'Immagine caricata con successo.', file: uploadedImage, link: fileLink });
      reply.send({ message: 'Immagine caricata con successo.', url: fileUrl });
    } catch (err) {
      console.log(err)
      reply.code(500).send({ message: 'Errore durante il caricamento dell\'immagine.' });
    }
  });
}

export default upload;
